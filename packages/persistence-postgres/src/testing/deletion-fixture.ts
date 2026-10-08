import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { RegisterTelegramIdentityWrite } from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import { PostgresIdentityStore } from '../identity-store.js';
import { PostgresAccountDeletionStore } from '../account-deletion-store.js';

/** Native lifecycle fixture uses real identity/admission transactions, not fabricated work rows. */
export async function createDeletionFixture(
  database: NakhDatabase,
  beforeDeletion?: (userId: string) => Promise<void>,
): Promise<{ userId: string; recordId: string }> {
  const commandId = randomUUID(),
    userId = randomUUID(),
    at = new Date();
  const telegramId = String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000));
  const write: RegisterTelegramIdentityWrite = {
    command: {
      commandId,
      commandType: 'identity.register-telegram-identity',
      schemaVersion: 1,
      actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
      requestId: randomUUID(),
      idempotencyKey: `m8-work-start:${commandId}`,
      occurredAt: at.toISOString(),
      locale: 'en',
      channelContext: { channel: 'telegram', channelIdentityId: telegramId },
      data: { telegramUserId: telegramId, updateId: commandId },
    },
    userId,
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    registrationEventId: randomUUID(),
    startRouteEventId: randomUUID(),
    processedAt: at,
    guestPreviewLimit: 10,
    defaultLocale: 'en',
  };
  await new PostgresIdentityStore(database).registerTelegramIdentity(write);
  await beforeDeletion?.(userId);
  const account = await database
    .selectFrom('identity.accounts')
    .select('version')
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  const key = randomBytes(32),
    deletion = new PostgresAccountDeletionStore(database, {
      activeKeyId: 'm8-work-fixture',
      keys: new Map([['m8-work-fixture', key]]),
    });
  try {
    const proof = await deletion.prepare({
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      expectedAccountVersion: account.version,
    });
    const id = randomUUID();
    await deletion.request({
      commandId: id,
      commandType: 'account.delete',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: `m8-work-delete:${id}`,
      occurredAt: at.toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: account.version, confirmationToken: proof.confirmationToken },
    });
  } finally {
    key.fill(0);
  }
  const record = (
    await sql<{
      id: string;
    }>`SELECT id FROM identity.account_deletion_records WHERE user_id=${userId}::uuid`.execute(
      database,
    )
  ).rows[0]!;
  return { userId, recordId: record.id };
}
