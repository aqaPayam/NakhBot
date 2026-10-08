import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportChat,
  createReportLike,
  createReportMatch,
  createReportNakh,
  createReportPhoto,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresPendingNakhStore } from './pending-nakh-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 verified shared checkpoint', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionCheckpointStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_checkpoint');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionCheckpointStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
      database,
    );
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const rows = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  async function state(id: string): Promise<{
    phase: string;
    checkpoint_version: number;
    shared_closed_at: Date | null;
    reactivation_allowed: boolean;
  }> {
    return (
      await sql<{
        phase: string;
        checkpoint_version: number;
        shared_closed_at: Date | null;
        reactivation_allowed: boolean;
      }>`SELECT phase,checkpoint_version,shared_closed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${id}::uuid`.execute(
        database,
      )
    ).rows[0]!;
  }
  async function receipts(id: string): Promise<number> {
    return (
      await sql`SELECT deletion_record_id FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${id}::uuid`.execute(
        database,
      )
    ).rows.length;
  }
  async function active(owner: string, other: string): Promise<void> {
    const profile = await database
      .selectFrom('profile.profiles')
      .selectAll()
      .where('user_id', '=', other)
      .executeTakeFirstOrThrow();
    await database
      .insertInto('profile.profiles')
      .values({ ...profile, id: randomUUID(), user_id: owner })
      .execute();
    await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${owner}::uuid`.execute(
      database,
    );
    const at = new Date();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: other, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: other, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: other, created_at: at, updated_at: at })
      .execute();
  }
  it('twenty finishers commit one durable receipt and replay after outbox loss without completing purge', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.finishShared(lease)));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(
      results.every(
        (result) => result.phase === 'evidence_capture' && result.checkpointVersion === 2,
      ),
    ).toBe(true);
    expect(await receipts(fixture.recordId)).toBe(1);
    expect(await state(fixture.recordId)).toMatchObject({
      phase: 'evidence_capture',
      checkpoint_version: 2,
      reactivation_allowed: false,
    });
    expect((await state(fixture.recordId)).shared_closed_at).toBeInstanceOf(Date);
    const audits = await database
      .selectFrom('platform.audit_logs')
      .select(['metadata', 'actor_type'])
      .where('subject_id', '=', fixture.recordId)
      .where('event_type', '=', 'account.deletion-phase-completed.v1')
      .execute();
    expect(audits).toEqual([
      { metadata: { phase: 'shared_closure', checkpointVersion: 1 }, actor_type: 'system' },
    ]);
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', fixture.recordId)
      .execute();
    expect(await new PostgresAccountDeletionCheckpointStore(database).finishShared(lease)).toEqual({
      phase: 'evidence_capture',
      checkpointVersion: 2,
      replayed: true,
    });
    const next = await claim();
    expect(next).toMatchObject({
      phase: 'evidence_capture',
      checkpointVersion: 2,
      leaseGeneration: 2,
    });
    await expect(store.finishShared(next)).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.finishShared({ ...lease, userId: randomUUID() })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(store.finishShared({ ...lease, leaseOwner: randomUUID() })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(store.finishShared({ ...lease, leaseGeneration: 2 })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      sql`UPDATE identity.account_deletion_phase_receipts SET lease_generation=lease_generation+1 WHERE deletion_record_id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`DELETE FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE identity.account_deletion_records SET phase='product_data',checkpoint_version=3 WHERE id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      sql`UPDATE identity.account_deletion_work SET phase='product_data',checkpoint_version=3 WHERE deletion_record_id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
  });
  it.each([
    'like',
    'match',
    'chat',
    'pair',
    'like_grant',
    'match_grant',
    'pending',
    'delivered',
  ] as const)('cannot certify an open %s scope, including orphan grants/chats', async (kind) => {
    const other = await createReportUser(database, true);
    const fixture = await createDeletionFixture(database, async (owner) => {
      await active(owner, other);
      if (kind === 'pending') {
        await new PostgresPendingNakhStore(database).createPending({
          command: {
            commandType: 'nakh.create-pending',
            schemaVersion: 1,
            commandId: randomUUID(),
            actor: { kind: 'user', userId: owner },
            requestId: randomUUID(),
            idempotencyKey: randomUUID(),
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: {
              targetUserId: other,
              text: 'Synthetic pending scope',
              autoSettleAuthorized: true,
            },
          },
          flowId: randomUUID(),
          pendingNakhId: randomUUID(),
          pendingPaymentId: randomUUID(),
          flowEventId: randomUUID(),
          pendingEventId: randomUUID(),
        });
      } else if (kind === 'delivered') {
        await createReportNakh(database, owner, other);
      } else if (kind === 'pair') {
        const [low, high] = [owner, other].sort() as [string, string];
        await database
          .insertInto('interaction.user_pair_states')
          .values({
            user_low_id: low,
            user_high_id: high,
            state: 'matched',
            reason_code: 'mutual_like',
            changed_at: new Date(),
          })
          .execute();
      } else {
        let targetId: string;
        if (kind === 'like' || kind === 'like_grant')
          targetId = await createReportLike(database, owner, other);
        else if (kind === 'match') targetId = await createReportMatch(database, owner, other);
        else targetId = (await createReportChat(database, owner, other)).matchId;
        if (kind.endsWith('grant')) {
          if (kind === 'like_grant') await createReportPhoto(database, other, true);
          if (kind === 'match_grant') {
            const [low, high] = [owner, other].sort() as [string, string];
            await database
              .insertInto('interaction.user_pair_states')
              .values({
                user_low_id: low,
                user_high_id: high,
                state: 'matched',
                reason_code: 'mutual_like',
                changed_at: new Date(),
              })
              .execute();
          }
          const userId = kind === 'like_grant' ? owner : other;
          await new PostgresCreditLedgerStore(database).append({
            transactionId: randomUUID(),
            userId,
            transactionType: 'admin_adjustment',
            amount: 10n,
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          });
          await new PostgresPaidActionStore(database).spendCredits({
            featureUnlockId: randomUUID(),
            creditTransactionId: randomUUID(),
            outboxEventId: randomUUID(),
            userId,
            target: { type: kind === 'like_grant' ? 'like' : 'match', targetId },
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          });
        }
        if (kind !== 'like')
          await sql`UPDATE interaction.likes SET status='cancelled_by_system',version=version+1,closed_at=clock_timestamp() WHERE sender_user_id IN (${owner}::uuid,${other}::uuid) AND receiver_user_id IN (${owner}::uuid,${other}::uuid)`.execute(
            database,
          );
        if (kind === 'chat' || kind === 'match_grant')
          await sql`UPDATE matching.matches SET status='closed',version=version+1,closed_at=clock_timestamp() WHERE id=${targetId}::uuid`.execute(
            database,
          );
        if (kind === 'match_grant')
          await sql`UPDATE chat.chat_sessions SET status='closed',version=version+1,closed_at=clock_timestamp(),closed_reason='unmatch' WHERE match_id=${targetId}::uuid`.execute(
            database,
          );
        if (kind === 'match_grant')
          await sql`UPDATE interaction.user_pair_states SET state='unmatched',reason_code='unmatch',version=version+1,changed_at=clock_timestamp() WHERE user_low_id=LEAST(${owner}::uuid,${other}::uuid) AND user_high_id=GREATEST(${owner}::uuid,${other}::uuid)`.execute(
            database,
          );
      }
    });
    const lease = await claim();
    expect(
      (
        await sql<{
          open: boolean;
        }>`SELECT identity.deletion_has_open_shared_scopes(${fixture.userId}::uuid) AS open`.execute(
          database,
        )
      ).rows[0]!.open,
    ).toBe(true);
    await expect(store.finishShared(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await receipts(fixture.recordId)).toBe(0);
    await expect(
      sql`UPDATE identity.account_deletion_records SET shared_closed_at=clock_timestamp() WHERE id=${fixture.recordId}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    expect(await new PostgresAccountDeletionSharedStore(database).closeNext(lease)).toMatchObject({
      changed: true,
      hasMore: false,
    });
    expect(await store.finishShared(lease)).toEqual({
      phase: 'evidence_capture',
      checkpointVersion: 2,
      replayed: false,
    });
  });
  it.each(['audit', 'event', 'receipt', 'record', 'work'] as const)(
    'rolls back both checkpoints and receipt when the required %s is suppressed',
    async (kind) => {
      const fixture = await createDeletionFixture(database),
        lease = await claim();
      const table =
        kind === 'audit'
          ? 'platform.audit_logs'
          : kind === 'event'
            ? 'platform.outbox_events'
            : kind === 'receipt'
              ? 'identity.account_deletion_phase_receipts'
              : kind === 'record'
                ? 'identity.account_deletion_records'
                : 'identity.account_deletion_work';
      const condition =
        kind === 'audit' || kind === 'event'
          ? "NEW.event_type='account.deletion-phase-completed.v1'"
          : kind === 'receipt'
            ? 'true'
            : "NEW.phase='evidence_capture'";
      await sql
        .raw(
          `CREATE FUNCTION identity.m8_suppress_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RETURN NULL; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER m8_suppress_checkpoint BEFORE ${kind === 'record' || kind === 'work' ? 'UPDATE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_suppress_checkpoint()`,
        )
        .execute(database);
      try {
        await expect(store.finishShared(lease)).rejects.toThrow();
        expect(await receipts(fixture.recordId)).toBe(0);
        expect(await state(fixture.recordId)).toMatchObject({
          phase: 'shared_closure',
          checkpoint_version: 1,
          shared_closed_at: null,
        });
      } finally {
        await sql.raw(`DROP TRIGGER m8_suppress_checkpoint ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_suppress_checkpoint()`.execute(database);
      }
      expect(await store.finishShared(lease)).toMatchObject({ replayed: false });
    },
  );
  it('rechecks lease expiry at transaction commit and resumes with a new generation', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim(1000);
    await expect(
      database.transaction().execute(async (tx) => {
        expect(
          await new PostgresAccountDeletionCheckpointStore(tx).finishShared(lease),
        ).toMatchObject({ replayed: false });
        await sql`SELECT pg_sleep(1.2)`.execute(tx);
      }),
    ).rejects.toThrow();
    expect(await receipts(fixture.recordId)).toBe(0);
    expect(await state(fixture.recordId)).toMatchObject({
      phase: 'shared_closure',
      checkpoint_version: 1,
    });
    const next = await claim();
    expect(next.leaseGeneration).toBe(2);
    await expect(store.finishShared(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.finishShared(next)).toMatchObject({ replayed: false });
  });
  it.each([
    'audit_request',
    'audit_metadata',
    'event_owner',
    'event_payload',
    'receipt_generation',
  ] as const)(
    'rejects changed %s evidence rather than certifying a partial chain',
    async (kind) => {
      const fixture = await createDeletionFixture(database),
        lease = await claim();
      const table = kind.startsWith('audit')
        ? 'platform.audit_logs'
        : kind.startsWith('event')
          ? 'platform.outbox_events'
          : 'identity.account_deletion_phase_receipts';
      const mutation =
        kind === 'audit_request'
          ? 'NEW.request_id:=gen_random_uuid();'
          : kind === 'audit_metadata'
            ? `NEW.metadata:=NEW.metadata || '{"extra":1}'::jsonb;`
            : kind === 'event_owner'
              ? 'NEW.aggregate_id:=gen_random_uuid();'
              : kind === 'event_payload'
                ? `NEW.payload:=NEW.payload || '{"extra":1}'::jsonb;`
                : 'NEW.lease_generation:=NEW.lease_generation+1;';
      const condition =
        kind === 'receipt_generation'
          ? 'true'
          : "NEW.event_type='account.deletion-phase-completed.v1'";
      await sql
        .raw(
          `CREATE FUNCTION identity.m8_change_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${mutation} END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER m8_change_checkpoint BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_change_checkpoint()`,
        )
        .execute(database);
      try {
        await expect(store.finishShared(lease)).rejects.toThrow();
        expect(await receipts(fixture.recordId)).toBe(0);
        expect(await state(fixture.recordId)).toMatchObject({
          phase: 'shared_closure',
          checkpoint_version: 1,
        });
      } finally {
        await sql.raw(`DROP TRIGGER m8_change_checkpoint ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_change_checkpoint()`.execute(database);
      }
      expect(await store.finishShared(lease)).toMatchObject({ replayed: false });
    },
  );
  it('does not certify after expiry behind a committing identity lock', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim(1000);
    let attempt!: Promise<void>;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT id FROM identity.users WHERE id=${fixture.userId}::uuid FOR NO KEY UPDATE`.execute(
        tx,
      );
      attempt = expect(store.finishShared(lease)).rejects.toMatchObject({ code: 'conflict' });
      await sql`SELECT pg_sleep(1.2)`.execute(tx);
    });
    await attempt;
    expect(await receipts(fixture.recordId)).toBe(0);
    expect(await store.finishShared(await claim())).toMatchObject({ replayed: false });
  });
  it('requires the pending-counter foundation rather than accepting premature product purge as closure', async () => {
    const fixture = await createDeletionFixture(database),
      lease = await claim();
    await database
      .deleteFrom('platform.user_counters')
      .where('user_id', '=', fixture.userId)
      .execute();
    await expect(store.finishShared(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await receipts(fixture.recordId)).toBe(0);
    await database
      .insertInto('platform.user_counters')
      .values({ user_id: fixture.userId })
      .execute();
    expect(await store.finishShared(lease)).toMatchObject({ replayed: false });
  });
});
