import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';

import type { NakhMaintenancePhaseResult, NakhMaintenanceStore } from '@nakh/application';
import { ApplicationError, isPendingNakhReminderDue } from '@nakh/domain';

import type { NakhDatabase } from './database.js';
import { insertNotification } from './notification-store.js';

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250)
    throw new ApplicationError('invalid_request', 'error.nakh.maintenance_limit_invalid', 400);
}

async function databaseNow(database: NakhDatabase): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT transaction_timestamp() AS now`.execute(database);
  return result.rows[0]!.now;
}

/** Performs replay-safe deadline and reminder transitions in short, independently committed units. */
export class PostgresNakhMaintenanceStore implements NakhMaintenanceStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async expirePending(limit: number): Promise<NakhMaintenancePhaseResult> {
    validateLimit(limit);
    const candidates = await this.database
      .selectFrom('nakh.pending_nakhes')
      .select(['id', 'sender_user_id'])
      .where('status', '=', 'pending_payment')
      .where('expires_at', '<=', sql<Date>`clock_timestamp()`)
      .orderBy('expires_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    let changed = 0;
    for (const candidate of candidates)
      if (await this.expirePendingOne(candidate.id, candidate.sender_user_id)) changed += 1;
    return { examined: candidates.length, changed };
  }

  public async expireDelivered(limit: number): Promise<NakhMaintenancePhaseResult> {
    validateLimit(limit);
    const candidates = await this.database
      .selectFrom('nakh.nakhes')
      .select('id')
      .where('status', 'in', ['sent', 'seen'])
      .where('expires_at', '<=', sql<Date>`clock_timestamp()`)
      .orderBy('expires_at', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    let changed = 0;
    for (const candidate of candidates)
      if (await this.expireDeliveredOne(candidate.id)) changed += 1;
    return { examined: candidates.length, changed };
  }

  public async sendPendingReminders(limit: number): Promise<NakhMaintenancePhaseResult> {
    validateLimit(limit);
    const candidates = await this.database
      .selectFrom('nakh.pending_nakhes')
      .select('id')
      .where('status', '=', 'pending_payment')
      .where('reminder_count', '<', 6)
      .where('expires_at', '>', sql<Date>`clock_timestamp()`)
      .where(
        sql<boolean>`COALESCE(last_reminder_at, created_at) + interval '48 hours' <= clock_timestamp()`,
      )
      .orderBy(sql<Date>`COALESCE(last_reminder_at, created_at)`, 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    let changed = 0;
    for (const candidate of candidates)
      if (await this.sendPendingReminderOne(candidate.id)) changed += 1;
    return { examined: candidates.length, changed };
  }

  private async expirePendingOne(pendingNakhId: string, senderUserId: string): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      // All Pending Nakh terminal paths lock the sender counter before the aggregate.
      const counter = await transaction
        .selectFrom('platform.user_counters')
        .select('pending_nakh_count')
        .where('user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      const pending = await transaction
        .selectFrom('nakh.pending_nakhes')
        .select(['id', 'status', 'pending_payment_id', 'expires_at', 'version'])
        .where('id', '=', pendingNakhId)
        .where('sender_user_id', '=', senderUserId)
        .forUpdate()
        .executeTakeFirst();
      if (pending === undefined || counter === undefined) return false;
      const now = await databaseNow(transaction);
      if (pending.status !== 'pending_payment' || pending.expires_at > now) return false;

      const payment = await transaction
        .selectFrom('billing.pending_payments')
        .select(['id', 'status', 'version'])
        .where('id', '=', pending.pending_payment_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (payment.status === 'pending')
        await transaction
          .updateTable('billing.pending_payments')
          .set({ status: 'expired', resolved_at: now, version: sql<number>`version + 1` })
          .where('id', '=', payment.id)
          .where('status', '=', 'pending')
          .where('version', '=', payment.version)
          .executeTakeFirstOrThrow();

      await transaction
        .updateTable('nakh.pending_nakhes')
        .set({ status: 'expired', expired_at: now, version: sql<number>`version + 1` })
        .where('id', '=', pending.id)
        .where('status', '=', 'pending_payment')
        .where('version', '=', pending.version)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platform.user_counters')
        .set({
          pending_nakh_count: sql<number>`pending_nakh_count - 1`,
          version: sql<number>`version + 1`,
          updated_at: now,
        })
        .where('user_id', '=', senderUserId)
        .where('pending_nakh_count', '>', 0)
        .executeTakeFirstOrThrow();

      const actionId = randomUUID();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: randomUUID(),
          aggregate_type: 'pending_nakh',
          aggregate_id: pending.id,
          event_type: 'nakh.status-changed.v1',
          schema_version: 1,
          payload: { pendingNakhId: pending.id, status: 'expired' },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: actionId,
          causation_id: actionId,
        })
        .execute();
      return true;
    });
  }

  private async expireDeliveredOne(nakhId: string): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const nakh = await transaction
        .selectFrom('nakh.nakhes')
        .select(['id', 'status', 'expires_at', 'version'])
        .where('id', '=', nakhId)
        .forUpdate()
        .executeTakeFirst();
      if (nakh === undefined) return false;
      const now = await databaseNow(transaction);
      if ((nakh.status !== 'sent' && nakh.status !== 'seen') || nakh.expires_at > now) return false;

      const nextVersion = nakh.version + 1;
      const actionId = randomUUID();
      await transaction
        .updateTable('nakh.nakhes')
        .set({ status: 'expired', expired_at: now, version: nextVersion })
        .where('id', '=', nakh.id)
        .where('status', '=', nakh.status)
        .where('version', '=', nakh.version)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('nakh.nakh_status_history')
        .values({
          id: randomUUID(),
          nakh_id: nakh.id,
          nakh_version: nextVersion,
          from_status: nakh.status,
          to_status: 'expired',
          reason_code: 'deadline_elapsed',
          changed_by_user_id: null,
          request_id: actionId,
          changed_at: now,
        })
        .execute();
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: randomUUID(),
          aggregate_type: 'nakh',
          aggregate_id: nakh.id,
          event_type: 'nakh.status-changed.v1',
          schema_version: 1,
          payload: { nakhId: nakh.id, status: 'expired' },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: actionId,
          causation_id: actionId,
        })
        .execute();
      return true;
    });
  }

  private async sendPendingReminderOne(pendingNakhId: string): Promise<boolean> {
    return this.database.transaction().execute(async (transaction) => {
      const pending = await transaction
        .selectFrom('nakh.pending_nakhes')
        .select([
          'id',
          'sender_user_id',
          'status',
          'created_at',
          'expires_at',
          'reminder_count',
          'last_reminder_at',
          'version',
        ])
        .where('id', '=', pendingNakhId)
        .forUpdate()
        .executeTakeFirst();
      if (pending === undefined) return false;
      const now = await databaseNow(transaction);
      if (
        !isPendingNakhReminderDue({
          status: pending.status,
          createdAt: pending.created_at,
          expiresAt: pending.expires_at,
          reminderCount: pending.reminder_count,
          ...(pending.last_reminder_at === null
            ? {}
            : { lastReminderAt: pending.last_reminder_at }),
          now,
        })
      )
        return false;

      const reminderNumber = pending.reminder_count + 1;
      const actionId = randomUUID();
      await transaction
        .updateTable('nakh.pending_nakhes')
        .set({
          reminder_count: reminderNumber,
          last_reminder_at: now,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', pending.id)
        .where('status', '=', 'pending_payment')
        .where('version', '=', pending.version)
        .executeTakeFirstOrThrow();
      await insertNotification(transaction, {
        userId: pending.sender_user_id,
        type: 'pending_nakh_payment_reminder',
        titleKey: 'notification.pending_nakh_payment_reminder.title',
        bodyKey: 'notification.pending_nakh_payment_reminder.body',
        payload: {
          pendingNakhId: pending.id,
          reminderNumber,
          expiresAt: pending.expires_at.toISOString(),
        },
        deduplicationKey: `pending-nakh-reminder:${pending.id}:${reminderNumber}`,
        correlationId: actionId,
        causationId: actionId,
      });
      await transaction
        .insertInto('platform.outbox_events')
        .values({
          id: randomUUID(),
          aggregate_type: 'pending_nakh',
          aggregate_id: pending.id,
          event_type: 'nakh.pending-reminder-requested.v1',
          schema_version: 1,
          payload: { pendingNakhId: pending.id, reminderNumber },
          occurred_at: now,
          available_at: now,
          published_at: null,
          last_error_code: null,
          lease_owner: null,
          lease_expires_at: null,
          correlation_id: actionId,
          causation_id: actionId,
        })
        .execute();
      return true;
    });
  }
}
