import { createHash } from 'node:crypto';
import { ApplicationError } from '@nakh/domain';
import type { AccountDeletionLease } from './account-deletion.js';

type MediaWorkScope = Readonly<{
  id: string;
  deletionRecordId: string;
  userId: string;
  assetId: string;
}>;
export type AccountDeletionMediaOperation = MediaWorkScope &
  (
    | Readonly<{ kind: 'retain_photo'; evidenceId: string; sourceSha256: string }>
    | Readonly<{ kind: 'delete_public'; key: string; deliveryPath: string | null }>
    | Readonly<{ kind: 'verify_public_scope' }>
  );

/** Work is prepared and completed under database authority. Provider calls never
 * run while its identity/source transaction is open. An empty claim is not a
 * whole-account completion receipt. */
export interface AccountDeletionMediaStore {
  claimNext(lease: AccountDeletionLease): Promise<AccountDeletionMediaOperation | undefined>;
  assertCurrent(lease: AccountDeletionLease, operationId: string): Promise<void>;
  complete(
    lease: AccountDeletionLease,
    operationId: string,
    observation: Readonly<{ bytes: number | null; sha256: string | null }>,
  ): Promise<void>;
}

export interface AccountDeletionMediaObjects {
  list(prefix: string, limit: number, signal: AbortSignal): Promise<readonly string[]>;
  get(key: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  putPrivate(
    key: string,
    body: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<Readonly<{ bytes: number; sha256: string }>>;
  delete(key: string, signal: AbortSignal): Promise<void>;
  head(
    key: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ bytes: number; sha256: string }> | undefined>;
}
export interface AccountDeletionMediaCache {
  purge(paths: readonly string[]): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const sha = /^[0-9a-f]{64}$/u;
const maximumBytes = 10 * 1024 * 1024;
function conflict(): never {
  throw new ApplicationError('conflict', 'error.deletion.checkpoint_conflict', 409);
}

/** Performs one provider operation, preserving exact private report evidence
 * before public deletion. SQL owns dependencies, source ownership and replay. */
export class ExecuteAccountDeletionMedia {
  public constructor(
    private readonly store: AccountDeletionMediaStore,
    private readonly objects: AccountDeletionMediaObjects,
    private readonly cache: AccountDeletionMediaCache,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
  ) {}

  public async executeNext(lease: AccountDeletionLease): Promise<Readonly<{ worked: boolean }>> {
    if (
      lease.phase !== 'media_objects' ||
      lease.checkpointVersion !== 4 ||
      !uuid.test(lease.userId) ||
      !uuid.test(lease.deletionRecordId) ||
      !uuid.test(lease.leaseOwner) ||
      !Number.isSafeInteger(lease.leaseGeneration) ||
      lease.leaseGeneration < 1
    )
      conflict();
    const operation = await this.store.claimNext(lease);
    if (operation === undefined) return { worked: false };
    if (
      !uuid.test(operation.id) ||
      !uuid.test(operation.assetId) ||
      operation.deletionRecordId !== lease.deletionRecordId ||
      operation.userId !== lease.userId
    )
      conflict();
    await this.store.assertCurrent(lease, operation.id);
    if (operation.kind === 'retain_photo') {
      if (!uuid.test(operation.evidenceId) || !sha.test(operation.sourceSha256)) conflict();
      const destination = `evidence/${this.environment}/${operation.evidenceId}/thumbnail-v1.webp`;
      const existing = await this.objects.head(destination, AbortSignal.timeout(15_000));
      let verified: Readonly<{ bytes: number; sha256: string }>;
      if (existing !== undefined) {
        verified = existing;
      } else {
        const source = await this.objects.get(
          `variants/${this.environment}/${operation.assetId}/thumbnail-v1.webp`,
          AbortSignal.timeout(15_000),
        );
        const hash = createHash('sha256');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        // Verify the bounded source before creating any private object. A corrupt
        // source must not poison the immutable evidence destination on retry.
        for await (const chunk of source) {
          if (!(chunk instanceof Uint8Array)) conflict();
          bytes += chunk.byteLength;
          if (bytes > maximumBytes) conflict();
          hash.update(chunk);
          chunks.push(chunk);
        }
        if (bytes < 1 || hash.digest('hex') !== operation.sourceSha256) conflict();
        const body = (async function* () {
          yield await Promise.resolve(Buffer.concat(chunks, bytes));
        })();
        try {
          const written = await this.objects.putPrivate(
            destination,
            body,
            AbortSignal.timeout(15_000),
          );
          if (written.bytes !== bytes || written.sha256 !== operation.sourceSha256) conflict();
        } finally {
          await body.return();
        }
        const observed = await this.objects.head(destination, AbortSignal.timeout(15_000));
        if (observed === undefined) conflict();
        verified = observed;
      }
      if (
        !Number.isSafeInteger(verified.bytes) ||
        verified.bytes < 1 ||
        verified.bytes > maximumBytes ||
        verified.sha256 !== operation.sourceSha256
      )
        conflict();
      await this.store.assertCurrent(lease, operation.id);
      await this.store.complete(lease, operation.id, verified);
    } else if (operation.kind === 'verify_public_scope') {
      // A recorded-key manifest alone cannot prove absence of abandoned uploads
      // or unrecorded variants. Repeated bounded calls drain the actual namespace.
      const suffix = `${this.environment}/${operation.assetId}/`;
      for (const group of ['quarantine', 'validated', 'variants'] as const) {
        const keys = await this.objects.list(
          `${group}/${suffix}`,
          100,
          AbortSignal.timeout(15_000),
        );
        if (keys.length > 100) conflict();
        if (keys.length > 0) {
          const key = keys[0]!;
          const valid =
            group === 'variants'
              ? new RegExp(
                  `^variants/${suffix}(?:thumbnail|blurred-preview)-v[1-9][0-9]*\\.webp$`,
                  'u',
                ).test(key)
              : key === `${group}/${suffix}original`;
          if (!valid) conflict();
          await this.store.assertCurrent(lease, operation.id);
          await this.objects.delete(key, AbortSignal.timeout(15_000));
          if ((await this.objects.head(key, AbortSignal.timeout(15_000))) !== undefined) conflict();
          if (group === 'variants')
            await this.cache.purge([`/media/${operation.assetId}/${key.split('/').at(-1)}`]);
          return { worked: true };
        }
      }
      await this.store.assertCurrent(lease, operation.id);
      await this.store.complete(lease, operation.id, { bytes: null, sha256: null });
    } else {
      const suffix = `${this.environment}/${operation.assetId}`;
      const variant = new RegExp(
        `^variants/${suffix}/(?:thumbnail|blurred-preview)-v[1-9][0-9]*\\.webp$`,
        'u',
      );
      if (
        operation.key !== `quarantine/${suffix}/original` &&
        operation.key !== `validated/${suffix}/original` &&
        !variant.test(operation.key)
      )
        conflict();
      const expectedPath = variant.test(operation.key)
        ? `/media/${operation.assetId}/${operation.key.split('/').at(-1)}`
        : null;
      if (operation.deliveryPath !== expectedPath) conflict();
      await this.objects.delete(operation.key, AbortSignal.timeout(15_000));
      if ((await this.objects.head(operation.key, AbortSignal.timeout(15_000))) !== undefined)
        conflict();
      if (operation.deliveryPath !== null) await this.cache.purge([operation.deliveryPath]);
      await this.store.assertCurrent(lease, operation.id);
      await this.store.complete(lease, operation.id, { bytes: null, sha256: null });
    }
    return { worked: true };
  }
}
