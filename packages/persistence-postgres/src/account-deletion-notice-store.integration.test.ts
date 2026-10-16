import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import type { PrepareAccountModerationActionCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportFixtureAdmin, createReportUser } from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';
import { PostgresNotificationStore } from './notification-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionNoticeStore } from './account-deletion-notice-store.js';
import { PostgresAccountDeletionTransportStore } from './account-deletion-transport-store.js';
import { PostgresModerationIntegrityMetricsStore } from './moderation-integrity-metrics-store.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';
import { PostgresMediaDeliveryAuthorization } from './media-delivery-authorization.js';
import { PostgresAccountDeletionPhotoStore } from './account-deletion-photo-store.js';
import { PostgresNotificationDeliveryStore } from './notification-delivery-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Scene = Readonly<{
  lease: AccountDeletionLease;
  noticeId: string;
  other: string;
  otherNotice: string;
  grantId?: string;
}>;
describe.skipIf(url === undefined)('M8 owned notice archival and original safety facts', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore, store: PostgresAccountDeletionNoticeStore;
  let admin: Awaited<ReturnType<typeof confirmationFixture>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_notice_archive');
    const temporaryRoot = resolve(tmpdir()),
      directory = resolve(await mkdtemp(join(temporaryRoot, 'm8-notice122-')));
    if (!directory.startsWith(`${temporaryRoot}${sep}`))
      throw Error('Unsafe migration temporary path');
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 122)
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
    const adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_at: null,
        revoked_by_admin_id: null,
      })
      .execute();
    admin = await confirmationFixture(database, adminId);
    const legacy = await createReportUser(database, true);
    await preferences(legacy);
    const action = await restrict(legacy);
    const before = (
      await sql`SELECT jsonb_build_object('action',(SELECT to_jsonb(r) FROM moderation.moderation_actions r WHERE id=${action}::uuid),
      'notice',(SELECT to_jsonb(r) FROM notification.notifications r JOIN moderation.moderation_actions a ON a.notification_id=r.id WHERE a.id=${action}::uuid)) AS facts`.execute(
        database,
      )
    ).rows;
    const upgrades = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(upgrades.flatMap((r) => r.applied)).toEqual([
      '000123_m8_notification_references.sql',
      '000124_m8_notification_archival.sql',
      '000125_m8_owned_transport_batches.sql',
      '000126_m8_operational_outbox_cancellation.sql',
      '000127_m8_product_checkpoint.sql',
      '000128_m8_product_fence_lock_order.sql',
      '000129_m8_account_media_provider_work.sql',
      '000130_m8_media_checkpoint.sql',
      '000131_m8_private_photo_parallel_read.sql',
      '000132_m8_sample_source_cleanup.sql',
      '000133_m8_liked_by_request_life.sql',
      '000134_m7_account_action_proof_index.sql',
      '000135_m8_deletion_sessions.sql',
      '000136_m8_ephemeral_checkpoint.sql',
      '000137_m8_retention_manifest.sql',
      '000138_m8_final_verification.sql',
      '000139_m8_account_control.sql',
      '000140_m8_deletion_localization.sql',
      '000141_m8_return_approval.sql',
      '000142_m8_fresh_account_return.sql',
      '000143_m8_return_localization.sql',
      '000144_m8_fresh_entry_localization.sql',
      '000145_m8_retention_policy.sql',
      '000146_m8_retained_source_membership.sql',
      '000147_m8_support_content_release.sql',
      '000148_m8_protected_profile_change_lives.sql',
      '000149_m8_live_retained_safety_holds.sql',
      '000150_m8_batched_photo_sources.sql',
    ]);
    expect(
      (
        await sql`SELECT jsonb_build_object('action',(SELECT to_jsonb(r) FROM moderation.moderation_actions r WHERE id=${action}::uuid),
      'notice',(SELECT to_jsonb(r) FROM notification.notifications r JOIN moderation.moderation_actions a ON a.notification_id=r.id WHERE a.id=${action}::uuid)) AS facts`.execute(
          database,
        )
      ).rows,
    ).toEqual(before);
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    work = new PostgresAccountDeletionWorkStore(database);
    store = new PostgresAccountDeletionNoticeStore(database);
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
  async function preferences(userId: string): Promise<void> {
    await sql`INSERT INTO notification.notification_preferences(user_id,created_at,updated_at)
    VALUES(${userId}::uuid,clock_timestamp(),clock_timestamp()) ON CONFLICT(user_id) DO NOTHING`.execute(
      database,
    );
  }
  async function restrict(userId: string): Promise<string> {
    const account = await database
      .selectFrom('identity.accounts')
      .select('version')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    const workflow = new PostgresConfirmedAccountActions(database, admin.tokens, admin.key);
    const command: PrepareAccountModerationActionCommand = {
      actor: admin.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      commandType: 'moderation.apply-account-action',
      schemaVersion: 1,
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        action: 'restrict_user',
        reason: 'Original deletion safety fixture',
        expectedTargetVersion: account.version,
        adminActionToken: await admin.issue({
          commandCode: 'moderation.apply-account-action',
          requiredPermission: 'restrict_user',
          targetType: 'user',
          targetId: userId,
          expectedTargetVersion: account.version,
        }),
      },
    };
    expect(
      (
        await workflow.execute(
          {
            ...command,
            data: {
              ...command.data,
              confirmationToken: await workflow.prepare(command, admin.actor),
            },
          },
          admin.actor,
        )
      ).result,
    ).toBe('succeeded');
    return (
      await database
        .selectFrom('moderation.moderation_actions')
        .select('id')
        .where('command_id', '=', command.commandId)
        .executeTakeFirstOrThrow()
    ).id;
  }
  async function claim(leaseMs = 120000): Promise<AccountDeletionLease> {
    const claims = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs });
    expect(claims).toHaveLength(1);
    return claims[0]!;
  }
  async function scene(safety = false, media = false): Promise<Scene> {
    const other = await createReportUser(database, true);
    await preferences(other);
    const notices = new PostgresNotificationStore(database);
    const otherNotice = (
      await notices.record({
        userId: other,
        type: 'safety_notice',
        titleKey: 'notification.safety_notice.title',
        bodyKey: 'notification.safety_notice.body',
        payload: { privateText: 'Survivor message' },
        deduplicationKey: randomUUID(),
        correlationId: randomUUID(),
        causationId: randomUUID(),
      })
    ).notificationId;
    let noticeId = '';
    let grantId: string | undefined;
    const item = await createDeletionFixture(database, async (owner) => {
      await preferences(owner);
      if (media) {
        const source = await createMediaAuthorityFixture(database, 'owner_preview', owner);
        grantId = (
          await new PostgresMediaDeliveryAuthorization(database, 'test').authorize({
            actor: { kind: 'user', userId: owner },
            photoId: source.photoId,
            purpose: 'owner_preview',
            requestedVariant: 'thumbnail',
          })
        ).authorityId;
      }
      if (safety) {
        const action = await restrict(owner);
        noticeId = (
          await database
            .selectFrom('moderation.moderation_actions')
            .select('notification_id')
            .where('id', '=', action)
            .executeTakeFirstOrThrow()
        ).notification_id!;
      } else
        noticeId = (
          await notices.record({
            userId: owner,
            type: 'safety_notice',
            titleKey: 'notification.safety_notice.title',
            bodyKey: 'notification.safety_notice.body',
            payload: { privateText: 'Permanently remove this body' },
            deduplicationKey: randomUUID(),
            correlationId: randomUUID(),
            causationId: randomUUID(),
          })
        ).notificationId;
    });
    const checkpoints = new PostgresAccountDeletionCheckpointStore(database),
      shared = await claim();
    await checkpoints.finishShared(shared);
    const evidence = await claim();
    if (media)
      while (
        (await new PostgresAccountDeletionPhotoStore(database).archiveNext(evidence)).hasMore
      ) {
        /* Resume bounded photo removal. */
      }
    await new PostgresAccountDeletionProfileStore(database).archive(evidence);
    await checkpoints.finishEvidence(evidence);
    const lease = await claim();
    expect(lease.deletionRecordId).toBe(item.recordId);
    return { lease, noticeId, other, otherNotice, ...(grantId === undefined ? {} : { grantId }) };
  }
  async function preserved(item: Scene): Promise<unknown> {
    return (
      await sql`SELECT jsonb_build_object(
    'account',(SELECT to_jsonb(r) FROM identity.accounts r WHERE user_id=${item.lease.userId}::uuid),
    'root',(SELECT to_jsonb(r) FROM identity.account_deletion_records r WHERE id=${item.lease.deletionRecordId}::uuid),
    'preview',(SELECT to_jsonb(r) FROM identity.guest_preview_counters r WHERE user_id=${item.lease.userId}::uuid),
    'survivor',(SELECT to_jsonb(r) FROM notification.notifications r WHERE id=${item.otherNotice}::uuid),
    'actions',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM moderation.moderation_actions r WHERE target_user_id=${item.lease.userId}::uuid)) AS facts`.execute(
        database,
      )
    ).rows;
  }
  it('removes private body/delivery exactly once under twenty retries and preserves the counterpart/root/preview', async () => {
    const item = await scene(),
      before = await preserved(item);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.purgeNext(item.lease)),
    );
    expect(results.reduce((n, r) => n + r.purgedRows, 0)).toBe(1);
    expect(results.every((r) => !r.hasMore && !r.waitingForDelivery)).toBe(true);
    expect(await preserved(item)).toEqual(before);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM notification.notifications WHERE id=${item.noticeId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM notification.notification_deliveries WHERE notification_id=${item.noticeId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    const reference = (
      await sql<
        Record<string, unknown>
      >`SELECT * FROM notification.notice_reference_anchors WHERE id=${item.noticeId}::uuid`.execute(
        database,
      )
    ).rows[0]!;
    expect(Object.keys(reference).sort()).toEqual([
      'empty_payload',
      'id',
      'notification_type',
      'product_epoch',
      'threshold_episode_id',
      'user_id',
    ]);
    expect(reference.empty_payload).toBe(false);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_notice_receipts WHERE notice_id=${item.noticeId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE subject_id=${item.lease.deletionRecordId}::uuid AND event_type='account.deletion-notice-batch.v1'`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it('preserves actual MFA-authorized restriction history and exact safety metrics after its notice body is gone', async () => {
    const item = await scene(true),
      before = await preserved(item),
      metrics = new PostgresModerationIntegrityMetricsStore(database),
      counts = (await metrics.measure()).counts;
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
    expect((await metrics.measure()).counts).toEqual(counts);
    expect(await preserved(item)).toEqual(before);
    expect(
      (
        await sql`SELECT user_id,notification_type,empty_payload FROM notification.archived_notice_facts WHERE id=${item.noticeId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      { user_id: item.lease.userId, notification_type: 'restriction_warning', empty_payload: true },
    ]);
  });
  it.each(['receipt', 'audit', 'event', 'body'] as const)(
    'rolls back a suppressed required %s and resumes exactly once',
    async (kind) => {
      const item = await scene(),
        table = {
          receipt: 'identity.account_deletion_notice_receipts',
          audit: 'platform.audit_logs',
          event: 'platform.outbox_events',
          body: 'notification.notifications',
        }[kind];
      await sql`CREATE FUNCTION identity.m8_notice_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
        database,
      );
      await sql
        .raw(
          `CREATE TRIGGER a_m8_notice_suppress BEFORE ${kind === 'body' ? 'DELETE' : 'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_notice_suppress()`,
        )
        .execute(database);
      try {
        await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
        expect(
          (
            await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_notice_receipts WHERE notice_id=${item.noticeId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ count: 0 }]);
        expect(
          (
            await sql`SELECT count(*)::integer AS count FROM notification.notifications WHERE id=${item.noticeId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ count: 1 }]);
      } finally {
        await sql.raw(`DROP TRIGGER a_m8_notice_suppress ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_notice_suppress()`.execute(database);
      }
      expect(await store.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
    },
  );
  it('rejects direct deletion, borrowed identity/root/owner/generation and immutable reference reassignment', async () => {
    const item = await scene();
    await expect(
      sql`DELETE FROM notification.notifications WHERE id=${item.noticeId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    for (const lease of [
      { ...item.lease, userId: item.other },
      { ...item.lease, deletionRecordId: randomUUID() },
      { ...item.lease, leaseOwner: randomUUID() },
      { ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 },
    ])
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ status: 409 });
    await store.purgeNext(item.lease);
    await expect(
      sql`UPDATE notification.notice_reference_anchors SET user_id=${item.other}::uuid WHERE id=${item.noticeId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`DELETE FROM notification.notice_reference_anchors WHERE id=${item.noticeId}::uuid`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      sql`INSERT INTO notification.notifications(id,user_id,notification_type,category,title_key,body_key)
      VALUES(${item.noticeId}::uuid,${item.lease.userId}::uuid,'safety_notice','safety','notification.safety_notice.title','notification.safety_notice.body')`.execute(
        database,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('waits for a live delivery lease and resumes after its fenced release', async () => {
    const item = await scene(),
      worker = 'notice-delivery-fixture';
    const delivery = await database
      .selectFrom('notification.notification_deliveries')
      .select('id')
      .where('notification_id', '=', item.noticeId)
      .executeTakeFirstOrThrow();
    const claims = await new PostgresNotificationDeliveryStore(database).claimDue({
      workerId: worker,
      limit: 100,
      leaseMs: 60000,
    });
    expect(claims.some((claim) => claim.deliveryId === delivery.id)).toBe(true);
    expect(await store.purgeNext(item.lease)).toEqual({
      purgedRows: 0,
      hasMore: true,
      waitingForDelivery: true,
    });
    await sql`UPDATE notification.notification_deliveries SET lease_owner=NULL,lease_expires_at=NULL,version=version+1,updated_at=clock_timestamp() WHERE notification_id=${item.noticeId}::uuid`.execute(
      database,
    );
    expect(await store.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
  });
  it('denies empty replay and historical safety facts after removal proof is physically lost', async () => {
    const item = await scene(true);
    await store.purgeNext(item.lease);
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`DELETE FROM identity.account_deletion_notice_receipts WHERE notice_id=${item.noticeId}::uuid`.execute(
        tx,
      );
    });
    await expect(store.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await sql`SELECT id FROM notification.archived_notice_facts WHERE id=${item.noticeId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
  });
  it('rolls back genuine deferred commit expiry and requires a new worker generation', async () => {
    const item = await scene();
    await work.release(item.lease);
    const lease = await claim(2000);
    await sql`CREATE FUNCTION identity.m8_notice_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.1); RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER aaa_m8_notice_pause AFTER INSERT ON identity.account_deletion_notice_receipts DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION identity.m8_notice_pause()`.execute(database);
    try {
      await expect(store.purgeNext(lease)).rejects.toMatchObject({ status: 409 });
    } finally {
      await sql`DROP TRIGGER aaa_m8_notice_pause ON identity.account_deletion_notice_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.m8_notice_pause()`.execute(database);
    }
    const next = await claim();
    expect(next.leaseGeneration).toBe(lease.leaseGeneration + 1);
    expect(await store.purgeNext(next)).toMatchObject({ purgedRows: 1, hasMore: false });
  });
  async function cache(userId: string, count = 1): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    await database
      .insertInto('platform.idempotency_records')
      .values(
        ids.map((id) => ({
          id,
          actor_user_id: userId,
          scope: 'chat.send-message',
          idempotency_key: id,
          request_hash: 'a'.repeat(64),
          status: 'completed' as const,
          response_json: { privateText: 'Remove the cached body' },
          expires_at: new Date(Date.now() + 86400000),
          created_at: new Date(),
          updated_at: new Date(),
        })),
      )
      .execute();
    return ids;
  }
  it('removes 205 own cached bodies and the system-owned registration response in bounded concurrent drains', async () => {
    const item = await scene();
    await cache(item.lease.userId, 205);
    const others = await cache(item.other, 3),
      transport = new PostgresAccountDeletionTransportStore(database);
    const batches = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const counts: number[] = [];
        let result;
        do {
          result = await transport.purgeNext(item.lease);
          counts.push(result.purgedRows);
        } while (result.hasMore);
        return counts;
      }),
    );
    expect(batches.flat().reduce((n, count) => n + count, 0)).toBe(206);
    expect(batches.flat().every((count) => count <= 100)).toBe(true);
    expect(
      (
        await database
          .selectFrom('platform.idempotency_records')
          .select('id')
          .where('id', 'in', others)
          .execute()
      ).length,
    ).toBe(3);
    expect(
      (
        await sql`SELECT id FROM platform.idempotency_records WHERE actor_user_id=${item.lease.userId}::uuid
      OR (scope='identity.register-telegram-identity' AND response_json#>>'{context,userId}'=${item.lease.userId})`.execute(
          database,
        )
      ).rows,
    ).toEqual([]);
    expect(await transport.purgeNext(item.lease)).toEqual({
      purgedRows: 0,
      hasMore: false,
      waitingForExpiry: false,
    });
  });
  it.each(['audit', 'event'] as const)(
    'requires the transport %s and rolls back erased response bodies when suppressed',
    async (kind) => {
      const item = await scene(),
        ids = await cache(item.lease.userId),
        transport = new PostgresAccountDeletionTransportStore(database),
        table = kind === 'audit' ? 'platform.audit_logs' : 'platform.outbox_events';
      await sql`CREATE FUNCTION identity.m8_transport_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
        database,
      );
      await sql
        .raw(
          `CREATE TRIGGER a_m8_transport_suppress BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_transport_suppress()`,
        )
        .execute(database);
      try {
        await expect(transport.purgeNext(item.lease)).rejects.toMatchObject({ status: 409 });
        expect(
          (
            await database
              .selectFrom('platform.idempotency_records')
              .select('id')
              .where('id', 'in', ids)
              .execute()
          ).length,
        ).toBe(1);
      } finally {
        await sql.raw(`DROP TRIGGER a_m8_transport_suppress ON ${table}`).execute(database);
        await sql`DROP FUNCTION identity.m8_transport_suppress()`.execute(database);
      }
      expect(await transport.purgeNext(item.lease)).toMatchObject({
        purgedRows: 2,
        hasMore: false,
      });
    },
  );
  it('does not invert a live command response lock ahead of its User/Account and resumes after release', async () => {
    const item = await scene(),
      [id] = await cache(item.lease.userId),
      transport = new PostgresAccountDeletionTransportStore(database);
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
    const command = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('id', '=', id!)
        .forUpdate()
        .executeTakeFirstOrThrow();
      locked();
      await barrier;
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', item.lease.userId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
    });
    await ready;
    try {
      expect(await transport.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: true });
    } finally {
      release();
      await command;
    }
    expect(await transport.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
  });
  it('keeps an unexpired original media authority fenced and removes it only after its expiry', async () => {
    const item = await scene(false, true),
      transport = new PostgresAccountDeletionTransportStore(database);
    expect(await transport.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: true });
    expect(await transport.purgeNext(item.lease)).toEqual({
      purgedRows: 0,
      hasMore: true,
      waitingForExpiry: true,
    });
    await expect(
      sql`DELETE FROM media.delivery_grants WHERE id=${item.grantId}::uuid`.execute(database),
    ).rejects.toMatchObject({ code: '55000' });
    // Isolated clock fixture preserves the grant's exact duration. No TTL or
    // production admission/expiry guard is changed.
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE media.delivery_grants SET issued_at=issued_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes' WHERE id=${item.grantId}::uuid`.execute(
        tx,
      );
    });
    expect(await transport.purgeNext(item.lease)).toMatchObject({ purgedRows: 1, hasMore: false });
  });
  it('rechecks the post-product checkpoint after a real committing Account lock wait', async () => {
    const item = await scene();
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        locked = resolve;
      });
    const advance = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.accounts')
        .select('user_id')
        .where('user_id', '=', item.lease.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      // Only this isolated fixture models a later checkpoint. Production phase
      // advance remains unavailable until the whole-product verifier exists.
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await sql`UPDATE identity.account_deletion_records SET phase='media_objects',checkpoint_version=4 WHERE id=${item.lease.deletionRecordId}::uuid`.execute(
        tx,
      );
      await sql`UPDATE identity.account_deletion_work SET phase='media_objects',checkpoint_version=4 WHERE deletion_record_id=${item.lease.deletionRecordId}::uuid`.execute(
        tx,
      );
      locked();
      await barrier;
    });
    await ready;
    const attempt = new PostgresNotificationStore(database).record({
      userId: item.lease.userId,
      type: 'safety_notice',
      titleKey: 'notification.safety_notice.title',
      bodyKey: 'notification.safety_notice.body',
      payload: {},
      deduplicationKey: randomUUID(),
      correlationId: randomUUID(),
      causationId: randomUUID(),
    });
    const rejected = expect(attempt).rejects.toMatchObject({ code: '40001' });
    try {
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        waiting = (
          await sql<{
            waiting: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event_type='Lock' AND query ILIKE '%insert%notification%') AS waiting`.execute(
            database,
          )
        ).rows[0]!.waiting;
        if (!waiting) await delay(20);
      }
      expect(waiting).toBe(true);
    } finally {
      release();
      await advance;
    }
    await rejected;
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM notification.notifications WHERE user_id=${item.lease.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
});
