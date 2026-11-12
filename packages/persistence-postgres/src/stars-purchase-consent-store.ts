import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type {
  StarsPurchaseConsent,
  StarsPurchaseConsentStore,
  StarsPurchaseConsentWrite,
  StarsPurchaseOffer,
  UserSessionActor,
} from '@nakh/application';
import {
  ApplicationError,
  NAKH_STARS_COST,
  PROVIDER_ATTEMPT_LIMIT,
  PROVIDER_ATTEMPT_WINDOW_MS,
} from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { requireCurrentUserSession } from './user-session-store.js';

const EVENT = 'billing.stars-purchase-consent.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
function denied(): never {
  throw new ApplicationError('capability_denied', 'error.billing.payment_unavailable', 403);
}
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function consentId(value: unknown): string {
  const b = Buffer.from(digest(value), 'hex').subarray(0, 16);
  b[6] = (b[6]! & 15) | 0x50;
  b[8] = (b[8]! & 63) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Append-only consent uses the existing native audit registry. No prose,
 * Telegram identifiers, bearer values or provider receipts belong in this fact.
 * It authorizes invoice presentation only, never fulfillment or a refund. */
export class PostgresStarsPurchaseConsentStore implements StarsPurchaseConsentStore {
  public readonly owner: UserSessionActor;
  public constructor(
    private readonly database: NakhDatabase,
    owner: UserSessionActor,
  ) {
    this.owner = Object.freeze({ ...owner });
    if (
      owner.kind !== 'user' ||
      !UUID.test(owner.userId) ||
      !UUID.test(owner.sessionGrantId) ||
      !Number.isSafeInteger(owner.productEpoch) ||
      owner.productEpoch < 0
    )
      denied();
  }
  private async locked<T>(run: (tx: NakhDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (tx) => {
      // Same lock order as funding and invoice creation, including on replay.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${'billing-user:'} || ${this.owner.userId}::text, 0))`.execute(
        tx,
      );
      await requireCurrentUserSession(tx, this.owner.userId, this.owner);
      const account = await tx
        .selectFrom('identity.accounts')
        .select('state')
        .where('user_id', '=', this.owner.userId)
        .executeTakeFirst();
      if (account?.state !== 'active') denied();
      return run(tx);
    });
  }
  private async offer(tx: NakhDatabase, id: string, version: number): Promise<StarsPurchaseOffer> {
    if (!UUID.test(id) || !Number.isSafeInteger(version) || version < 1) denied();
    const row = await tx
      .selectFrom('billing.pending_payments as intent')
      .selectAll('intent')
      .where('intent.id', '=', id)
      .where('intent.user_id', '=', this.owner.userId)
      .where('intent.product_epoch', '=', this.owner.productEpoch)
      .where('intent.version', '=', version)
      .where('intent.status', '=', 'pending')
      .where('intent.funding_type', '=', 'telegram_stars')
      .where('intent.expires_at', '>', tx.fn<Date>('clock_timestamp', []))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('billing.payment_records as payment')
              .select('payment.id')
              .whereRef('payment.pending_payment_id', '=', 'intent.id')
              .where('payment.status', 'in', ['paid', 'refunded']),
          ),
        ),
      )
      .executeTakeFirst();
    if (!row || row.required_stars === null) denied();
    const stars = BigInt(row.required_stars);
    if (stars <= 0n || stars > BigInt(Number.MAX_SAFE_INTEGER)) denied();
    if (row.reason === 'buy_credit_package') {
      if (
        row.target_type !== 'credit_package' ||
        row.package_code_snapshot === null ||
        row.package_credit_amount_snapshot === null ||
        BigInt(row.package_credit_amount_snapshot) <= 0n
      )
        denied();
    } else if (
      row.reason !== 'send_nakh' ||
      row.target_type !== 'pending_nakh' ||
      stars !== NAKH_STARS_COST ||
      row.package_code_snapshot !== null ||
      row.package_credit_amount_snapshot !== null
    )
      denied();
    const facts = {
      fundingIntentId: row.id,
      version: row.version,
      reason: row.reason,
      stars: stars.toString(),
      packageCode: row.package_code_snapshot,
      credits: row.package_credit_amount_snapshot,
      expiresAt: row.expires_at,
    };
    return Object.freeze({
      ...facts,
      digest: digest([this.owner.userId, this.owner.productEpoch, facts]),
    });
  }
  public review(id: string, version: number): Promise<StarsPurchaseOffer> {
    return this.locked((tx) => this.offer(tx, id, version));
  }
  public async accept(input: StarsPurchaseConsentWrite): Promise<StarsPurchaseConsent> {
    const write = structuredClone(input);
    if (
      !UUID.test(write.commandId) ||
      !UUID.test(write.requestId) ||
      !DIGEST.test(write.offerDigest) ||
      !DIGEST.test(write.documentDigest) ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(write.termsVersion) ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(write.locale)
    )
      denied();
    return await this.locked(async (tx) => {
      const offer = await this.offer(tx, write.fundingIntentId, write.expectedVersion);
      if (offer.digest !== write.offerDigest) denied();
      const metadata = {
        productEpoch: this.owner.productEpoch,
        sessionGrantId: this.owner.sessionGrantId,
        offerDigest: offer.digest,
        termsVersion: write.termsVersion,
        documentDigest: write.documentDigest,
        locale: write.locale,
      };
      const id = consentId([EVENT, this.owner.userId, offer.fundingIntentId, metadata]);
      const previous = await tx
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (previous) return this.read(tx, id, offer, true);
      const now = (
        await sql<{
          now: Date;
        }>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`.execute(tx)
      ).rows[0]!.now;
      const count = await tx
        .selectFrom('platform.audit_logs')
        .select(({ fn }) => fn.countAll<string>().as('count'))
        .where('event_type', '=', EVENT)
        .where('actor_user_id', '=', this.owner.userId)
        .where('occurred_at', '>', new Date(now.getTime() - PROVIDER_ATTEMPT_WINDOW_MS))
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= PROVIDER_ATTEMPT_LIMIT)
        throw new ApplicationError('payment_attempt_limit', 'error.billing.attempt_limit', 429);
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'product',
          event_type: EVENT,
          actor_type: 'user',
          actor_user_id: this.owner.userId,
          actor_admin_id: null,
          subject_type: 'stars_purchase',
          subject_id: offer.fundingIntentId,
          result_code: 'accepted',
          metadata_schema_version: 1,
          metadata,
          request_id: write.requestId,
          command_id: write.commandId,
          occurred_at: now,
        })
        .execute();
      return this.read(tx, id, offer, false);
    });
  }
  private async read(
    tx: NakhDatabase,
    id: string,
    offer: StarsPurchaseOffer,
    replayed: boolean,
  ): Promise<StarsPurchaseConsent> {
    const row = await tx
      .selectFrom('platform.audit_logs')
      .select('metadata')
      .where('id', '=', id)
      .where('category', '=', 'product')
      .where('event_type', '=', EVENT)
      .where('actor_type', '=', 'user')
      .where('actor_user_id', '=', this.owner.userId)
      .where('actor_admin_id', 'is', null)
      .where('subject_type', '=', 'stars_purchase')
      .where('subject_id', '=', offer.fundingIntentId)
      .where('result_code', '=', 'accepted')
      .where('metadata_schema_version', '=', 1)
      .executeTakeFirst();
    const m = row?.metadata;
    if (
      !m ||
      Object.keys(m).sort().join(',') !==
        'documentDigest,locale,offerDigest,productEpoch,sessionGrantId,termsVersion' ||
      m.productEpoch !== this.owner.productEpoch ||
      m.sessionGrantId !== this.owner.sessionGrantId ||
      m.offerDigest !== offer.digest ||
      typeof m.termsVersion !== 'string' ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(m.termsVersion) ||
      typeof m.documentDigest !== 'string' ||
      !DIGEST.test(m.documentDigest) ||
      typeof m.locale !== 'string' ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(m.locale) ||
      consentId([EVENT, this.owner.userId, offer.fundingIntentId, m]) !== id
    )
      denied();
    return {
      id,
      termsVersion: m.termsVersion,
      documentDigest: m.documentDigest,
      locale: m.locale,
      offer,
      replayed,
    };
  }
  public async require(
    id: string,
    fundingIntentId: string,
    expectedVersion: number,
  ): Promise<StarsPurchaseConsent> {
    if (!UUID.test(id)) denied();
    return await this.locked(async (tx) =>
      this.read(tx, id, await this.offer(tx, fundingIntentId, expectedVersion), true),
    );
  }
}
