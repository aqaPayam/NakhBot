import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { ConsumeGuestPreviewWrite, RegisterTelegramIdentityWrite } from '@nakh/application';
import {
  createDatabase,
  PostgresGuestPreviewStore,
  PostgresIdentityStore,
  runMigrations,
} from '@nakh/persistence-postgres';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for M1 load smoke.');

function hasErrorCode(value: unknown, expectedCode: string): boolean {
  if (typeof value !== 'object' || value === null || !('code' in value)) return false;
  return value.code === expectedCode;
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 30,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 10_000,
});

try {
  const userId = randomUUID();
  const now = new Date('2026-09-05T09:00:00.000Z');
  const telegramUserId = String(
    1_000_000_000_000n +
      (BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 8_000_000_000_000n),
  );
  const registration: RegisterTelegramIdentityWrite = {
    command: {
      commandId: randomUUID(),
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { kind: 'system', userId: randomUUID() },
      requestId: randomUUID(),
      idempotencyKey: `m1-load-registration:${userId}`,
      occurredAt: now.toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: telegramUserId },
      data: { telegramUserId, updateId: `m1-load-${randomUUID()}` },
    },
    userId,
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    registrationEventId: randomUUID(),
    startRouteEventId: randomUUID(),
    processedAt: now,
    guestPreviewLimit: 10,
    defaultLocale: 'en',
  };
  await new PostgresIdentityStore(database).registerTelegramIdentity(registration);

  const previewStore = new PostgresGuestPreviewStore(database);
  const writes: ConsumeGuestPreviewWrite[] = Array.from({ length: 50 }, (_, index) => {
    const processedAt = new Date(now.getTime() + index + 1);
    return {
      command: {
        commandId: randomUUID(),
        commandType: 'identity.consume-guest-preview',
        schemaVersion: 1,
        actor: { kind: 'user', userId },
        requestId: randomUUID(),
        idempotencyKey: `m1-load-preview:${index}:${userId}`,
        occurredAt: processedAt.toISOString(),
        locale: 'en',
        data: { candidateUserId: randomUUID(), deliveryReceiptId: `m1-load-delivery-${index}` },
      },
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt,
    };
  });
  const startedAt = performance.now();
  const outcomes = await Promise.allSettled(
    writes.map((write) => previewStore.consumeGuestPreview(write)),
  );
  const durationMs = Math.round(performance.now() - startedAt);
  const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const denials = outcomes.filter(
    (outcome) =>
      outcome.status === 'rejected' && hasErrorCode(outcome.reason, 'guest_preview_limit_reached'),
  );
  const [counter, audits, events] = await Promise.all([
    database
      .selectFrom('identity.guest_preview_counters')
      .select(['preview_count', 'limit_count'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom('platform.audit_logs')
      .select('id')
      .where('subject_id', '=', userId)
      .where('event_type', '=', 'identity.guest-preview-consumed.v1')
      .execute(),
    database
      .selectFrom('platform.outbox_events')
      .select('id')
      .where('aggregate_id', '=', userId)
      .where('event_type', '=', 'identity.guest-preview-consumed.v1')
      .execute(),
  ]);
  if (
    successes.length !== 10 ||
    denials.length !== 40 ||
    counter.preview_count !== 10 ||
    counter.limit_count !== 10 ||
    audits.length !== 10 ||
    events.length !== 10 ||
    durationMs > 30_000
  )
    throw new Error(
      `M1 load smoke failed: success=${successes.length}, denial=${denials.length}, count=${counter.preview_count}, audit=${audits.length}, event=${events.length}, durationMs=${durationMs}`,
    );
  process.stdout.write(
    `${JSON.stringify({ scenario: 'ACC-002/M1-COUNTER', attempts: 50, successes: 10, denials: 40, finalCount: 10, durationMs })}\n`,
  );
} finally {
  await database.destroy();
}
