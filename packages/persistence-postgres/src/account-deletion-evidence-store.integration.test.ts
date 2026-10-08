import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmChatReportSnapshotProtector,
  AesGcmChatReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
  AesGcmUnmatchedReportSnapshotProtector,
  AesGcmUnmatchedReportSnapshotReader,
  IntegrityMessageReportSnapshotReader,
  ReportTokens,
  type AccountDeletionLease,
  type StoredProfileReportSnapshot,
} from '@nakh/application';
import type { SubmitReportCommand } from '@nakh/contracts';
import {
  resolveUnmatchedReportSource,
  PostgresPrepareUnmatchedReportEvidenceHandler,
} from './unmatched-report-source-store.js';
import { PostgresSubmitUnmatchedReportHandler } from './unmatched-report-submission-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import {
  createReportUser,
  createReportLike,
  createReportChat,
  createReportMessage,
  createReportPhoto,
  createReportUnmatch,
  createReportFixtureAdmin,
} from './testing/report-fixture.js';
import { retainPhotoEvidenceInTransaction } from './photo-evidence-retention-store.js';
import { captureReportedMessagesInTransaction } from './chat-retention-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionSharedStore } from './account-deletion-shared-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionEvidenceStore } from './account-deletion-evidence-store.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountDeletionChatStore } from './account-deletion-chat-store.js';
import { PostgresReportEvidenceRevealStore } from './profile-evidence-reveal-store.js';
import { PostgresDeletionRegistryStore, DELETION_REGISTRY } from './deletion-registry.js';
import type { ReportEvidenceReaders } from './report-capture-integrity.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Kind = 'profile' | 'photo' | 'chat' | 'message' | 'unmatched_user';
describe.skipIf(url === undefined)('M8 fenced Report capture verification', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let work: PostgresAccountDeletionWorkStore;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'nakh_m8_capture');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    work = new PostgresAccountDeletionWorkStore(database);
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
  async function scene(
    kind: Kind,
    missing = false,
    extraMessages = 0,
    unmatchAt?: Date,
  ): Promise<{
    userId: string;
    recordId: string;
    reportId: string;
    evidenceId: string;
    lease: AccountDeletionLease;
    key: Buffer;
    readers: ReportEvidenceReaders;
  }> {
    const reporter = await createReportUser(database, true),
      reportId = randomUUID(),
      evidenceId = randomUUID(),
      key = randomBytes(32);
    const keyId = 'm8-capture-test',
      at = new Date();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: reporter, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: reporter, created_at: at, updated_at: at })
      .execute();
    const fixture = await createDeletionFixture(database, async (owner) => {
      const profile = await database
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', reporter)
        .executeTakeFirstOrThrow();
      const profileId = randomUUID();
      await database
        .insertInto('profile.profiles')
        .values({ ...profile, id: profileId, user_id: owner })
        .execute();
      await sql`UPDATE identity.accounts SET state='active',version=version+1,state_changed_at=clock_timestamp() WHERE user_id=${owner}::uuid`.execute(
        database,
      );
      let reference: string = profileId,
        chatId: string | undefined;
      if (kind === 'profile' || kind === 'photo') await createReportLike(database, reporter, owner);
      if (kind === 'photo') reference = await createReportPhoto(database, owner);
      if (kind === 'chat' || kind === 'message') {
        const chat = await createReportChat(database, reporter, owner);
        chatId = chat.chatSessionId;
        reference =
          kind === 'message' ? await createReportMessage(database, chatId, owner) : chatId;
        for (let index = 0; index < extraMessages; index++)
          await createReportMessage(database, chatId, owner);
      }
      if (kind === 'unmatched_user')
        reference = (await createReportUnmatch(database, reporter, owner, unmatchAt)).matchId;
      await database.transaction().execute(async (tx) => {
        const reason = await tx
          .selectFrom('moderation.report_reasons')
          .select('id')
          .where('code', '=', 'harassment')
          .executeTakeFirstOrThrow();
        const subject = { reportId, evidenceId };
        let capture: StoredProfileReportSnapshot | undefined;
        if (kind === 'profile')
          capture = new AesGcmProfileReportSnapshotProtector(keyId, 1, key).protect(subject, {
            evidenceType: 'profile',
            displayName: 'Synthetic retained profile',
            birthYear: 1990,
          });
        if (kind === 'chat')
          capture = new AesGcmChatReportSnapshotProtector(keyId, 1, key).protect(subject, {
            evidenceType: 'chat',
            chatSessionId: reference,
            status: 'active',
          });
        if (kind === 'photo')
          capture = new AesGcmPhotoReportSnapshotProtector(keyId, 1, key).protect(
            subject,
            await retainPhotoEvidenceInTransaction(tx, { evidenceId, photoId: reference }),
          );
        if (kind === 'unmatched_user') {
          const source = await tx
            .selectFrom('matching.unmatch_records')
            .selectAll()
            .where('match_id', '=', reference)
            .executeTakeFirstOrThrow();
          capture = new AesGcmUnmatchedReportSnapshotProtector(keyId, 1, key).protect(subject, {
            evidenceType: 'unmatched_user',
            unmatchedAt: source.unmatched_at.toISOString(),
            reportWindowExpiresAt: source.report_window_expires_at.toISOString(),
          });
        }
        await tx
          .insertInto('moderation.reports')
          .values({
            id: reportId,
            reporter_user_id: reporter,
            target_user_id: owner,
            reason_id: reason.id,
            status: 'submitted',
            command_id: randomUUID(),
            request_id: randomUUID(),
            idempotency_key: randomUUID(),
            request_digest: '8'.repeat(64),
          })
          .execute();
        await tx
          .insertInto('moderation.report_evidence')
          .values({
            id: evidenceId,
            report_id: reportId,
            evidence_type: kind,
            profile_id: kind === 'profile' ? reference : null,
            profile_photo_id: kind === 'photo' ? reference : null,
            chat_session_id: kind === 'chat' ? reference : null,
            chat_message_id: kind === 'message' ? reference : null,
            unmatch_record_id: kind === 'unmatched_user' ? reference : null,
          })
          .execute();
        if (kind === 'message') {
          if (missing)
            await tx
              .insertInto('chat.chat_message_snapshot_requests')
              .values({
                report_id: reportId,
                chat_session_id: chatId!,
                original_message_id: reference,
              })
              .execute();
          else
            await captureReportedMessagesInTransaction(tx, {
              reportId,
              chatSessionId: chatId!,
              messageIds: [reference],
            });
        } else if (!missing && capture)
          await tx
            .insertInto('moderation.report_snapshots')
            .values({
              id: randomUUID(),
              report_id: reportId,
              report_evidence_id: evidenceId,
              snapshot_type: kind,
              schema_version: capture.schemaVersion,
              encryption_key_id: capture.keyId,
              encryption_key_version: capture.keyVersion,
              nonce: Buffer.from(capture.nonce),
              ciphertext: Buffer.from(capture.ciphertext),
              content_sha256: capture.sha256,
            })
            .execute();
      });
    });
    const shared = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    const closure = new PostgresAccountDeletionSharedStore(database);
    for (let batch = 0; batch < 10; batch++) if (!(await closure.closeNext(shared)).hasMore) break;
    await new PostgresAccountDeletionCheckpointStore(database).finishShared(shared);
    const lease = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    expect(lease.phase).toBe('evidence_capture');
    const keys = {
      resolve: (id: string, version: number): Uint8Array | undefined =>
        id === keyId && version === 1 ? key : undefined,
    };
    return {
      ...fixture,
      reportId,
      evidenceId,
      lease,
      key,
      readers: {
        profile: new AesGcmProfileReportSnapshotReader(keys),
        chat: new AesGcmChatReportSnapshotReader(keys),
        photo: new AesGcmPhotoReportSnapshotReader(keys),
        unmatched_user: new AesGcmUnmatchedReportSnapshotReader(keys),
        message: new IntegrityMessageReportSnapshotReader(),
      },
    };
  }
  async function count(record: string): Promise<number> {
    return (
      await sql`SELECT 1 FROM identity.account_deletion_evidence_receipts WHERE deletion_record_id=${record}::uuid`.execute(
        database,
      )
    ).rows.length;
  }
  async function effects(
    record: string,
  ): Promise<{ receipts: number; audits: number; events: number }> {
    return (
      await sql<{ receipts: number; audits: number; events: number }>`SELECT
      (SELECT count(*)::integer FROM identity.account_deletion_evidence_receipts WHERE deletion_record_id=${record}::uuid) AS receipts,
      (SELECT count(*)::integer FROM platform.audit_logs WHERE subject_id=${record}::uuid AND event_type='account.deletion-evidence-verified.v1') AS audits,
      (SELECT count(*)::integer FROM platform.outbox_events WHERE aggregate_id=${record}::uuid AND event_type='account.deletion-evidence-verified.v1') AS events`.execute(
        database,
      )
    ).rows[0]!;
  }
  it.each(['profile', 'photo', 'chat', 'message', 'unmatched_user'] as const)(
    'authenticates exact %s capture once under twenty-way replay',
    async (kind) => {
      const item = await scene(kind),
        store = new PostgresAccountDeletionEvidenceStore(database, item.readers);
      const before = await database
        .selectFrom('moderation.report_snapshots')
        .selectAll()
        .where('report_id', '=', item.reportId)
        .execute();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.verifyNext(item.lease)),
      );
      expect(results.filter((result) => result.verified)).toHaveLength(1);
      expect(await count(item.recordId)).toBe(1);
      expect(JSON.stringify(results)).not.toContain(item.evidenceId);
      expect(
        await database
          .selectFrom('moderation.report_snapshots')
          .selectAll()
          .where('report_id', '=', item.reportId)
          .execute(),
      ).toEqual(before);
      const events = await database
        .selectFrom('platform.outbox_events')
        .select(['id', 'payload'])
        .where('aggregate_id', '=', item.recordId)
        .where('event_type', '=', 'account.deletion-evidence-verified.v1')
        .execute();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toEqual({
        deletionRecordId: item.recordId,
        kind: 'capture_integrity',
      });
      await sql`DELETE FROM platform.outbox_events WHERE id=${events[0]!.id}::uuid`.execute(
        database,
      );
      expect(await store.verifyNext(item.lease)).toEqual({
        examined: 0,
        verified: false,
        hasMore: false,
      });
      await work.release(item.lease);
      const fresh = (
        await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 })
      )[0]!;
      await expect(store.verifyNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      expect(await store.verifyNext(fresh)).toEqual({
        examined: 0,
        verified: false,
        hasMore: false,
      });
      await expect(
        sql`DELETE FROM identity.account_deletion_evidence_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
          database,
        ),
      ).rejects.toMatchObject({ code: '55000' });
      const root = (
        await sql<{
          phase: string;
          reactivation_allowed: boolean;
        }>`SELECT phase,reactivation_allowed FROM identity.account_deletion_records WHERE id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      expect(root).toEqual({ phase: 'evidence_capture', reactivation_allowed: false });
      item.key.fill(0);
    },
  );
  it('waits for an actual missing capture without inventing a replacement', async () => {
    const item = await scene('profile', true);
    expect(
      await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease),
    ).toEqual({ examined: 1, verified: false, hasMore: true, waitingForCapture: true });
    expect(await count(item.recordId)).toBe(0);
    item.key.fill(0);
  });
  it.each(['profile', 'message'] as const)(
    'keeps the %s capture fingerprint stable across database time zones',
    async (kind) => {
      const item = await scene(kind);
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL TIME ZONE 'UTC'`.execute(tx);
        const first = await sql<{
          fingerprint: string;
        }>`SELECT fingerprint FROM identity.deletion_evidence_capture(${item.evidenceId}::uuid)`.execute(
          tx,
        );
        await sql`SET LOCAL TIME ZONE 'Asia/Tehran'`.execute(tx);
        const second = await sql<{
          fingerprint: string;
        }>`SELECT fingerprint FROM identity.deletion_evidence_capture(${item.evidenceId}::uuid)`.execute(
          tx,
        );
        expect(second.rows).toEqual(first.rows);
        expect(first.rows).toHaveLength(1);
      });
      item.key.fill(0);
    },
  );
  it('rolls back verification if its lease expires during deferred commit checks', async () => {
    const item = await scene('profile');
    await work.release(item.lease);
    const lease = (await work.claimDue({ workerId: randomUUID(), leaseMs: 1000, limit: 1 }))[0]!;
    await sql`CREATE FUNCTION identity.m8_delay_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER a_m8_delay_capture AFTER INSERT ON identity.account_deletion_evidence_receipts
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.m8_delay_capture()`.execute(
      database,
    );
    try {
      await expect(
        new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(lease),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(await count(item.recordId)).toBe(0);
      expect(await effects(item.recordId)).toEqual({ receipts: 0, audits: 0, events: 0 });
    } finally {
      await sql`DROP TRIGGER a_m8_delay_capture ON identity.account_deletion_evidence_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.m8_delay_capture()`.execute(database);
    }
    const fresh = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    expect(
      await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(fresh),
    ).toMatchObject({ verified: true });
    item.key.fill(0);
  });
  it('rejects unavailable keys and forged subject/generation without copying private errors', async () => {
    const item = await scene('profile'),
      store = new PostgresAccountDeletionEvidenceStore(database, item.readers);
    await expect(
      new PostgresAccountDeletionEvidenceStore(database, {}).verifyNext(item.lease),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.verifyNext({ ...item.lease, userId: randomUUID() })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      store.verifyNext({ ...item.lease, leaseGeneration: item.lease.leaseGeneration + 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await count(item.recordId)).toBe(0);
    expect(await effects(item.recordId)).toEqual({ receipts: 0, audits: 0, events: 0 });
    expect(await store.verifyNext(item.lease)).toMatchObject({ verified: true });
    item.key.fill(0);
  });
  it.each([
    'platform.audit_logs',
    'platform.outbox_events',
    'identity.account_deletion_evidence_receipts',
  ])('rolls back a suppressed required write to %s', async (table) => {
    const item = await scene('profile'),
      store = new PostgresAccountDeletionEvidenceStore(database, item.readers);
    await sql`CREATE FUNCTION identity.m8_suppress_capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql
      .raw(
        `CREATE TRIGGER m8_suppress_capture BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_suppress_capture()`,
      )
      .execute(database);
    try {
      await expect(store.verifyNext(item.lease)).rejects.toBeDefined();
      expect(await count(item.recordId)).toBe(0);
    } finally {
      await sql.raw(`DROP TRIGGER m8_suppress_capture ON ${table}`).execute(database);
      await sql`DROP FUNCTION identity.m8_suppress_capture()`.execute(database);
    }
    expect(await store.verifyNext(item.lease)).toMatchObject({ verified: true });
    item.key.fill(0);
  });
  it.each(['profile', 'photo'] as const)(
    'archives %s product sources once while retaining exact audited evidence',
    async (kind) => {
      const item = await scene(kind),
        verification = new PostgresAccountDeletionEvidenceStore(database, item.readers);
      const source = await database
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', item.userId)
        .executeTakeFirstOrThrow();
      await database
        .insertInto('profile.profile_optional_details')
        .values({ profile_id: source.id, job_title: 'Synthetic ordinary detail' })
        .execute();
      const archive = new PostgresAccountDeletionProfileStore(database);
      expect(await archive.archive(item.lease)).toEqual({
        archived: false,
        waitingForCapture: true,
      });
      expect(await verification.verifyNext(item.lease)).toMatchObject({ verified: true });
      const results = await Promise.all(
        Array.from({ length: 20 }, () => archive.archive(item.lease)),
      );
      expect(results.filter((result) => result.archived)).toHaveLength(1);
      expect(JSON.stringify(results)).not.toContain(item.userId);
      await expect(
        database
          .insertInto('profile.profiles')
          .values({ ...source, id: randomUUID() })
          .execute(),
      ).rejects.toThrow();
      expect(
        await database
          .selectFrom('profile.profiles')
          .select('id')
          .where('id', '=', source.id)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('profile.profile_optional_details')
          .select('profile_id')
          .where('profile_id', '=', source.id)
          .execute(),
      ).toHaveLength(0);
      const references = (
        await sql<{
          id: string;
          user_id: string;
        }>`SELECT id,user_id FROM profile.profile_reference_anchors WHERE id=${source.id}::uuid`.execute(
          database,
        )
      ).rows;
      expect(references).toEqual([{ id: source.id, user_id: item.userId }]);
      const proof = (
        await sql<{
          audit_id: string;
          event_id: string;
        }>`SELECT audit_id,event_id FROM identity.account_deletion_profile_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows;
      expect(proof).toHaveLength(1);
      await sql`DELETE FROM platform.outbox_events WHERE id=${proof[0]!.event_id}::uuid`.execute(
        database,
      );
      expect(await archive.archive(item.lease)).toEqual({ archived: false });
      expect(await verification.verifyNext(item.lease)).toEqual({
        examined: 0,
        verified: false,
        hasMore: false,
      });
      if (kind === 'photo') {
        expect(
          (
            await new PostgresDeletionRegistryStore(database).observe(
              item.lease,
              DELETION_REGISTRY.findIndex((entry) => entry.table === 'media.profile_photos'),
            )
          ).present,
        ).toBe(true);
        expect(
          (
            await sql`SELECT 1 FROM media.report_photo_evidence_holds WHERE report_evidence_id=${item.evidenceId}::uuid`.execute(
              database,
            )
          ).rows,
        ).toHaveLength(1);
      }
      const admin = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: admin,
          role_code: 'super_admin',
          assigned_by_admin_id: admin,
          revoked_by_admin_id: null,
          revoked_at: null,
        })
        .execute();
      const revealed = await new PostgresReportEvidenceRevealStore(database, item.readers).reveal({
        logId: randomUUID(),
        adminUserId: admin,
        commandId: randomUUID(),
        requestId: randomUUID(),
        requestDigest: 'a'.repeat(64),
        commandCode: 'moderation.reveal-evidence',
        requiredPermission: 'view_reports',
        targetType: 'report_evidence',
        targetId: item.evidenceId,
        expectedTargetVersion: 1,
        reasonDigest: 'b'.repeat(64),
        metadata: {},
        correlationId: randomUUID(),
      });
      expect(revealed.value?.content.evidenceType).toBe(kind);
      expect(
        (
          await database
            .selectFrom('moderation.evidence_access_audits')
            .select('id')
            .where('report_evidence_id', '=', item.evidenceId)
            .execute()
        ).length,
      ).toBe(1);
      await work.release(item.lease);
      const fresh = (
        await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 })
      )[0]!;
      expect(await archive.archive(fresh)).toEqual({ archived: false });
      item.key.fill(0);
    },
  );
  it('keeps a source with missing captures and rejects raw deletion, anchor mutation and deleted-user reconstruction', async () => {
    const item = await scene('profile', true),
      archive = new PostgresAccountDeletionProfileStore(database);
    const source = await database
      .selectFrom('profile.profiles')
      .selectAll()
      .where('user_id', '=', item.userId)
      .executeTakeFirstOrThrow();
    expect(await archive.archive(item.lease)).toEqual({ archived: false, waitingForCapture: true });
    await expect(
      database.deleteFrom('profile.profiles').where('id', '=', source.id).execute(),
    ).rejects.toThrow();
    await expect(
      sql`DELETE FROM profile.profile_reference_anchors WHERE id=${source.id}::uuid`.execute(
        database,
      ),
    ).rejects.toThrow();
    await expect(
      database
        .insertInto('profile.profiles')
        .values({ ...source, id: randomUUID() })
        .execute(),
    ).rejects.toThrow();
    await expect(archive.archive({ ...item.lease, userId: randomUUID() })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      await database
        .selectFrom('profile.profiles')
        .select('id')
        .where('id', '=', source.id)
        .execute(),
    ).toHaveLength(1);
    item.key.fill(0);
  });
  it.each([
    'platform.audit_logs',
    'platform.outbox_events',
    'identity.account_deletion_profile_receipts',
  ])('rolls back source deletion when %s suppresses archival evidence', async (table) => {
    const item = await scene('profile');
    await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
    await sql`CREATE FUNCTION identity.m8_suppress_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql
      .raw(
        `CREATE TRIGGER m8_suppress_profile BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_suppress_profile()`,
      )
      .execute(database);
    try {
      await expect(
        new PostgresAccountDeletionProfileStore(database).archive(item.lease),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await database
          .selectFrom('profile.profiles')
          .select('id')
          .where('user_id', '=', item.userId)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await sql`SELECT 1 FROM identity.account_deletion_profile_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await sql.raw(`DROP TRIGGER m8_suppress_profile ON ${table}`).execute(database);
      await sql`DROP FUNCTION identity.m8_suppress_profile()`.execute(database);
    }
    expect(await new PostgresAccountDeletionProfileStore(database).archive(item.lease)).toEqual({
      archived: true,
    });
    item.key.fill(0);
  });
  it('rolls back source archival when the original fence expires at commit', async () => {
    const item = await scene('profile');
    await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
    await sql`CREATE FUNCTION identity.m8_delay_profile() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER a_m8_delay_profile AFTER INSERT ON identity.account_deletion_profile_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.m8_delay_profile()`.execute(
      database,
    );
    await work.release(item.lease);
    const lease = (await work.claimDue({ workerId: randomUUID(), leaseMs: 1000, limit: 1 }))[0]!;
    try {
      await expect(
        new PostgresAccountDeletionProfileStore(database).archive(lease),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await database
          .selectFrom('profile.profiles')
          .select('id')
          .where('user_id', '=', item.userId)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await sql`SELECT 1 FROM identity.account_deletion_profile_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await sql`DROP TRIGGER a_m8_delay_profile ON identity.account_deletion_profile_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.m8_delay_profile()`.execute(database);
    }
    const fresh = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    expect(await new PostgresAccountDeletionProfileStore(database).archive(fresh)).toEqual({
      archived: true,
    });
    item.key.fill(0);
  });
  async function chatSource(item: { userId: string }): Promise<{
    id: string;
    match_id: string;
    closed_at: Date | null;
    closed_reason: string | null;
    user_low_id: string;
    user_high_id: string;
  }> {
    return await database
      .selectFrom('chat.chat_sessions as session')
      .innerJoin('matching.matches as relationship', 'relationship.id', 'session.match_id')
      .select([
        'session.id',
        'session.match_id',
        'session.closed_at',
        'session.closed_reason',
        'relationship.user_low_id',
        'relationship.user_high_id',
      ])
      .where((eb) =>
        eb.or([
          eb('relationship.user_low_id', '=', item.userId),
          eb('relationship.user_high_id', '=', item.userId),
        ]),
      )
      .executeTakeFirstOrThrow();
  }
  it('preserves survivor report preparation, concurrent submission and late capture obligations after chat archival', async () => {
    const item = await scene('unmatched_user'),
      source = await chatSource(item);
    const verifier = new PostgresAccountDeletionEvidenceStore(database, item.readers);
    await verifier.verifyNext(item.lease);
    expect(
      (await new PostgresAccountDeletionChatStore(database).archiveNext(item.lease)).archived,
    ).toBe(true);
    const survivor = source.user_low_id === item.userId ? source.user_high_id : source.user_low_id;
    const context = { kind: 'unmatched' as const, referenceId: source.match_id };
    expect(await resolveUnmatchedReportSource(database, item.userId, context)).toBeUndefined();
    expect(
      await resolveUnmatchedReportSource(database, await createReportUser(database), context),
    ).toBeUndefined();
    const values = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          if (values.has(id)) return Promise.resolve(false);
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      item.key,
    );
    const actor = { kind: 'user' as const, userId: survivor };
    const prepared = await new PostgresPrepareUnmatchedReportEvidenceHandler(
      database,
      tokens,
    ).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: (await tokens.issueSource(survivor, context)).token,
        requestedEvidenceTypes: ['unmatched_user'],
      },
      actor,
    );
    const command: SubmitReportCommand = {
      commandType: 'moderation.submit-report',
      schemaVersion: 1,
      actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        evidenceIntentToken: prepared.evidenceIntentToken,
        reasonCode: 'harassment',
        text: 'Synthetic late report',
      },
    };
    const handler = new PostgresSubmitUnmatchedReportHandler(
      database,
      tokens,
      new AesGcmUnmatchedReportSnapshotProtector('m8-capture-test', 1, item.key),
    );
    const results = await Promise.all(
      Array.from({ length: 20 }, () => handler.execute(command, actor)),
    );
    expect(new Set(results.map((result) => result.reportId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(await count(item.recordId)).toBe(1);
    expect(await verifier.verifyNext(item.lease)).toMatchObject({ verified: true });
    expect(await count(item.recordId)).toBe(2);
    expect(await verifier.verifyNext(item.lease)).toMatchObject({ hasMore: false });
  });
  it.each([false, true])(
    'keeps the immutable archived report deadline, waiting for source lock: %s',
    async (waiting) => {
      const { now } = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(database))
        .rows[0]!;
      const expires = new Date(now.getTime() + (waiting ? 10000 : 5000));
      const item = await scene('unmatched_user', false, 0, new Date(expires.getTime() - 86400000));
      const source = await chatSource(item);
      await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
      await new PostgresAccountDeletionChatStore(database).archiveNext(item.lease);
      const actor = source.user_low_id === item.userId ? source.user_high_id : source.user_low_id;
      const context = { kind: 'unmatched' as const, referenceId: source.match_id };
      if (!waiting) {
        await sql`SELECT pg_sleep_until(${expires.toISOString()}::timestamptz)`.execute(database);
        expect(await resolveUnmatchedReportSource(database, actor, context)).toBeUndefined();
        return;
      }
      expect(await resolveUnmatchedReportSource(database, actor, context)).toBeDefined();
      let release!: () => void;
      const ready = new Promise<void>((done) => {
        release = done;
      });
      const blocker = database.transaction().execute(async (tx) => {
        await tx
          .selectFrom('matching.unmatch_records')
          .select('match_id')
          .where('match_id', '=', source.match_id)
          .forUpdate()
          .execute();
        release();
        await sql`SELECT pg_sleep_until(${expires.toISOString()}::timestamptz)`.execute(tx);
      });
      await ready;
      const result = await database
        .transaction()
        .execute((tx) => resolveUnmatchedReportSource(tx, actor, context, true));
      await blocker;
      expect(result).toBeUndefined();
    },
  );
  it.each(['chat', 'message', 'unmatched_user'] as const)(
    'archives exact %s chat under twenty-way replay and preserves audited reveal',
    async (kind) => {
      const item = await scene(kind),
        source = await chatSource(item),
        archive = new PostgresAccountDeletionChatStore(database);
      await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
      const snapshots = await database
        .selectFrom('moderation.report_snapshots')
        .selectAll()
        .where('report_id', '=', item.reportId)
        .execute();
      const messageSnapshots = await database
        .selectFrom('chat.chat_message_snapshots')
        .selectAll()
        .where('report_id', '=', item.reportId)
        .execute();
      const originalUnmatch = await database
        .selectFrom('matching.unmatch_records')
        .selectAll()
        .where('match_id', '=', source.match_id)
        .execute();
      const unrelated = await createReportChat(
        database,
        await createReportUser(database, true),
        await createReportUser(database, true),
      );
      const results = await Promise.all(
        Array.from({ length: 20 }, () => archive.archiveNext(item.lease)),
      );
      expect(results.filter((result) => result.archived)).toHaveLength(1);
      expect(results.every((result) => !result.hasMore)).toBe(true);
      expect(
        await database
          .selectFrom('chat.chat_sessions')
          .select('id')
          .where('id', '=', source.id)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('chat.chat_participants')
          .select('user_id')
          .where('chat_session_id', '=', source.id)
          .execute(),
      ).toEqual([]);
      expect(
        await database
          .selectFrom('chat.chat_sessions')
          .select('id')
          .where('id', '=', unrelated.chatSessionId)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await sql<{
            id: string;
            match_id: string;
          }>`SELECT * FROM chat.chat_reference_anchors WHERE id=${source.id}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ id: source.id, match_id: source.match_id }]);
      expect(
        await database
          .selectFrom('moderation.report_snapshots')
          .selectAll()
          .where('report_id', '=', item.reportId)
          .execute(),
      ).toEqual(snapshots);
      expect(
        await database
          .selectFrom('chat.chat_message_snapshots')
          .selectAll()
          .where('report_id', '=', item.reportId)
          .execute(),
      ).toEqual(messageSnapshots);
      expect(
        await database
          .selectFrom('matching.unmatch_records')
          .selectAll()
          .where('match_id', '=', source.match_id)
          .execute(),
      ).toEqual(originalUnmatch);
      if (kind === 'unmatched_user')
        await database.transaction().execute(async (tx) => {
          await sql`CREATE TEMP TABLE m8_archived_unmatch_probe(user_low_id uuid,user_high_id uuid) ON COMMIT DROP`.execute(
            tx,
          );
          await sql`CREATE TRIGGER m8_archived_unmatch_probe AFTER INSERT ON m8_archived_unmatch_probe FOR EACH ROW EXECUTE FUNCTION matching.verify_unmatch_consistency()`.execute(
            tx,
          );
          await sql`INSERT INTO m8_archived_unmatch_probe VALUES(${source.user_low_id}::uuid,${source.user_high_id}::uuid)`.execute(
            tx,
          );
        });
      const admin = await createReportFixtureAdmin(database);
      await database
        .insertInto('administration.admin_user_roles')
        .values({
          admin_user_id: admin,
          role_code: 'super_admin',
          assigned_by_admin_id: admin,
          revoked_by_admin_id: null,
          revoked_at: null,
        })
        .execute();
      const revealed = await new PostgresReportEvidenceRevealStore(database, item.readers).reveal({
        logId: randomUUID(),
        adminUserId: admin,
        commandId: randomUUID(),
        requestId: randomUUID(),
        requestDigest: 'a'.repeat(64),
        commandCode: 'moderation.reveal-evidence',
        requiredPermission: 'view_reports',
        targetType: 'report_evidence',
        targetId: item.evidenceId,
        expectedTargetVersion: 1,
        reasonDigest: 'b'.repeat(64),
        metadata: {},
        correlationId: randomUUID(),
      });
      expect(revealed.value?.content.evidenceType).toBe(kind);
      expect(
        await database
          .selectFrom('moderation.evidence_access_audits')
          .select('id')
          .where('report_evidence_id', '=', item.evidenceId)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await sql`SELECT 1 FROM identity.account_deletion_chat_receipts WHERE deletion_record_id=${item.recordId}::uuid AND final_batch`.execute(
            database,
          )
        ).rows,
      ).toHaveLength(1);
      await sql`DELETE FROM platform.outbox_events WHERE aggregate_id=${item.recordId}::uuid`.execute(
        database,
      );
      await work.release(item.lease);
      const fresh = (
        await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 })
      )[0]!;
      expect(await archive.archiveNext(fresh)).toEqual({
        deletedMessages: 0,
        archived: false,
        hasMore: false,
      });
      await expect(archive.archiveNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        database
          .insertInto('chat.chat_sessions')
          .values({
            id: source.id,
            match_id: source.match_id,
            status: 'active',
            created_at: new Date(),
            closed_at: null,
            closed_reason: null,
          })
          .execute(),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM chat.chat_reference_anchors WHERE id=${source.id}::uuid`.execute(database),
      ).rejects.toThrow();
      item.key.fill(0);
    },
  );
  it('purges 501 live messages in bounded resumable batches with verified exact-message evidence', async () => {
    const item = await scene('message', false, 500),
      source = await chatSource(item),
      archive = new PostgresAccountDeletionChatStore(database);
    await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
    expect(await archive.archiveNext(item.lease)).toEqual({
      deletedMessages: 500,
      archived: false,
      hasMore: true,
    });
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('chat_session_id', '=', source.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('chat.chat_sessions')
        .select('id')
        .where('id', '=', source.id)
        .execute(),
    ).toHaveLength(1);
    await work.release(item.lease);
    const fresh = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    await expect(archive.archiveNext(item.lease)).rejects.toMatchObject({ code: 'conflict' });
    expect(await archive.archiveNext(fresh)).toEqual({
      deletedMessages: 1,
      archived: true,
      hasMore: false,
    });
    expect(
      (
        await sql<{
          size: number;
          final_batch: boolean;
        }>`SELECT cardinality(original_message_ids) AS size,final_batch FROM identity.account_deletion_chat_receipts WHERE deletion_record_id=${item.recordId}::uuid ORDER BY final_batch`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      { size: 500, final_batch: false },
      { size: 1, final_batch: true },
    ]);
    expect(
      await database
        .selectFrom('chat.chat_message_snapshots')
        .select('id')
        .where('report_id', '=', item.reportId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(fresh),
    ).toEqual({ examined: 0, verified: false, hasMore: false });
    item.key.fill(0);
  });
  it('keeps unverified chat sources and denies raw source/message removal and borrowed worker authority', async () => {
    const item = await scene('chat', true, 1),
      source = await chatSource(item),
      archive = new PostgresAccountDeletionChatStore(database);
    expect(await archive.archiveNext(item.lease)).toEqual({
      deletedMessages: 0,
      archived: false,
      hasMore: true,
      waitingForCapture: true,
    });
    await expect(
      database.deleteFrom('chat.chat_sessions').where('id', '=', source.id).execute(),
    ).rejects.toThrow();
    await expect(
      database.deleteFrom('chat.chat_messages').where('chat_session_id', '=', source.id).execute(),
    ).rejects.toThrow();
    await expect(
      archive.archiveNext({ ...item.lease, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('chat_session_id', '=', source.id)
        .execute(),
    ).toHaveLength(1);
    item.key.fill(0);
  });
  it('waits for every authorized pending message marker and resumes after its real capture', async () => {
    const item = await scene('message', true),
      source = await chatSource(item),
      archive = new PostgresAccountDeletionChatStore(database);
    const message = await database
      .selectFrom('chat.chat_messages')
      .select('id')
      .where('chat_session_id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(await archive.archiveNext(item.lease)).toEqual({
      deletedMessages: 0,
      archived: false,
      hasMore: true,
      waitingForCapture: true,
    });
    expect(
      await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease),
    ).toEqual({ examined: 1, verified: false, hasMore: true, waitingForCapture: true });
    expect(
      await database
        .selectFrom('chat.chat_message_snapshots')
        .select('id')
        .where('report_id', '=', item.reportId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('chat.chat_messages')
        .select('id')
        .where('id', '=', message.id)
        .execute(),
    ).toHaveLength(1);
    await database.transaction().execute(async (tx) => {
      await captureReportedMessagesInTransaction(tx, {
        reportId: item.reportId,
        chatSessionId: source.id,
        messageIds: [message.id],
      });
    });
    expect(
      (
        await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(
          item.lease,
        )
      ).verified,
    ).toBe(true);
    expect(await archive.archiveNext(item.lease)).toEqual({
      deletedMessages: 1,
      archived: true,
      hasMore: false,
    });
    item.key.fill(0);
  });
  it.each([
    'platform.audit_logs',
    'platform.outbox_events',
    'identity.account_deletion_chat_receipts',
  ])('rolls back all chat archival writes when %s suppresses required evidence', async (table) => {
    const item = await scene('message'),
      source = await chatSource(item);
    await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
    await sql`CREATE FUNCTION identity.m8_suppress_chat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    await sql
      .raw(
        `CREATE TRIGGER m8_suppress_chat BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION identity.m8_suppress_chat()`,
      )
      .execute(database);
    try {
      await expect(
        new PostgresAccountDeletionChatStore(database).archiveNext(item.lease),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await database
          .selectFrom('chat.chat_sessions')
          .select('id')
          .where('id', '=', source.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('id')
          .where('chat_session_id', '=', source.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        (
          await sql`SELECT 1 FROM identity.account_deletion_chat_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await sql.raw(`DROP TRIGGER m8_suppress_chat ON ${table}`).execute(database);
      await sql`DROP FUNCTION identity.m8_suppress_chat()`.execute(database);
    }
    expect(
      (await new PostgresAccountDeletionChatStore(database).archiveNext(item.lease)).archived,
    ).toBe(true);
    item.key.fill(0);
  });
  it('rolls back a chat batch when its exact lease expires at commit and resumes under a new fence', async () => {
    const item = await scene('message'),
      source = await chatSource(item);
    await new PostgresAccountDeletionEvidenceStore(database, item.readers).verifyNext(item.lease);
    await sql`CREATE FUNCTION identity.m8_delay_chat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.1); RETURN NULL; END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER a_m8_delay_chat AFTER INSERT ON identity.account_deletion_chat_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.m8_delay_chat()`.execute(
      database,
    );
    await work.release(item.lease);
    const lease = (await work.claimDue({ workerId: randomUUID(), leaseMs: 1000, limit: 1 }))[0]!;
    try {
      await expect(
        new PostgresAccountDeletionChatStore(database).archiveNext(lease),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect(
        await database
          .selectFrom('chat.chat_messages')
          .select('id')
          .where('chat_session_id', '=', source.id)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('chat.chat_sessions')
          .select('id')
          .where('id', '=', source.id)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER a_m8_delay_chat ON identity.account_deletion_chat_receipts`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.m8_delay_chat()`.execute(database);
    }
    const fresh = (await work.claimDue({ workerId: randomUUID(), leaseMs: 120000, limit: 1 }))[0]!;
    expect((await new PostgresAccountDeletionChatStore(database).archiveNext(fresh)).archived).toBe(
      true,
    );
    item.key.fill(0);
  });
});
