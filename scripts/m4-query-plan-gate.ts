import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzeM4QueryTables,
  createDatabase,
  explainM4Queries,
  runMigrations,
} from '@nakh/persistence-postgres';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for the M4 query-plan gate.');

const volume = Number(process.env.NAKH_M4_PLAN_VOLUME ?? '5000');
if (!Number.isSafeInteger(volume) || volume < 1_000 || volume > 50_000)
  throw new Error('NAKH_M4_PLAN_VOLUME must be an integer between 1000 and 50000.');

const dueCount = Math.max(100, Math.floor(volume / 50));
const batchSize = 250;
const packageId = '40000000-0000-4000-8000-000000000001';
const old = new Date(Date.now() - 60 * 60_000);
const expires = new Date(Date.now() + 60 * 60_000);
const cipher = Uint8Array.from({ length: 32 }, () => 7);

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type Fixture = Readonly<{
  userId: string;
  intentId: string;
  paymentId: string;
  eventId: string;
  refundId: string;
  likeId: string;
  unlockId: string;
  notificationId: string;
  deliveryId: string;
  index: number;
}>;

function planDocument(value: unknown): Readonly<Record<string, unknown>> {
  const candidate: unknown = Array.isArray(value) ? (value as readonly unknown[]).at(0) : value;
  if (candidate === null || typeof candidate !== 'object')
    throw new Error('M4 query plan did not return a JSON plan document.');
  return candidate as Readonly<Record<string, unknown>>;
}

function requirePlan(name: string, value: unknown, requiredIndex: string): void {
  const document = planDocument(value);
  const executionTime = document['Execution Time'];
  if (typeof executionTime !== 'number' || executionTime > 1_000)
    throw new Error(`${name} exceeded its 1000 ms execution budget.`);
  if (!JSON.stringify(document).includes(`"Index Name":"${requiredIndex}"`))
    throw new Error(`${name} did not use ${requiredIndex}.`);
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 10,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
});

