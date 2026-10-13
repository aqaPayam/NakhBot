import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease, SpendCreditsForPaidActionWrite } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportChat,
  createReportLike,
  createReportPhoto,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresAccountDeletionMatchStore } from './account-deletion-match-store.js';
import { PostgresAccountDeletionPhotoStore } from './account-deletion-photo-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionReferencedLikeStore } from './account-deletion-referenced-like-store.js';
import { PostgresAccountDeletionOwnedUnlockStore } from './account-deletion-unlock-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresPaidActionStore } from './paid-action-store.js';
import { PostgresFundingStore } from './funding-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Scene = Readonly<{
  lease: AccountDeletionLease;
  unlockId: string;
  payer: string;
  other: string;
  sourceId: string;
  creditReplay: SpendCreditsForPaidActionWrite | undefined;
  starsReplay:
    Parameters<PostgresTelegramStarsReceiptStore['fulfillDirectPaidAction']>[0] | undefined;
}>;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
describe.skipIf(url === undefined)(
  'M8 original owned unlock removal and financial identity',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionOwnedUnlockStore;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_unlock_archive');
      const temporaryRoot = resolve(tmpdir()),
        directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-unlock118-')));
      if (!directory.startsWith(`${temporaryRoot}${sep}`))
        throw new Error('Unsafe migration temporary path');
      try {
        for (const file of await readdir(resolve('migrations')))
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 118)
            await copyFile(join(resolve('migrations'), file), join(directory, file));
        await runMigrations(isolated.url, directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const payer = await createReportUser(database, true),
        sender = await createReportUser(database, true);
      await prepare(payer);
      await prepare(sender);
      const likeId = await createReportLike(database, payer, sender);
      await new PostgresCreditLedgerStore(database).append({
        transactionId: randomUUID(),
        userId: payer,
        transactionType: 'admin_adjustment',
        amount: 10n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const legacy = await new PostgresPaidActionStore(database).spendCredits({
        userId: payer,
        target: { type: 'like', targetId: likeId },
        featureUnlockId: randomUUID(),
        creditTransactionId: randomUUID(),
        outboxEventId: randomUUID(),
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      async function legacyFacts(): Promise<unknown> {
        return (
          await sql`SELECT jsonb_build_object(
        'grant',(SELECT to_jsonb(r) FROM interaction.feature_unlocks r WHERE id=${legacy.id}::uuid),
        'credits',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.credit_transactions r),
        'balances',(SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id) FROM billing.credit_accounts r),
        'like',(SELECT to_jsonb(r) FROM interaction.likes r WHERE id=${likeId}::uuid)) AS facts`.execute(
            database,
          )
        ).rows;
      }
      const before = await legacyFacts();
      const migrations = await Promise.all(
        Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
      );
      expect(migrations.flatMap((result) => result.applied)).toEqual([
        '000119_m8_unlock_original_references.sql',
        '000120_m8_owned_unlock_archival.sql',
        '000121_m8_match_original_lives.sql',
        '000122_m8_pair_archival.sql',
        '000123_m8_notification_references.sql',
        '000124_m8_notification_archival.sql',
        '000125_m8_owned_transport_batches.sql',
        '000126_m8_operational_outbox_cancellation.sql',
        '000127_m8_product_checkpoint.sql',
        '000128_m8_product_fence_lock_order.sql',
        '000129_m8_account_media_provider_work.sql',
        '000130_m8_media_checkpoint.sql',
      ]);
      expect(await legacyFacts()).toEqual(before);
      expect(
        (
          await sql`SELECT payer_user_id,payer_product_epoch,like_id FROM interaction.feature_unlock_reference_anchors WHERE id=${legacy.id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ payer_user_id: payer, payer_product_epoch: 0, like_id: likeId }]);
      expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
        '000120_m8_owned_unlock_archival.sql',
      );
      work = new PostgresAccountDeletionWorkStore(database);
      store = new PostgresAccountDeletionOwnedUnlockStore(database);
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
    async function prepare(userId: string): Promise<void> {
      const at = new Date();
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
      await database
        .insertInto('identity.telegram_identities')
        .values({
          user_id: userId,
          telegram_user_id: String(
            1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000),
          ),
          username: null,
          first_seen_at: at,
          last_seen_at: at,
        })
        .onConflict((c) => c.column('user_id').doNothing())
        .execute();
    }
    async function scene(
      funding: 'credits' | 'stars' = 'credits',
      kind: 'like' | 'match' = 'like',
      deletedPayer = true,
    ): Promise<Scene> {
      const other = await createReportUser(database, true);
      await prepare(other);
      let payer = '',
        unlockId = '',
        sourceId = '',
        creditReplay: Scene['creditReplay'],
        starsReplay: Scene['starsReplay'];
      const receipts = new PostgresTelegramStarsReceiptStore(
        database,
        { uuid: randomUUID },
        { digest },
      );
      const item = await createDeletionFixture(database, async (owner) => {
        const template = await database
          .selectFrom('profile.profiles')
          .selectAll()
          .where('user_id', '=', other)
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
        payer = deletedPayer ? owner : other;
        if (kind === 'like')
          sourceId = await createReportLike(database, payer, deletedPayer ? other : owner);
        else {
          sourceId = (await createReportChat(database, owner, other)).matchId;
          const [low, high] = [owner, other].sort() as [string, string];
          await database
            .insertInto('interaction.user_pair_states')
            .values({
              user_low_id: low,
              user_high_id: high,
              state: 'matched',
              reason_code: 'match',
              changed_at: new Date(),
            })
            .execute();
        }
        const target = { type: kind, targetId: sourceId };
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
            target,
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
            target,
            idempotencyKey: randomUUID(),
          });
          const attempt = await fundingStore.prepareStarsAttempt({
            paymentRecordId: randomUUID(),
            fundingIntentId: intent.id,
            userId: payer,
            expectedVersion: 1,
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
          const telegram = await database
              .selectFrom('identity.telegram_identities')
              .select('telegram_user_id')
              .where('user_id', '=', payer)
              .executeTakeFirstOrThrow(),
            event = randomUUID();
          expect(
            await receipts.recordSuccessfulPayment({
              providerEventId: event,
              telegramUserId: telegram.telegram_user_id,
              invoicePayload: cleartext,
              currency: 'XTR',
              totalAmount: attempt.starsAmount,
              providerEnvironment: 'test',
              providerBotIdDigest: botDigest,
              telegramChargeId: `telegram:${randomUUID()}`,
              evidence: {
                digest: digest(event),
                ciphertext: randomBytes(64),
                keyId: 'provider-v1',
                schemaVersion: 1,
              },
            }),
          ).toMatchObject({ outcome: 'receipt_recorded' });
          const worker = `m8-unlock:${randomUUID()}`,
            claimed = (
              await receipts.claimFulfillments({ owner: worker, leaseMs: 120000, limit: 100 })
            ).find((row) => row.paymentRecordId === attempt.paymentRecordId)!;
          starsReplay = {
            paymentRecordId: attempt.paymentRecordId,
            owner: worker,
            fenceToken: claimed.fenceToken,
            featureUnlockId: randomUUID(),
            refundRecordId: randomUUID(),
            featureUnlockedEventId: randomUUID(),
            paymentTerminalEventId: randomUUID(),
          };
          expect(await receipts.fulfillDirectPaidAction(starsReplay)).toMatchObject({
            outcome: 'fulfilled',
          });
          unlockId = starsReplay.featureUnlockId;
        }
      });
      const checkpoints = new PostgresAccountDeletionCheckpointStore(database),
        shared = await claim(),
        closure = new PostgresAccountDeletionSharedStore(database);
      while ((await closure.closeNext(shared)).hasMore) {
        /* Resume exact pair closures. */
      }
      await checkpoints.finishShared(shared);
      const evidence = await claim();
      const chats = new PostgresAccountDeletionChatStore(database);
      while ((await chats.archiveNext(evidence)).hasMore) {
        /* Captured ordinary sources only. */
      }
      const matches = new PostgresAccountDeletionMatchStore(database);
      while ((await matches.archiveNext(evidence)).hasMore) {
        /* Match proof survives. */
      }
      const photos = new PostgresAccountDeletionPhotoStore(database);
      while ((await photos.archiveNext(evidence)).hasMore) {
        /* Exact source/hold checks. */
      }
      expect(
        await new PostgresAccountDeletionProfileStore(database).archive(evidence),
      ).toMatchObject({ archived: true });
      await checkpoints.finishEvidence(evidence);
      const lease = await claim();
      expect(lease.deletionRecordId).toBe(item.recordId);
      return { lease, unlockId, payer, other, sourceId, creditReplay, starsReplay };
    }
    async function facts(item: Scene): Promise<Record<string, unknown>> {
      return (
        await sql<{ facts: Record<string, unknown> }>`SELECT jsonb_build_object(
      'body',(SELECT to_jsonb(r) FROM interaction.feature_unlocks r WHERE id=${item.unlockId}::uuid),
      'account',(SELECT to_jsonb(r) FROM identity.accounts r WHERE user_id=${item.lease.userId}::uuid),
      'root',(SELECT to_jsonb(r) FROM identity.account_deletion_records r WHERE id=${item.lease.deletionRecordId}::uuid),
      'preview',(SELECT to_jsonb(r) FROM identity.guest_preview_counters r WHERE user_id=${item.lease.userId}::uuid),
      'reference',(SELECT to_jsonb(r) FROM interaction.feature_unlock_reference_anchors r WHERE id=${item.unlockId}::uuid),
      'credits',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.credit_transactions r),
      'balances',(SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id) FROM billing.credit_accounts r),
      'payments',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.payment_records r),
      'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY payment_record_id) FROM billing.telegram_stars_receipts r),
      'refunds',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM billing.refund_records r),
      'proof',(SELECT to_jsonb(r) FROM identity.account_deletion_unlock_receipts r WHERE unlock_id=${item.unlockId}::uuid),
      'audits',(SELECT count(*) FROM platform.audit_logs WHERE subject_id=${item.lease.deletionRecordId}::uuid AND event_type='account.deletion-unlock-batch.v1'),
      'events',(SELECT count(*) FROM platform.outbox_events WHERE aggregate_id=${item.lease.deletionRecordId}::uuid AND event_type='account.deletion-unlock-batch.v1')) AS facts`.execute(
          database,
        )
      ).rows[0]!.facts;
    }
    it.each([
      ['credits', 'like'],
      ['stars', 'like'],
      ['credits', 'match'],
      ['stars', 'match'],
    ] as const)(
      'removes a genuine owned %s %s unlock once under twenty retries and preserves financial history/replay',
      async (funding, kind) => {
        const item = await scene(funding, kind),
          before = await facts(item);
        const results = await Promise.all(
          Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
        );
        expect(results.filter((row) => row.purgedRows === 1)).toHaveLength(1);
        const after = await facts(item);
        expect(after).toMatchObject({ body: null, audits: 1, events: 1 });
        for (const key of [
          'account',
          'root',
          'preview',
          'reference',
          'credits',
          'balances',
          'payments',
          'receipts',
          'refunds',
        ])
          expect(after[key]).toEqual(before[key]);
        expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
        if (item.creditReplay)
          await expect(
            new PostgresPaidActionStore(database).spendCredits(item.creditReplay),
          ).rejects.toMatchObject({ code: 'unlock_unavailable' });
        if (item.starsReplay) {
          const callbacks = await Promise.all(
            Array.from({ length: 20 }, () =>
              new PostgresTelegramStarsReceiptStore(
                database,
                { uuid: randomUUID },
                { digest },
              ).fulfillDirectPaidAction(item.starsReplay!),
            ),
          );
          expect(callbacks.every((row) => row.outcome === 'fulfilled' && row.replayed)).toBe(true);
        }
        expect((await facts(item)).credits).toEqual(before.credits);
        // Like dependencies can be removed after the grant; no cyclic authority.
        const likes = new PostgresAccountDeletionReferencedLikeStore(database);
        while ((await likes.purgeNext(item.lease)).hasMore) {
          /* Bounded original references. */
        }
        expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
      },
    );
    it.each(['like', 'match'] as const)(
      "preserves the other payer's %s financial history and keeps the grant ineffective",
      async (kind) => {
        const item = await scene('credits', kind, false),
          before = await facts(item);
        expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
        expect(await facts(item)).toEqual(before);
        expect((before.body as { status: string }).status).toBe('revoked');
      },
    );
    it.each(['receipt', 'audit', 'event', 'source'] as const)(
      'rolls back missing %s and retries exactly once',
      async (kind) => {
        const item = await scene(),
          before = await facts(item),
          table = {
            receipt: 'identity.account_deletion_unlock_receipts',
            audit: 'platform.audit_logs',
            event: 'platform.outbox_events',
            source: 'interaction.feature_unlocks',
          }[kind];
        await sql
          .raw(
            `CREATE FUNCTION public.m8_unlock_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${kind === 'audit' || kind === 'event' ? "IF NEW.event_type<>'account.deletion-unlock-batch.v1' THEN RETURN NEW; END IF;" : ''} RETURN NULL; END $$`,
          )
          .execute(database);
        await sql
          .raw(
            `CREATE TRIGGER aaa_m8_unlock_suppress BEFORE ${kind === 'source' ? 'DELETE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION public.m8_unlock_suppress()`,
          )
          .execute(database);
        try {
          await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
          expect(await facts(item)).toEqual(before);
        } finally {
          await sql.raw(`DROP TRIGGER aaa_m8_unlock_suppress ON ${table}`).execute(database);
          await sql`DROP FUNCTION public.m8_unlock_suppress()`.execute(database);
        }
        expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 1, hasMore: false });
      },
    );
    it('denies borrowed authority and ordinary deletion without changing private or financial facts', async () => {
      const item = await scene(),
        before = await facts(item);
      for (const lease of [
        { ...item.lease, userId: item.other },
        { ...item.lease, deletionRecordId: randomUUID() },
        { ...item.lease, leaseOwner: randomUUID() },
        { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
      ])
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        database
          .deleteFrom('interaction.feature_unlocks')
          .where('id', '=', item.unlockId)
          .execute(),
      ).rejects.toMatchObject({ code: '55000' });
      expect(await facts(item)).toEqual(before);
    });
    it('keeps the original reference immutable and denies retired unlock identity reuse', async () => {
      const item = await scene(),
        body = await database
          .selectFrom('interaction.feature_unlocks')
          .selectAll()
          .where('id', '=', item.unlockId)
          .executeTakeFirstOrThrow();
      await store.purgeNext(item.lease);
      await expect(
        sql`UPDATE interaction.feature_unlock_reference_anchors SET payer_product_epoch=payer_product_epoch+1 WHERE id=${item.unlockId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        sql`DELETE FROM interaction.feature_unlock_reference_anchors WHERE id=${item.unlockId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        database.insertInto('interaction.feature_unlocks').values(body).execute(),
      ).rejects.toMatchObject({ code: '23514' });
      expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    });
    it('finishes a real paid insert while a counter-first writer waits on its pair without acquiring that counter late', async () => {
      const payer = await createReportUser(database, true),
        sender = await createReportUser(database, true);
      await prepare(payer);
      await prepare(sender);
      const likeId = await createReportLike(database, payer, sender);
      await new PostgresCreditLedgerStore(database).append({
        transactionId: randomUUID(),
        userId: payer,
        transactionType: 'admin_adjustment',
        amount: 10n,
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      });
      const write: SpendCreditsForPaidActionWrite = {
        userId: payer,
        target: { type: 'like', targetId: likeId },
        featureUnlockId: randomUUID(),
        creditTransactionId: randomUUID(),
        outboxEventId: randomUUID(),
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      };
      await sql`CREATE FUNCTION public.m8_unlock_pair_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(81971,1); RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER aaa_m8_unlock_pair_pause BEFORE INSERT ON interaction.feature_unlocks FOR EACH ROW EXECUTE FUNCTION public.m8_unlock_pair_pause()`.execute(
        database,
      );
      let paid: Promise<Awaited<ReturnType<PostgresPaidActionStore['spendCredits']>>> | undefined,
        nakh: Promise<boolean> | undefined;
      let counterReady: () => void = () => {
        throw new Error('Counter barrier not initialized');
      };
      const ready = new Promise<void>((resolveReady) => {
        counterReady = resolveReady;
      });
      try {
        await database.transaction().execute(async (barrier) => {
          await sql`SELECT pg_advisory_xact_lock(81971,1)`.execute(barrier);
          paid = new PostgresPaidActionStore(database).spendCredits(write);
          void paid.catch(() => undefined);
          const deadline = Date.now() + 10000;
          let waiting = false;
          while (!waiting && Date.now() < deadline) {
            waiting = (
              await sql<{
                waiting: boolean;
              }>`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=81971 AND objid=1 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting`.execute(
                database,
              )
            ).rows[0]!.waiting;
            if (!waiting) await delay(20);
          }
          expect(waiting).toBe(true);
          nakh = database.transaction().execute(async (tx) => {
            await sql`SELECT user_id FROM platform.user_counters WHERE user_id IN (${payer}::uuid,${sender}::uuid) ORDER BY user_id FOR UPDATE`.execute(
              tx,
            );
            counterReady();
            const [low, high] = [payer, sender].sort() as [string, string];
            await sql`SELECT interaction.lock_user_pair(${low}::uuid,${high}::uuid)`.execute(tx);
            return true;
          });
          void nakh.catch(() => undefined);
          await ready;
        });
        const [result, resumed] = await Promise.all([paid!, nakh!]);
        expect(result.id).toBe(write.featureUnlockId);
        expect(resumed).toBe(true);
      } finally {
        if (paid && nakh) await Promise.allSettled([paid, nakh]);
        await sql`DROP TRIGGER aaa_m8_unlock_pair_pause ON interaction.feature_unlocks`.execute(
          database,
        );
        await sql`DROP FUNCTION public.m8_unlock_pair_pause()`.execute(database);
      }
    });
    it('denies damaged original credit life on empty replay and accepts exact repair without restoring access', async () => {
      const item = await scene();
      await store.purgeNext(item.lease);
      const before = await facts(item);
      const original = await database
        .selectFrom('billing.credit_transactions')
        .select(['id', 'product_epoch'])
        .where('id', '=', item.creditReplay!.creditTransactionId)
        .executeTakeFirstOrThrow();
      async function epoch(value: number): Promise<void> {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            await sql`UPDATE billing.credit_transactions SET product_epoch=${value} WHERE id=${original.id}::uuid`.execute(
              connection,
            );
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      await epoch(original.product_epoch + 1);
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        await epoch(original.product_epoch);
      }
      expect(await facts(item)).toEqual(before);
      expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    });
    it('discovers a fulfilled Stars charge even when both original identities were physically lost', async () => {
      const item = await scene('stars');
      await store.purgeNext(item.lease);
      const before = await facts(item);
      const records = (
        await sql<{ anchor: string; receipt: string }>`SELECT
      (SELECT to_jsonb(r)::text FROM interaction.feature_unlock_reference_anchors r WHERE id=${item.unlockId}::uuid) AS anchor,
      (SELECT to_jsonb(r)::text FROM identity.account_deletion_unlock_receipts r WHERE unlock_id=${item.unlockId}::uuid) AS receipt`.execute(
          database,
        )
      ).rows[0]!;
      async function corrupt(restore: boolean): Promise<void> {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (restore) {
              await sql`INSERT INTO interaction.feature_unlock_reference_anchors SELECT * FROM jsonb_populate_record(NULL::interaction.feature_unlock_reference_anchors,${records.anchor}::jsonb)`.execute(
                connection,
              );
              await sql`INSERT INTO identity.account_deletion_unlock_receipts SELECT * FROM jsonb_populate_record(NULL::identity.account_deletion_unlock_receipts,${records.receipt}::jsonb)`.execute(
                connection,
              );
            } else {
              await sql`DELETE FROM identity.account_deletion_unlock_receipts WHERE unlock_id=${item.unlockId}::uuid`.execute(
                connection,
              );
              await sql`DELETE FROM interaction.feature_unlock_reference_anchors WHERE id=${item.unlockId}::uuid`.execute(
                connection,
              );
            }
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      await corrupt(false);
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        await corrupt(true);
      }
      expect(await facts(item)).toEqual(before);
      expect(await store.purgeNext(item.lease)).toEqual({ purgedRows: 0, hasMore: false });
    });
    it('rolls back a genuine deferred commit expiry and resumes under a new generation', async () => {
      const item = await scene();
      await work.release(item.lease);
      const lease = await claim(2000),
        current = { ...item, lease },
        before = await facts(current);
      await sql`CREATE FUNCTION public.m8_unlock_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.1); RETURN NULL; END $$`.execute(
        database,
      );
      await sql`CREATE CONSTRAINT TRIGGER aaa_m8_unlock_pause AFTER INSERT ON identity.account_deletion_unlock_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.m8_unlock_pause()`.execute(
        database,
      );
      try {
        await expect(store.purgeNext(lease)).rejects.toMatchObject({ code: 'conflict' });
        expect(await facts(current)).toEqual(before);
      } finally {
        await sql`DROP TRIGGER aaa_m8_unlock_pause ON identity.account_deletion_unlock_receipts`.execute(
          database,
        );
        await sql`DROP FUNCTION public.m8_unlock_pause()`.execute(database);
      }
      const next = await claim();
      expect(next.leaseGeneration).toBe(lease.leaseGeneration + 1);
      expect(await store.purgeNext(next)).toEqual({ purgedRows: 1, hasMore: false });
    });
  },
);
