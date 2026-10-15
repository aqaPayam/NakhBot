import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExecuteAccountDeletionMedia,
  ExecuteAccountDeletionEphemeral,
  RunAccountDeletionBatchHandler,
  type AccountDeletionMediaObjects,
  type AccountControlActor,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import {
  createAccountReturnFixture,
  approveAccountReturnFixture,
} from './testing/account-return-fixture.js';
import { PostgresAccountDeletionMediaStore } from './account-deletion-media-store.js';
import { PostgresAccountDeletionSessionStore } from './account-deletion-session-store.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionPhaseExecutor } from './account-deletion-phase-executor.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresAccountReturnActivationAuthority } from './account-return-activation-store.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { PostgresAccountControlSessionStore } from './account-control-session-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 native Return activation authority', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    fixture: Awaited<ReturnType<typeof createAccountReturnFixture>>,
    authority: PostgresAccountReturnActivationAuthority;
  const namespaceHash = createHash('sha256')
    .update('m8-ephemeral-v1\0m8-native-final')
    .digest('hex');
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_return_activation');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    fixture = await createAccountReturnFixture(database);
    const id = randomUUID();
    await new PostgresAccountReturnStore(database, fixture.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: fixture.userId },
      requestId: randomUUID(),
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: fixture.version },
    });
    authority = new PostgresAccountReturnActivationAuthority(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  const life = (): { userId: string; productEpoch: number } => ({
    userId: fixture.userId,
    productEpoch: 1,
  });
  it('derives a frozen owner-bound proof from the actual Return and exact verified namespace', async () => {
    let calls = 0;
    await authority.withCurrentReturn(life(), namespaceHash, async (proof) => {
      calls++;
      expect(Object.isFrozen(proof)).toBe(true);
      expect(proof).toMatchObject({ ...life(), previousProductEpoch: 0 });
      expect(
        (
          await sql`SELECT identity.account_return_proof_valid(a,true) AS valid FROM platform.audit_logs a WHERE id=${proof.returnAuditId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ valid: true }]);
    });
    expect(calls).toBe(1);
  });
  it('serializes twenty retries without changing any Return proof or account fact', async () => {
    const before = (
      await sql`SELECT to_jsonb(a) AS account FROM identity.accounts a WHERE user_id=${fixture.userId}::uuid`.execute(
        database,
      )
    ).rows;
    let calls = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        authority.withCurrentReturn(life(), namespaceHash, () => {
          calls++;
          return Promise.resolve();
        }),
      ),
    );
    expect(calls).toBe(20);
    expect(
      (
        await sql`SELECT to_jsonb(a) AS account FROM identity.accounts a WHERE user_id=${fixture.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE event_type='account.returned.v1' AND subject_id=${fixture.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('rejects foreign, stale, initial, unknown and malformed namespace/life inputs before the provider', async () => {
    let calls = 0;
    const effect = (): Promise<void> => {
      calls++;
      return Promise.resolve();
    };
    for (const [candidate, hash] of [
      [{ userId: randomUUID(), productEpoch: 1 }, namespaceHash],
      [{ ...life(), productEpoch: 0 }, namespaceHash],
      [{ ...life(), productEpoch: 2 }, namespaceHash],
      [life(), 'f'.repeat(64)],
      [life(), 'invalid'],
    ] as const)
      await expect(authority.withCurrentReturn(candidate, hash, effect)).rejects.toMatchObject({
        code: 'conflict',
      });
    expect(calls).toBe(0);
  });
  it('releases locks after provider failure and permits unchanged recovery without inventing completion', async () => {
    await expect(
      authority.withCurrentReturn(life(), namespaceHash, () =>
        Promise.reject(new Error('synthetic provider outage')),
      ),
    ).rejects.toThrow('synthetic provider outage');
    await expect(
      authority.withCurrentReturn(life(), namespaceHash, () => Promise.resolve()),
    ).resolves.toBeUndefined();
    expect(
      (
        await sql`SELECT identity.account_return_completed(${fixture.recordId}::uuid) AS valid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
  });
  it('holds the original Account through activation, then denies it after a real subsequent tombstone', async () => {
    const grant = await new PostgresAccountControlSessionStore(database).issue(
      life(),
      randomUUID(),
    );
    const control: AccountControlActor = {
      kind: 'user',
      scope: 'account_control',
      ...life(),
      controlGrantId: grant!.id,
    };
    const deletion = new PostgresAccountDeletionStore(
      database,
      { activeKeyId: 'activation-test', keys: new Map([['activation-test', Buffer.alloc(32, 7)]]) },
      control,
    );
    const prepared = await deletion.prepare({
      actor: { kind: 'user', userId: fixture.userId },
      requestId: randomUUID(),
      expectedAccountVersion: fixture.version + 1,
    });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        entered = r;
      });
    const activating = authority.withCurrentReturn(life(), namespaceHash, async () => {
      entered();
      await gate;
    });
    await ready;
    const id = randomUUID();
    const deleting = deletion.request({
      commandId: id,
      commandType: 'account.delete',
      schemaVersion: 1,
      actor: { kind: 'user', userId: fixture.userId },
      requestId: randomUUID(),
      idempotencyKey: id,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        expectedAccountVersion: prepared.expectedAccountVersion,
        confirmationToken: prepared.confirmationToken,
      },
    });
    try {
      let blocked = false;
      for (let n = 0; n < 100; n++) {
        blocked = (
          await sql<{
            blocked: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0) AS blocked`.execute(
            database,
          )
        ).rows[0]!.blocked;
        if (blocked) break;
        await sql`SELECT pg_sleep(0.01)`.execute(database);
      }
      expect(blocked).toBe(true);
      expect(
        (
          await sql`SELECT state,product_epoch FROM identity.accounts WHERE user_id=${fixture.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ state: 'guest', product_epoch: 1 }]);
    } finally {
      release();
      await activating;
      await deleting;
    }
    let calls = 0;
    await expect(
      authority.withCurrentReturn(life(), namespaceHash, () => {
        calls++;
        return Promise.resolve();
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(calls).toBe(0);
    expect(
      (
        await sql`SELECT identity.account_return_completed(${fixture.recordId}::uuid) AS valid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ valid: true }]);
    // Exercise the next complete native lifecycle too. Provider observations in
    // this PostgreSQL-only suite remain synthetic; the worker suite uses Redis.
    const unexpected = (): Promise<never> =>
      Promise.reject(new Error('Unexpected empty-fixture media call'));
    const objects: AccountDeletionMediaObjects = {
      list: unexpected,
      get: unexpected,
      putPrivate: unexpected,
      delete: unexpected,
      head: unexpected,
    };
    const ephemeral = new PostgresAccountDeletionEphemeralStore(
      database,
      'm8-native-final',
      'a'.repeat(64),
    );
    const handler = new RunAccountDeletionBatchHandler(
      new PostgresAccountDeletionWorkStore(database),
      new PostgresAccountDeletionPhaseExecutor(
        database,
        {},
        new ExecuteAccountDeletionMedia(
          new PostgresAccountDeletionMediaStore(database, 'test'),
          objects,
          { purge: unexpected },
          'test',
        ),
        new ExecuteAccountDeletionEphemeral(
          ephemeral,
          new PostgresAccountDeletionSessionStore(database),
          {
            namespaceHash: ephemeral.namespaceHash,
            execute: async (op, guard) => {
              await guard();
              return {
                cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
                more: false,
                found: 0,
              };
            },
          },
        ),
        'test',
      ),
      randomUUID(),
    );
    let outcome = '';
    try {
      for (let n = 0; n < 100; n++) {
        const result = await handler.execute();
        expect(['progress', 'advanced', 'completed']).toContain(result.outcome);
        outcome = result.outcome;
        if (outcome === 'completed') break;
      }
    } finally {
      await handler.close();
    }
    expect(outcome).toBe('completed');
    const root = (
      await sql<{
        id: string;
        account_version: number;
      }>`SELECT id,account_version FROM identity.account_deletion_records WHERE user_id=${fixture.userId}::uuid AND product_epoch=1`.execute(
        database,
      )
    ).rows[0]!;
    await approveAccountReturnFixture(database, {
      recordId: root.id,
      version: root.account_version,
    });
    const returnId = randomUUID();
    await new PostgresAccountReturnStore(database, control).return({
      commandId: returnId,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: fixture.userId },
      requestId: randomUUID(),
      idempotencyKey: returnId,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: root.account_version },
    });
    await authority.withCurrentReturn(
      { userId: fixture.userId, productEpoch: 2 },
      namespaceHash,
      (proof) => {
        expect(proof.previousProductEpoch).toBe(1);
        return Promise.resolve();
      },
    );
    expect(
      (
        await sql`SELECT identity.account_return_completed(${fixture.recordId}::uuid) AS original,billing.deletion_credit_cutover_valid(${fixture.recordId}::uuid) AS financial`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ original: true, financial: true }]);
  });
});