try {
  const fixtures: Fixture[] = Array.from({ length: volume }, (_, index) => ({
    userId: randomUUID(),
    intentId: randomUUID(),
    paymentId: randomUUID(),
    eventId: randomUUID(),
    refundId: randomUUID(),
    likeId: randomUUID(),
    unlockId: randomUUID(),
    notificationId: randomUUID(),
    deliveryId: randomUUID(),
    index,
  }));

  for (let offset = 0; offset < fixtures.length; offset += batchSize) {
    const batch = fixtures.slice(offset, offset + batchSize);
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto('identity.users')
        .values(
          batch.map((fixture) => ({
            id: fixture.userId,
            last_activity_at: old,
            created_at: old,
            updated_at: old,
          })),
        )
        .execute();
      await transaction
        .insertInto('billing.pending_payments')
        .values(
          batch.map((fixture) => ({
            id: fixture.intentId,
            user_id: fixture.userId,
            reason: 'buy_credit_package' as const,
            target_type: 'credit_package' as const,
            target_id: packageId,
            funding_type: 'telegram_stars' as const,
            required_credits: null,
            required_stars: '10',
            package_code_snapshot: 'starter',
            package_credit_amount_snapshot: '10',
            status: fixture.index < dueCount ? ('pending' as const) : ('paid' as const),
            idempotency_key: `plan-intent:${fixture.intentId}`,
            request_hash: digest(`intent:${fixture.intentId}`),
            created_at: old,
            expires_at: expires,
            resolved_at: fixture.index < dueCount ? null : old,
          })),
        )
        .execute();
      await transaction
        .insertInto('billing.payment_records')
        .values(
          batch.map((fixture) => ({
            id: fixture.paymentId,
            user_id: fixture.userId,
            pending_payment_id: fixture.intentId,
            payment_type: 'buy_credit_package' as const,
            paid_action_reason: null,
            credit_package_id: packageId,
            package_code_snapshot: 'starter',
            package_credit_amount_snapshot: '10',
            status: fixture.index < dueCount ? ('pending' as const) : ('paid' as const),
            stars_amount: '10',
            provider: 'telegram_stars' as const,
            provider_environment: 'test' as const,
            provider_bot_id_digest: 'b'.repeat(64),
            invoice_payload_digest: digest(`payload:${fixture.paymentId}`),
            invoice_payload_ciphertext: cipher,
            invoice_payload_key_id: 'plan-v1',
            provider_payment_id: `plan-provider:${fixture.paymentId}`,
            idempotency_key: `plan-payment:${fixture.paymentId}`,
            request_hash: digest(`payment:${fixture.paymentId}`),
            created_at: old,
            paid_at: fixture.index < dueCount ? null : old,
            failed_at: null,
            cancelled_at: null,
            expired_at: null,
            refunded_at: null,
          })),
        )
        .execute();
      await transaction
        .insertInto('billing.payment_provider_events')
        .values(
          batch.map((fixture) => ({
            id: fixture.eventId,
            provider: 'telegram_stars' as const,
            provider_event_id: `plan-event:${fixture.eventId}`,
            event_type: 'successful_payment' as const,
            payment_record_id: fixture.paymentId,
            payer_user_id: fixture.userId,
            fact_hash: digest(`fact:${fixture.eventId}`),
            raw_payload_digest: digest(`raw:${fixture.eventId}`),
            raw_payload_ciphertext: cipher,
            raw_payload_key_id: 'plan-v1',
            raw_payload_schema_version: 1,
            decision: 'receipt_recorded' as const,
            reason_code: null,
            received_at: old,
          })),
        )
        .execute();
      await transaction
        .insertInto('billing.telegram_stars_receipts')
        .values(
          batch.map((fixture) => ({
            payment_record_id: fixture.paymentId,
            provider_event_id: `plan-event:${fixture.eventId}`,
            telegram_charge_id: `plan-charge:${fixture.paymentId}`,
            provider_charge_id: null,
            payer_user_id: fixture.userId,
            stars_amount: '10',
            received_at: old,
          })),
        )
        .execute();
      await transaction
        .insertInto('billing.payment_fulfillments')
        .values(
          batch.map((fixture) => ({
            payment_record_id: fixture.paymentId,
            state:
              fixture.index < dueCount ? ('receipt_recorded' as const) : ('fulfilled' as const),
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: null,
            fulfilled_at: fixture.index < dueCount ? null : old,
            correction_required_at: null,
            corrected_at: null,
            created_at: old,
            updated_at: old,
          })),
        )
        .execute();
      await transaction
        .insertInto('billing.refund_records')
        .values(
          batch.map((fixture) => ({
            id: fixture.refundId,
            user_id: fixture.userId,
            funding_type: 'telegram_stars' as const,
            payment_record_id: fixture.paymentId,
            original_credit_transaction_id: null,
            refund_credit_transaction_id: null,
            telegram_charge_id: `plan-charge:${fixture.paymentId}`,
            reason_code: 'system_failure' as const,
            stars_amount: '10',
            credits_amount: null,
            status: fixture.index < dueCount ? ('pending' as const) : ('processed' as const),
            provider_progress:
              fixture.index < dueCount ? ('not_started' as const) : ('refund_confirmed' as const),
            lease_owner: null,
            lease_expires_at: null,
            last_error_code: null,
            idempotency_key: `plan-refund:${fixture.paymentId}`,
            processed_at: fixture.index < dueCount ? null : old,
            failed_at: null,
            created_at: old,
            updated_at: old,
          })),
        )
        .execute();
      await transaction
        .insertInto('interaction.likes')
        .values(
          batch.map((fixture, batchIndex) => ({
            id: fixture.likeId,
            sender_user_id: fixture.userId,
            receiver_user_id: batch[(batchIndex + 1) % batch.length]!.userId,
            status: 'active' as const,
            created_at: old,
            closed_at: null,
          })),
        )
        .execute();
      await transaction
        .insertInto('interaction.feature_unlocks')
        .values(
          batch.map((fixture) => ({
            id: fixture.unlockId,
            payer_user_id: fixture.userId,
            feature_type: 'liked_by_profile_unlock' as const,
            like_id: fixture.likeId,
            match_id: null,
            payment_record_id: fixture.paymentId,
            credit_transaction_id: null,
            expires_at: null,
            revoked_at: null,
            revoked_reason: null,
            revoked_by_admin_id: null,
            expired_at: null,
            unlocked_at: old,
          })),
        )
        .execute();
      await transaction
        .insertInto('notification.notifications')
        .values(
          batch.map((fixture) => ({
            id: fixture.notificationId,
            user_id: fixture.userId,
            notification_type: 'payment_success' as const,
            category: 'payment' as const,
            title_key: 'notification.payment_success.title',
            body_key: 'notification.payment_success.body',
            payload: {},
            deduplication_key: `plan-notification:${fixture.paymentId}`,
            created_at: old,
            read_at: null,
          })),
        )
        .execute();
      await transaction
        .insertInto('notification.notification_deliveries')
        .values(
          batch.map((fixture) => ({
            id: fixture.deliveryId,
            notification_id: fixture.notificationId,
            channel: 'telegram' as const,
            status: fixture.index < dueCount ? ('pending' as const) : ('sent' as const),
            next_attempt_at: fixture.index < dueCount ? old : null,
            sent_at: fixture.index < dueCount ? null : old,
            failed_at: null,
            failure_code: null,
            provider_delivery_key:
              fixture.index < dueCount ? null : `plan-delivery:${fixture.deliveryId}`,
            created_at: old,
            updated_at: old,
          })),
        )
        .execute();
    });
  }

  await analyzeM4QueryTables(database);
  const plans = await explainM4Queries(database, {
    userId: fixtures[0]!.userId,
    paymentRecordId: fixtures[0]!.paymentId,
  });
  const requirements = {
    fulfillments: 'payment_fulfillments_due_idx',
    refunds: 'refund_records_due_idx',
    providerEvents: 'payment_provider_events_payment_idx',
    unlocks: 'feature_unlocks_payer_status_idx',
    deliveries: 'notification_deliveries_due_idx',
    payments: 'payment_records_reconciliation_idx',
  } as const;
  for (const [name, requiredIndex] of Object.entries(requirements))
    requirePlan(name, plans[name], requiredIndex);

  const artifact = {
    schemaVersion: 1,
    fixture: { rowCountPerTable: volume, dueCount },
    maximumExecutionMs: 1_000,
    requiredIndexes: requirements,
    plans,
  };
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m4-query-plans.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `${JSON.stringify({ scenario: 'M4-PRODUCTION-QUERY-PLAN', volume, dueCount, queries: Object.keys(requirements) })}\n`,
  );
} finally {
  await database.destroy();
}
