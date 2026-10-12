import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportLike,
  createReportMatch,
  createReportPhoto,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import {
  PostgresAccountDeletionReferencedLikeStore,
  type DeletionReferencedLikeBatchResult,
} from './account-deletion-referenced-like-store.js';
import { PostgresAccountDeletionPhotoStore } from './account-deletion-photo-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresFundingStore } from './funding-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 audited referenced Like source removal', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionReferencedLikeStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_ref_like');
    const temporaryRoot = resolve(tmpdir()),
      directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-like117-')));
    if (!directory.startsWith(`${temporaryRoot}${sep}`))
      throw new Error('Unsafe migration temporary path');
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 117)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 15000,
      });
      const first = await createReportUser(database),
        second = await createReportUser(database);
      await createReportMatch(database, first, second);
      const before =
        await sql`SELECT jsonb_build_object('likes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.likes r),
        'matches',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM matching.matches r),
        'anchors',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.like_reference_anchors r)) AS facts`.execute(
          database,
        );
      expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([
        '000118_m8_referenced_like_archival.sql',
        '000119_m8_unlock_original_references.sql',
        '000120_m8_owned_unlock_archival.sql',
        '000121_m8_match_original_lives.sql',
        '000122_m8_pair_archival.sql',
        '000123_m8_notification_references.sql',
        '000124_m8_notification_archival.sql',
        '000125_m8_owned_transport_batches.sql',
      ]);
      expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
      expect(
        await sql`SELECT jsonb_build_object('likes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.likes r),
        'matches',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM matching.matches r),
        'anchors',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.like_reference_anchors r)) AS facts`.execute(
          database,
        ),
      ).toMatchObject({ rows: before.rows });
      expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
        '000118_m8_referenced_like_archival.sql',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionReferencedLikeStore(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day'`.execute(database);
  });
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const leases = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(leases).toHaveLength(1);
    return leases[0]!;
  }
  async function scene(): Promise<{
    lease: AccountDeletionLease;
    survivor: string;
    matchId: string;
  }> {
    const survivor = await createReportUser(database);
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: survivor, created_at: new Date(), updated_at: new Date() })
      .execute();
    let matchId = '';
    const item = await createDeletionFixture(database, async (owner) => {
      matchId = await createReportMatch(database, owner, survivor);
    });
    const shared = await claim(),
      closure = new PostgresAccountDeletionSharedStore(database);
    while ((await closure.closeNext(shared)).hasMore) {
      /* Resume bounded closure. */
    }
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database);
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    expect(
      await new PostgresAccountDeletionMatchStore(database).archiveNext(evidence),
    ).toMatchObject({ archived: true, hasMore: false });
    await checkpoints.finishEvidence(evidence);
    const lease = await claim();
    expect(lease.deletionRecordId).toBe(item.recordId);
    return { lease, survivor, matchId };
  }
  async function facts(lease: AccountDeletionLease): Promise<Record<string, unknown>> {
    return (
      await sql<{ facts: Record<string, unknown> }>`SELECT jsonb_build_object(
      'likes',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.likes r WHERE ${lease.userId}::uuid IN (sender_user_id,receiver_user_id)),
      'account',(SELECT to_jsonb(r) FROM identity.accounts r WHERE user_id=${lease.userId}::uuid),
      'root',(SELECT to_jsonb(r) FROM identity.account_deletion_records r WHERE id=${lease.deletionRecordId}::uuid),
      'preview',(SELECT to_jsonb(r) FROM identity.guest_preview_counters r WHERE user_id=${lease.userId}::uuid),
      'anchors',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.like_reference_anchors r),
      'matchReceipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY match_id) FROM identity.account_deletion_match_receipts r),
      'credits',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.credit_transactions r),
      'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.account_deletion_like_receipts r WHERE deletion_record_id=${lease.deletionRecordId}::uuid),
      'audits',(SELECT count(*) FROM platform.audit_logs WHERE subject_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-like-batch.v1'),
      'events',(SELECT count(*) FROM platform.outbox_events WHERE aggregate_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-like-batch.v1')) AS facts`.execute(
        database,
      )
    ).rows[0]!.facts;
  }
  async function purge(lease: AccountDeletionLease): Promise<DeletionReferencedLikeBatchResult[]> {
    const rows = [];
    do {
      rows.push(await store.purgeNext(lease));
    } while (rows.at(-1)!.hasMore);
    return rows;
  }
  it.each(['credits', 'stars'] as const)(
    'preserves a genuine %s unlock and financial replay after removal, while denying renewed product access',
    async (funding) => {
      const survivor = await createReportUser(database, true),
        payer = survivor;
      const at = new Date(),
        telegramUserId = String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000));
      await database
        .insertInto('identity.telegram_identities')
        .values({
          user_id: payer,
          telegram_user_id: telegramUserId,
          username: null,
          first_seen_at: at,
          last_seen_at: at,
        })
        .execute();
      async function prepare(userId: string): Promise<void> {
        await database
          .insertInto('identity.user_settings')
          .values({ user_id: userId, created_at: at, updated_at: at })
          .onConflict((c) => c.column('user_id').doNothing())
          .execute();
        await database
          .updateTable('identity.user_settings')
          .set({ visibility_enabled: true })
          .where('user_id', '=', userId)
          .execute();
        await database
          .insertInto('billing.credit_accounts')
          .values({ user_id: userId, created_at: at, updated_at: at })
          .onConflict((c) => c.column('user_id').doNothing())
          .execute();
        await database
          .insertInto('notification.notification_preferences')
          .values({ user_id: userId, created_at: at, updated_at: at })
          .onConflict((c) => c.column('user_id').doNothing())
          .execute();
        await createReportPhoto(database, userId);
      }
      await prepare(payer);
      let likeId = '',
        unlockId = '',
        creditReplay: Parameters<PostgresPaidActionStore['spendCredits']>[0] | undefined;
      let paymentReplay:
        Parameters<PostgresTelegramStarsReceiptStore['fulfillDirectPaidAction']>[0] | undefined;
      const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
      const receipts = new PostgresTelegramStarsReceiptStore(
        database,
        { uuid: randomUUID },
        { digest },
      );
      const item = await createDeletionFixture(database, async (owner) => {
        const template = await database
          .selectFrom('profile.profiles')
          .selectAll()
          .where('user_id', '=', survivor)
          .executeTakeFirstOrThrow();
        await database
          .insertInto('profile.profiles')
          .values({ ...template, id: randomUUID(), user_id: owner })
          .execute();
        await database
          .updateTable('identity.accounts')
          .set({ state: 'active', version: sql<number>`version+1` })
          .where('user_id', '=', owner)
          .execute();
        await prepare(owner);
        likeId = await createReportLike(database, payer, owner);
        if (funding === 'credits') {
          await new PostgresCreditLedgerStore(database).append({
            transactionId: randomUUID(),
            userId: payer,
            transactionType: 'admin_adjustment',
            amount: 10n,
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          });
          creditReplay = {
            userId: payer,
            target: { type: 'like', targetId: likeId },
            featureUnlockId: randomUUID(),
            creditTransactionId: randomUUID(),
            outboxEventId: randomUUID(),
            idempotencyKey: randomUUID(),
            correlationId: randomUUID(),
          };
          unlockId = (await new PostgresPaidActionStore(database).spendCredits(creditReplay)).id;
        } else {
          const fundingStore = new PostgresFundingStore(database),
            cleartext = randomBytes(24).toString('base64url'),
            botDigest = 'b'.repeat(64);
          const intent = await fundingStore.createFundingIntent({
            intentId: randomUUID(),
            userId: payer,
            funding: 'stars',
            target: { type: 'like', targetId: likeId },
            idempotencyKey: randomUUID(),
          });
          const attempt = await fundingStore.prepareStarsAttempt({
            paymentRecordId: randomUUID(),
            fundingIntentId: intent.id,
            expectedVersion: 1,
            userId: payer,
            idempotencyKey: randomUUID(),
            providerEnvironment: 'test',
            providerBotIdDigest: botDigest,
            payload: {
              cleartext,
              digest: digest(cleartext),
              ciphertext: randomBytes(64),
              keyId: 'billing-v1',
            },
          });
          const eventId = randomUUID();
          expect(
            await receipts.recordSuccessfulPayment({
              providerEventId: eventId,
              telegramUserId,
              invoicePayload: cleartext,
              currency: 'XTR',
              totalAmount: attempt.starsAmount,
              providerEnvironment: 'test',
              providerBotIdDigest: botDigest,
              telegramChargeId: `telegram:${randomUUID()}`,
              evidence: {
                digest: digest(eventId),
                ciphertext: randomBytes(64),
                keyId: 'provider-v1',
                schemaVersion: 1,
              },
            }),
          ).toMatchObject({ outcome: 'receipt_recorded' });
          const worker = `m8-like:${randomUUID()}`,
            claim = (
              await receipts.claimFulfillments({ owner: worker, leaseMs: 120000, limit: 100 })
            ).find((row) => row.paymentRecordId === attempt.paymentRecordId)!;
          paymentReplay = {
            paymentRecordId: attempt.paymentRecordId,
            owner: worker,
            fenceToken: claim.fenceToken,
            featureUnlockId: randomUUID(),
            refundRecordId: randomUUID(),
            featureUnlockedEventId: randomUUID(),
            paymentTerminalEventId: randomUUID(),
          };
          const result = await receipts.fulfillDirectPaidAction(paymentReplay);
          expect(result.outcome).toBe('fulfilled');
          unlockId = paymentReplay.featureUnlockId;
        }
      });
      const checkpoints = new PostgresAccountDeletionCheckpointStore(database),
        shared = await claim(),
        closure = new PostgresAccountDeletionSharedStore(database);
      while ((await closure.closeNext(shared)).hasMore) {
        /* Original grant closes before removal. */
      }
      await checkpoints.finishShared(shared);
      const evidence = await claim();
      const photos = new PostgresAccountDeletionPhotoStore(database);
      while ((await photos.archiveNext(evidence)).hasMore) {
        /* Bounded source archival. */
      }
      expect(
        await new PostgresAccountDeletionProfileStore(database).archive(evidence),
      ).toMatchObject({ archived: true });
      await checkpoints.finishEvidence(evidence);
      const lease = await claim();
      expect(lease.deletionRecordId).toBe(item.recordId);
      async function money(): Promise<unknown> {
        return (
          await sql`SELECT jsonb_build_object('grants',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM interaction.feature_unlocks r),
      'credits',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.credit_transactions r),
      'balances',(SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id) FROM billing.credit_accounts r),
      'payments',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.payment_records r),
      'intents',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.pending_payments r),
      'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY payment_record_id) FROM billing.telegram_stars_receipts r),
      'refunds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.refund_records r)) AS facts`.execute(
            database,
          )
        ).rows;
      }
      const before = await money(),
        factsBefore = await facts(lease);
      expect(
        (
          await database
            .selectFrom('interaction.feature_unlocks')
            .select('status')
            .where('id', '=', unlockId)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe('revoked');
      const results = await Promise.all(Array.from({ length: 20 }, () => store.purgeNext(lease)));
      expect(results.reduce((sum, row) => sum + row.purgedRows, 0)).toBe(1);
      expect(await money()).toEqual(before);
      const factsAfter = await facts(lease);
      for (const key of ['account', 'root', 'preview', 'anchors', 'credits'])
        expect(factsAfter[key]).toEqual(factsBefore[key]);
      if (creditReplay)
        await expect(
          new PostgresPaidActionStore(database).spendCredits(creditReplay),
        ).rejects.toMatchObject({ code: 'unlock_unavailable' });
      if (paymentReplay) {
        const replies = await Promise.all(
          Array.from({ length: 20 }, () => receipts.fulfillDirectPaidAction(paymentReplay!)),
        );
        expect(replies.every((row) => row.outcome === 'fulfilled' && row.replayed)).toBe(true);
      }
      const grant = await database
        .selectFrom('interaction.feature_unlocks')
        .selectAll()
        .where('id', '=', unlockId)
        .executeTakeFirstOrThrow();
      await expect(
        database
          .insertInto('interaction.feature_unlocks')
          .values({ ...grant, id: randomUUID() })
          .execute(),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'new unlock requires its original live Like source',
      });
      expect(await money()).toEqual(before);
      expect(await store.purgeNext(lease)).toEqual({ purgedRows: 0, hasMore: false });
      const creditEpoch = creditReplay
        ? (
            await database
              .selectFrom('billing.credit_transactions')
              .select('product_epoch')
              .where('id', '=', creditReplay.creditTransactionId)
              .executeTakeFirstOrThrow()
          ).product_epoch
        : undefined;
      async function damageFunding(damaged: boolean): Promise<void> {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            const changed = creditReplay
              ? await sql`UPDATE billing.credit_transactions SET product_epoch=${damaged ? creditEpoch! + 1 : creditEpoch!}
                  WHERE id=${creditReplay.creditTransactionId}::uuid RETURNING id`.execute(
                  connection,
                )
              : await sql`UPDATE billing.telegram_stars_receipts SET payer_user_id=${damaged ? item.userId : payer}::uuid
                  WHERE payment_record_id=${paymentReplay!.paymentRecordId}::uuid RETURNING payment_record_id`.execute(
                  connection,
                );
            expect(changed.rows).toHaveLength(1);
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      await damageFunding(true);
      try {
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        await damageFunding(false);
      }
      expect(await money()).toEqual(before);
      expect(await store.purgeNext(lease)).toEqual({ purgedRows: 0, hasMore: false });
    },
  );
  it('removes two original referenced directions exactly once under twenty retries and keeps original Match, identity and financial proof', async () => {
    const { lease } = await scene(),
      before = await facts(lease);
    const original = await database
      .selectFrom('interaction.likes')
      .selectAll()
      .where('sender_user_id', '=', lease.userId)
      .executeTakeFirstOrThrow();
    const batches = (await Promise.all(Array.from({ length: 20 }, () => purge(lease)))).flat();
    expect(batches.reduce((sum, row) => sum + row.purgedRows, 0)).toBe(2);
    expect(batches.filter((row) => row.purgedRows === 1)).toHaveLength(2);
    const after = await facts(lease);
    expect(after).toMatchObject({ likes: null, audits: 2, events: 2 });
    for (const key of ['account', 'root', 'preview', 'anchors', 'matchReceipts', 'credits'])
      expect(after[key]).toEqual(before[key]);
    expect(await store.purgeNext(lease)).toEqual({ purgedRows: 0, hasMore: false });
    await expect(
      database.insertInto('interaction.likes').values(original).execute(),
    ).rejects.toBeDefined();
    await expect(
      database
        .deleteFrom('interaction.like_reference_anchors')
        .where('id', '=', original.id)
        .execute(),
    ).rejects.toBeDefined();
    await database
      .deleteFrom('platform.outbox_events')
      .where('aggregate_id', '=', lease.deletionRecordId)
      .where('event_type', '=', 'account.deletion-like-batch.v1')
      .execute();
    expect(await store.purgeNext(lease)).toEqual({ purgedRows: 0, hasMore: false });
  });
  it.each(['receipt', 'audit', 'event', 'source'] as const)(
    'rolls back a suppressed mandatory %s and retries without duplicate proof',
    async (kind) => {
      const { lease } = await scene(),
        before = await facts(lease);
      const table = {
        receipt: 'identity.account_deletion_like_receipts',
        audit: 'platform.audit_logs',
        event: 'platform.outbox_events',
        source: 'interaction.likes',
      }[kind];
      await sql
        .raw(
          `CREATE FUNCTION public.m8_ref_like_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      ${kind === 'audit' || kind === 'event' ? "IF NEW.event_type<>'account.deletion-like-batch.v1' THEN RETURN NEW; END IF;" : ''}
      RETURN NULL; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER aaa_m8_ref_like_suppress BEFORE ${kind === 'source' ? 'DELETE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.m8_ref_like_suppress()`,
        )
        .execute(database);
      try {
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(lease)).toEqual(before);
      } finally {
        await sql.raw(`DROP TRIGGER aaa_m8_ref_like_suppress ON ${table}`).execute(database);
        await sql`DROP FUNCTION public.m8_ref_like_suppress()`.execute(database);
      }
      expect((await purge(lease)).reduce((sum, row) => sum + row.purgedRows, 0)).toBe(2);
    },
  );
  it('rejects borrowed identity, root, owner, generation and checkpoint without mutation', async () => {
    const { lease } = await scene(),
      before = await facts(lease);
    for (const altered of [
      { ...lease, userId: randomUUID() },
      { ...lease, deletionRecordId: randomUUID() },
      { ...lease, leaseOwner: randomUUID() },
      { ...lease, leaseGeneration: lease.leaseGeneration + 1 },
      { ...lease, checkpointVersion: 4 },
    ])
      await expect(store.purgeNext(altered)).rejects.toMatchObject({ code: 'conflict' });
    expect(await facts(lease)).toEqual(before);
    const source = (before.likes as { id: string }[])[0]!;
    await expect(
      database.deleteFrom('interaction.likes').where('id', '=', source.id).execute(),
    ).rejects.toBeDefined();
    expect(await facts(lease)).toEqual(before);
  });
  it('rechecks a real expiring worker lease at deferred commit and requires the new generation', async () => {
    const { lease: initial } = await scene();
    await work.release(initial);
    const lease = await claim(2000),
      before = await facts(lease);
    await sql`CREATE FUNCTION public.m8_ref_like_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.1); RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER aaa_m8_ref_like_pause AFTER INSERT ON identity.account_deletion_like_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.m8_ref_like_pause()`.execute(
      database,
    );
    try {
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await facts(lease)).toEqual(before);
    } finally {
      await sql`DROP TRIGGER aaa_m8_ref_like_pause ON identity.account_deletion_like_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION public.m8_ref_like_pause()`.execute(database);
    }
    const next = await claim();
    expect(next.leaseGeneration).toBe(lease.leaseGeneration + 1);
    await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
    expect((await purge(next)).reduce((sum, row) => sum + row.purgedRows, 0)).toBe(2);
  });
  it('denies empty replay on a damaged digest and accepts exact restoration without restoring product data', async () => {
    const { lease } = await scene();
    await purge(lease);
    const row = (
      await sql<{ id: string; metadata: string }>`SELECT id,metadata::text FROM platform.audit_logs
      WHERE subject_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-like-batch.v1' ORDER BY id LIMIT 1`.execute(
        database,
      )
    ).rows[0]!;
    async function metadata(value: string): Promise<void> {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE platform.audit_logs SET metadata=${value}::jsonb WHERE id=${row.id}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    }
    await metadata('{}');
    try {
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
    } finally {
      await metadata(row.metadata);
    }
    expect(await store.purgeNext(lease)).toEqual({ purgedRows: 0, hasMore: false });
    expect((await facts(lease)).likes).toBeNull();
  });
});
