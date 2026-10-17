import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestProtectedProfileChangeWrite, UserSessionActor } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresAccountDeletionProfileStore } from './account-deletion-profile-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresProfileChangeStore } from './profile-change-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import {
  createProtectedChangeProfile,
  protectedChangeOwnerStore,
  protectedChangeWrite,
  protectedGenderChangeWrite,
  protectedReviewWrite,
} from './testing/protected-profile-change-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 protected profile change original lives', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_profile_change_lives');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,
      available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(database);
  });
  async function waitForLock(minimum = 1): Promise<void> {
    for (let n = 0; n < 100; n++) {
      const waiting = (
        await sql<{ waiting: number }>`SELECT count(*)::integer AS waiting FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`.execute(
          database,
        )
      ).rows[0]!.waiting;
      if (waiting >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Native lock barrier not reached');
  }
  async function returned(
    f: Awaited<ReturnType<typeof createAccountReturnFixture>>,
  ): Promise<void> {
    const id = randomUUID(),
      at = new Date();
    await new PostgresAccountReturnStore(database, f.control).return({
      commandId: id,
      commandType: 'account.return',
      schemaVersion: 1,
      actor: { kind: 'user', userId: f.userId },
      requestId: randomUUID(),
      idempotencyKey: id,
      occurredAt: at.toISOString(),
      locale: 'en',
      data: { expectedAccountVersion: f.version },
    });
  }
  async function deletedPair(): Promise<{
    f: Awaited<ReturnType<typeof createAccountReturnFixture>>;
    userId: string;
    profileId: string;
    writes: RequestProtectedProfileChangeWrite[];
    before: unknown[];
  }> {
    let userId = '',
      profileId = '';
    const writes: RequestProtectedProfileChangeWrite[] = [];
    const before: unknown[] = [];
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (owner) => {
        ({ userId, profileId } = await createProtectedChangeProfile(database, owner));
        writes.push(protectedChangeWrite(owner), protectedGenderChangeWrite(owner));
        for (const write of writes) {
          await new PostgresProfileChangeStore(database).requestProtectedChange(write);
          before.push(
            await database
              .selectFrom('profile.profile_change_requests')
              .selectAll()
              .where('id', '=', write.profileChangeRequestId)
              .executeTakeFirstOrThrow(),
          );
        }
      },
      beforeEvidenceCheckpoint: async (lease) => {
        expect(
          (await new PostgresAccountDeletionProfileStore(database).archive(lease)).archived,
        ).toBe(true);
      },
    });
    return { f, userId, profileId, writes, before };
  }
  it('keeps twenty review retries and command aliases stable without copying private fields into transport', async () => {
    const owner = await createProtectedChangeProfile(database),
      store = new PostgresProfileChangeStore(database),
      write = protectedChangeWrite(owner.userId);
    await store.requestProtectedChange(write);
    const review = await protectedReviewWrite(database, write.profileChangeRequestId);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.resolveProtectedChange(review)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const first = results.find((r) => !r.replayed)!;
    expect(results.every((r) => r.request.requestedValue === 1994)).toBe(true);
    const receipt = {
      receiptSchemaVersion: 1,
      profileChangeRequestId: write.profileChangeRequestId,
      decision: 'approved',
      profileVersion: first.profileVersion,
    };
    expect(
      (
        await database
          .selectFrom('platform.idempotency_records')
          .select('response_json')
          .where('id', '=', review.command.commandId)
          .executeTakeFirstOrThrow()
      ).response_json,
    ).toEqual(receipt);
    // Later authorized product changes must not change the original receipt.
    await database
      .updateTable('profile.profiles')
      .set({ version: sql`version+1` })
      .where('id', '=', owner.profileId)
      .execute();
    const alias = { ...review, command: { ...review.command, commandId: randomUUID() } };
    expect(await store.resolveProtectedChange(alias)).toEqual({ ...first, replayed: true });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('event_type', '=', 'profile.protected-change-reviewed.v1')
        .where('subject_id', '=', write.profileChangeRequestId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('id', '=', alias.command.commandId)
        .execute(),
    ).toHaveLength(0);
  });
  it('leaves no copied review values after completed deletion and approved Return while retaining native history', async () => {
    const store = new PostgresProfileChangeStore(database);
    let review: Awaited<ReturnType<typeof protectedReviewWrite>> | undefined;
    let originalRequest: unknown, originalReview: unknown, receipt: unknown;
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        await createProtectedChangeProfile(database, userId);
        const write = protectedChangeWrite(userId);
        await store.requestProtectedChange(write);
        review = await protectedReviewWrite(database, write.profileChangeRequestId);
        await store.resolveProtectedChange(review);
        originalRequest = await database
          .selectFrom('profile.profile_change_requests')
          .selectAll()
          .where('id', '=', write.profileChangeRequestId)
          .executeTakeFirstOrThrow();
        originalReview = await database
          .selectFrom('profile.profile_change_reviews')
          .selectAll()
          .where('request_id', '=', write.profileChangeRequestId)
          .executeTakeFirstOrThrow();
        receipt = (
          await database
            .selectFrom('platform.idempotency_records')
            .select('response_json')
            .where('id', '=', review.command.commandId)
            .executeTakeFirstOrThrow()
        ).response_json;
      },
      beforeEvidenceCheckpoint: async (lease) => {
        expect(
          (await new PostgresAccountDeletionProfileStore(database).archive(lease)).archived,
        ).toBe(true);
      },
    });
    await returned(f);
    const fresh = await createProtectedChangeProfile(database, f.userId);
    expect(
      await database
        .selectFrom('profile.profile_change_requests')
        .selectAll()
        .where('id', '=', review!.command.data.profileChangeRequestId)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalRequest);
    expect(
      await database
        .selectFrom('profile.profile_change_reviews')
        .selectAll()
        .where('request_id', '=', review!.command.data.profileChangeRequestId)
        .executeTakeFirstOrThrow(),
    ).toEqual(originalReview);
    const response = (
      await database
        .selectFrom('platform.idempotency_records')
        .select('response_json')
        .where('id', '=', review!.command.commandId)
        .executeTakeFirstOrThrow()
    ).response_json;
    expect(response).toEqual(receipt);
    expect(Object.keys(response!)).toEqual(
      expect.arrayContaining([
        'receiptSchemaVersion',
        'profileChangeRequestId',
        'decision',
        'profileVersion',
      ]),
    );
    expect(Object.keys(response!)).toHaveLength(4);
    expect(response).not.toHaveProperty('request');
    await expect(store.resolveProtectedChange(review!)).rejects.toMatchObject({
      code: 'profile_change_invalid',
    });
    expect(
      (
        await database
          .selectFrom('profile.profiles')
          .select('birth_year')
          .where('id', '=', fresh.profileId)
          .executeTakeFirstOrThrow()
      ).birth_year,
    ).toBe(1995);
    expect(
      (
        await database
          .selectFrom('identity.guest_preview_counters')
          .select('preview_count')
          .where('user_id', '=', f.userId)
          .executeTakeFirstOrThrow()
      ).preview_count,
    ).toBe(3);
  });
  it('rejects private cache bodies, foreign receipts and receipts without their original native review command', async () => {
    const owner = await createProtectedChangeProfile(database),
      store = new PostgresProfileChangeStore(database),
      write = protectedChangeWrite(owner.userId);
    await store.requestProtectedChange(write);
    const review = await protectedReviewWrite(database, write.profileChangeRequestId);
    await store.resolveProtectedChange(review);
    const response = (
      await database
        .selectFrom('platform.idempotency_records')
        .select('response_json')
        .where('id', '=', review.command.commandId)
        .executeTakeFirstOrThrow()
    ).response_json!;
    for (const extra of [
      { request: { oldValue: 1995 } },
      { profileVersion: 0 },
      { profileVersion: 2147483648 },
    ]) {
      await expect(
        database
          .updateTable('platform.idempotency_records')
          .set({ response_json: { ...response, ...extra } })
          .where('id', '=', review.command.commandId)
          .execute(),
      ).rejects.toThrow('profile_review_response_minimal_ck');
    }
    for (const forged of [
      { ...response, profileChangeRequestId: randomUUID() },
      { ...response, decision: 'rejected' },
    ]) {
      await database
        .updateTable('platform.idempotency_records')
        .set({ response_json: forged })
        .where('id', '=', review.command.commandId)
        .execute();
      await expect(store.resolveProtectedChange(review)).rejects.toMatchObject({
        code: 'profile_change_invalid',
      });
    }
    await database
      .updateTable('platform.idempotency_records')
      .set({ response_json: response, id: randomUUID() })
      .where('id', '=', review.command.commandId)
      .execute();
    await expect(store.resolveProtectedChange(review)).rejects.toMatchObject({
      code: 'profile_change_invalid',
    });
    expect(
      (
        await database
          .selectFrom('profile.profile_change_requests')
          .select('status')
          .where('id', '=', write.profileChangeRequestId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('approved');
  });
  it('atomically minimizes populated legacy review caches and audits discards without changing retained proof', async () => {
    const upgrade = await createIsolatedTestDatabase(url!, 'm8_review_cache_upgrade');
    const previous = await mkdtemp(join(tmpdir(), 'nakh-review-cache-upgrade-'));
    let db: NakhDatabase | undefined;
    try {
      for (const filename of await readdir(resolve('migrations'))) {
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(filename) && Number(filename.slice(0, 6)) <= 150)
          await copyFile(join(resolve('migrations'), filename), join(previous, filename));
      }
      await runMigrations(upgrade.url, previous);
      db = createDatabase({
        url: upgrade.url,
        poolMax: 8,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const store = new PostgresProfileChangeStore(db),
        owner = await createProtectedChangeProfile(db);
      const write = protectedChangeWrite(owner.userId);
      await store.requestProtectedChange(write);
      const review = await protectedReviewWrite(db, write.profileChangeRequestId);
      const result = await store.resolveProtectedChange(review);
      await db
        .updateTable('platform.idempotency_records')
        .set({ response_json: { ...result } })
        .where('id', '=', review.command.commandId)
        .execute();
      const before = await db
        .selectFrom('platform.idempotency_records')
        .selectAll()
        .where('id', '=', review.command.commandId)
        .executeTakeFirstOrThrow();
      const badId = randomUUID(),
        unrelatedId = randomUUID(),
        processingId = randomUUID();
      await db
        .insertInto('platform.idempotency_records')
        .values([
          {
            ...before,
            id: badId,
            idempotency_key: badId,
            response_json: { copiedPrivate: 'synthetic', profileVersion: 0 },
          },
          { ...before, id: unrelatedId, idempotency_key: unrelatedId, scope: 'synthetic.other' },
          {
            ...before,
            id: processingId,
            idempotency_key: processingId,
            status: 'processing',
            response_json: null,
          },
        ])
        .execute();
      await createAccountReturnFixture(db);
      const hashes = async (): Promise<Array<{ fingerprint: string }>> =>
        (
          await sql<{ fingerprint: string }>`SELECT encode(sha256(convert_to(jsonb_build_object(
        'roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.account_deletion_records r),
        'manifests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r),
        'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM profile.profile_change_requests r),
        'reviews',(SELECT jsonb_agg(to_jsonb(r) ORDER BY request_id) FROM profile.profile_change_reviews r),
        'preview',(SELECT jsonb_agg(to_jsonb(r) ORDER BY user_id) FROM identity.guest_preview_counters r)
      )::text,'UTF8')),'hex') AS fingerprint`.execute(db!)
        ).rows;
      const originalHashes = await hashes();
      await sql`CREATE FUNCTION profile.test_cache_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='profile.review-response-minimized.v1' THEN RETURN NULL;END IF;RETURN NEW;END $$;
        CREATE TRIGGER a_test_cache_audit_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION profile.test_cache_audit_fault()`.execute(
        db,
      );
      await expect(runMigrations(upgrade.url, resolve('migrations'))).rejects.toThrow();
      expect(
        await db
          .selectFrom('platform.idempotency_records')
          .selectAll()
          .where('id', '=', review.command.commandId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(await hashes()).toEqual(originalHashes);
      expect(
        (
          await sql<{
            missing: boolean;
          }>`SELECT to_regprocedure('profile.review_response_receipt_valid(jsonb)') IS NULL AS missing`.execute(
            db,
          )
        ).rows[0]!.missing,
      ).toBe(true);
      await sql`DROP TRIGGER a_test_cache_audit_fault ON platform.audit_logs;DROP FUNCTION profile.test_cache_audit_fault()`.execute(
        db,
      );
      expect((await runMigrations(upgrade.url, resolve('migrations'))).applied).toEqual([
        '000151_m8_minimal_review_response_receipts.sql',
        '000152_m9_signup_presentation.sql',
        '000153_m9_candidate_media_authority.sql',
        '000154_m9_preview_consumption_disposition.sql',
        '000155_m9_guest_preview_delivery.sql',
        '000156_m9_profile_detail_presentation.sql',
        '000157_m9_public_report_presentation.sql',
      ]);
      await verifyMigrations(upgrade.url, resolve('migrations/verify'));
      const current = await db
        .selectFrom('platform.idempotency_records')
        .selectAll()
        .where('id', '=', review.command.commandId)
        .executeTakeFirstOrThrow();
      expect({ ...current, response_json: before.response_json }).toEqual(before);
      expect(current.response_json).toEqual({
        receiptSchemaVersion: 1,
        profileChangeRequestId: write.profileChangeRequestId,
        decision: 'approved',
        profileVersion: result.profileVersion,
      });
      expect(await store.resolveProtectedChange(review)).toEqual({ ...result, replayed: true });
      expect(
        await db
          .selectFrom('platform.idempotency_records')
          .select('id')
          .where('id', '=', badId)
          .execute(),
      ).toHaveLength(0);
      expect(
        (
          await db
            .selectFrom('platform.idempotency_records')
            .select('response_json')
            .where('id', '=', unrelatedId)
            .executeTakeFirstOrThrow()
        ).response_json,
      ).toEqual(before.response_json);
      expect(
        (
          await db
            .selectFrom('platform.idempotency_records')
            .select('response_json')
            .where('id', '=', processingId)
            .executeTakeFirstOrThrow()
        ).response_json,
      ).toBeNull();
      const audits = await db
        .selectFrom('platform.audit_logs')
        .select(['result_code', 'metadata'])
        .where('event_type', '=', 'profile.review-response-minimized.v1')
        .execute();
      expect(audits.map((a) => a.result_code).sort()).toEqual([
        'response_discarded',
        'response_minimized',
      ]);
      expect(
        audits.every(
          (a) =>
            Object.keys(a.metadata).length === 2 &&
            typeof a.metadata.rowHashBefore === 'string' &&
            /^[0-9a-f]{64}$/u.test(a.metadata.rowHashBefore) &&
            (a.metadata.rowHashAfter === null ||
              (typeof a.metadata.rowHashAfter === 'string' &&
                /^[0-9a-f]{64}$/u.test(a.metadata.rowHashAfter))),
        ),
      ).toBe(true);
      expect(await hashes()).toEqual(originalHashes);
      expect((await runMigrations(upgrade.url, resolve('migrations'))).applied).toHaveLength(0);
    } finally {
      await db?.destroy();
      await upgrade.destroy();
      for (const filename of await readdir(previous)) await unlink(join(previous, filename));
      await rmdir(previous);
    }
  });
  it('binds one original request under twenty retries and retains its command fence after transport loss', async () => {
    const { userId } = await createProtectedChangeProfile(database),
      write = protectedChangeWrite(userId),
      store = new PostgresProfileChangeStore(database);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.requestProtectedChange(write)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.request.requestId)).size).toBe(1);
    const proof = (
      await sql<{
        metadata: Record<string, unknown>;
        valid: boolean;
      }>`SELECT metadata,profile.change_life_valid(a) AS valid
      FROM platform.audit_logs a WHERE subject_id=${write.profileChangeRequestId}::uuid AND event_type='profile.protected-change-life-bound.v1'`.execute(
        database,
      )
    ).rows;
    expect(proof).toHaveLength(1);
    expect(proof[0]!.valid).toBe(true);
    expect(proof[0]!.metadata.productEpoch).toBe(0);
    expect(Object.keys(proof[0]!.metadata)).toHaveLength(6);
    expect(JSON.stringify(proof)).not.toContain(write.normalized.reason);
    await expect(
      database
        .updateTable('profile.profile_change_requests')
        .set({ reason: 'changed' })
        .where('id', '=', write.profileChangeRequestId)
        .execute(),
    ).rejects.toThrow('immutable');
    await expect(
      database
        .deleteFrom('profile.profile_change_requests')
        .where('id', '=', write.profileChangeRequestId)
        .execute(),
    ).rejects.toThrow('controlled release');
    // Privileged transport-loss fixture only; permanent native facts stay intact.
    await database.transaction().execute(async (tx) => {
      await sql`SET LOCAL session_replication_role=replica`.execute(tx);
      await tx
        .deleteFrom('platform.idempotency_records')
        .where('id', '=', write.command.commandId)
        .execute();
      await sql`SET LOCAL session_replication_role=origin`.execute(tx);
    });
    await expect(
      store.requestProtectedChange({
        ...write,
        profileChangeRequestId: randomUUID(),
        auditId: randomUUID(),
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'profile_change_invalid' });
    expect(
      await store.getProtectedChangeRequest(userId, write.profileChangeRequestId),
    ).toMatchObject({ status: 'pending', requestedValue: 1994 });
    expect(
      await database
        .selectFrom('profile.profile_change_requests')
        .select('id')
        .where('user_id', '=', userId)
        .execute(),
    ).toHaveLength(1);
  });
  it('atomically closes both pending fields, preserves all content/proofs and denies old reads/reviews/replays after actual Return', async () => {
    const { f, userId, profileId, writes, before } = await deletedPair(),
      store = new PostgresProfileChangeStore(database);
    for (const [n, write] of writes.entries()) {
      const row = await database
        .selectFrom('profile.profile_change_requests')
        .selectAll()
        .where('id', '=', write.profileChangeRequestId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        ...(before[n] as object),
        status: 'cancelled',
        resolved_at: expect.any(Date) as Date,
      });
      expect(await store.getProtectedChangeRequest(userId, row.id)).toBeUndefined();
      const receipts = (
        await sql<{
          id: string;
          valid: boolean;
        }>`SELECT id,profile.change_close_valid(a,false) AS valid FROM platform.audit_logs a
        WHERE subject_id=${row.id}::uuid AND event_type='profile.protected-change-closed.v1'`.execute(
          database,
        )
      ).rows;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.valid).toBe(true);
      expect(
        (
          await sql<{
            id: string;
          }>`SELECT profile.close_change(${row.id}::uuid,${f.recordId}::uuid) AS id`.execute(
            database,
          )
        ).rows[0]!.id,
      ).toBe(receipts[0]!.id);
      await expect(
        sql`SELECT profile.close_change(${row.id}::uuid,${randomUUID()}::uuid)`.execute(database),
      ).rejects.toThrow();
    }
    const original = (
      await sql`SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r WHERE deletion_record_id=${f.recordId}::uuid) AS manifests,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM platform.audit_logs r WHERE subject_id=${f.recordId}::uuid AND event_type='account.retained-source-recorded.v1') AS sources,
      (SELECT jsonb_agg(to_jsonb(r)) FROM billing.credit_epoch_closures r WHERE deletion_record_id=${f.recordId}::uuid) AS money`.execute(
        database,
      )
    ).rows;
    await returned(f);
    const fresh = await createProtectedChangeProfile(database, userId);
    expect(fresh.profileId).not.toBe(profileId);
    for (const write of writes) {
      expect(
        await store.getProtectedChangeRequest(userId, write.profileChangeRequestId),
      ).toBeUndefined();
      await expect(
        store.requestProtectedChange({
          ...write,
          profileChangeRequestId: randomUUID(),
          auditId: randomUUID(),
          eventId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'profile_change_invalid' });
      await expect(
        store.resolveProtectedChange(
          await protectedReviewWrite(database, write.profileChangeRequestId),
        ),
      ).rejects.toMatchObject({ code: 'profile_change_invalid' });
    }
    const freshWrite = protectedChangeWrite(userId, 1993);
    await expect(store.requestProtectedChange(freshWrite)).rejects.toMatchObject({
      code: 'profile_change_invalid',
    });
    const currentOwner = await protectedChangeOwnerStore(database, userId, 1);
    await currentOwner.requestProtectedChange(freshWrite);
    expect(
      await currentOwner.getProtectedChangeRequest(userId, freshWrite.profileChangeRequestId),
    ).toMatchObject({ requestedValue: 1993, status: 'pending' });
    expect(
      (
        await store.resolveProtectedChange(
          await protectedReviewWrite(database, freshWrite.profileChangeRequestId),
        )
      ).decision,
    ).toBe('approved');
    expect(
      (
        await database
          .selectFrom('profile.profiles')
          .select('birth_year')
          .where('id', '=', fresh.profileId)
          .executeTakeFirstOrThrow()
      ).birth_year,
    ).toBe(1993);
    expect(
      (
        await sql`SELECT
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r WHERE deletion_record_id=${f.recordId}::uuid) AS manifests,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM platform.audit_logs r WHERE subject_id=${f.recordId}::uuid AND event_type='account.retained-source-recorded.v1') AS sources,
      (SELECT jsonb_agg(to_jsonb(r)) FROM billing.credit_epoch_closures r WHERE deletion_record_id=${f.recordId}::uuid) AS money`.execute(
          database,
        )
      ).rows,
    ).toEqual(original);
    expect(
      (
        await sql<{
          disabled: boolean;
        }>`SELECT NOT identity.retained_content_release_enabled() AS disabled`.execute(database)
      ).rows[0]!.disabled,
    ).toBe(true);
  });
  it('requires the request audit and one exact native birth without accepting corrupt life metadata', async () => {
    for (const fault of [
      'request_missing',
      'birth_missing',
      'epoch',
      'profile',
      'source',
      'hash',
      'extra',
    ] as const) {
      const event =
        fault === 'request_missing'
          ? "'profile.protected-change-requested.v1'"
          : "'profile.protected-change-life-bound.v1'";
      const effect = fault.endsWith('missing')
        ? 'RETURN NULL;'
        : fault === 'epoch'
          ? "NEW.metadata:=NEW.metadata||jsonb_build_object('productEpoch',999);"
          : fault === 'profile'
            ? "NEW.metadata:=NEW.metadata||jsonb_build_object('profileId',gen_random_uuid());"
            : fault === 'source'
              ? "NEW.metadata:=NEW.metadata||jsonb_build_object('sourceAuditId',gen_random_uuid());"
              : fault === 'hash'
                ? "NEW.metadata:=NEW.metadata||jsonb_build_object('bodyHash',repeat('a',64));"
                : "NEW.metadata:=NEW.metadata||jsonb_build_object('private','synthetic-forbidden');";
      await sql`CREATE FUNCTION profile.test_life_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type=${sql.raw(event)} THEN ${sql.raw(effect)} END IF;RETURN NEW;END $$;
        CREATE TRIGGER a_test_life_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION profile.test_life_fault()`.execute(
        database,
      );
      const { userId } = await createProtectedChangeProfile(database),
        write = protectedChangeWrite(userId);
      try {
        await expect(
          new PostgresProfileChangeStore(database).requestProtectedChange(write),
        ).rejects.toThrow();
        expect(
          await database
            .selectFrom('profile.profile_change_requests')
            .select('id')
            .where('id', '=', write.profileChangeRequestId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('subject_id', '=', write.profileChangeRequestId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('platform.idempotency_records')
            .select('id')
            .where('id', '=', write.command.commandId)
            .execute(),
        ).toHaveLength(0);
      } finally {
        await sql`DROP TRIGGER a_test_life_fault ON platform.audit_logs;DROP FUNCTION profile.test_life_fault()`.execute(
          database,
        );
      }
    }
  });
  it('rolls back the complete tombstone when closure audit/effect or deferred content preservation fails', async () => {
    for (const fault of ['audit', 'effect', 'deferred'] as const) {
      if (fault === 'audit')
        await sql`CREATE FUNCTION profile.test_close_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='profile.protected-change-closed.v1' THEN RETURN NULL;END IF;RETURN NEW;END $$;
        CREATE TRIGGER a_test_close_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION profile.test_close_fault()`.execute(
          database,
        );
      else if (fault === 'effect')
        await sql`CREATE FUNCTION profile.test_close_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='cancelled' THEN RETURN NULL;END IF;RETURN NEW;END $$;
        CREATE TRIGGER a_test_close_fault BEFORE UPDATE ON profile.profile_change_requests FOR EACH ROW EXECUTE FUNCTION profile.test_close_fault()`.execute(
          database,
        );
      else
        await sql`CREATE FUNCTION profile.test_close_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='cancelled' THEN
        PERFORM set_config('session_replication_role','replica',true);UPDATE profile.profile_change_requests SET reason='privileged deferred corruption' WHERE id=NEW.id;
        PERFORM set_config('session_replication_role','origin',true);END IF;RETURN NEW;END $$;
        CREATE TRIGGER a_test_close_fault AFTER UPDATE ON profile.profile_change_requests FOR EACH ROW EXECUTE FUNCTION profile.test_close_fault()`.execute(
          database,
        );
      let owner = '',
        write: RequestProtectedProfileChangeWrite | undefined;
      try {
        await expect(
          createDeletionFixture(database, async (userId) => {
            owner = userId;
            await createProtectedChangeProfile(database, userId);
            write = protectedChangeWrite(userId);
            await new PostgresProfileChangeStore(database).requestProtectedChange(write);
          }),
        ).rejects.toThrow();
        expect(
          (
            await database
              .selectFrom('identity.accounts')
              .select('state')
              .where('user_id', '=', owner)
              .executeTakeFirstOrThrow()
          ).state,
        ).toBe('active');
        expect(
          await database
            .selectFrom('profile.profile_change_requests')
            .select(['status', 'reason'])
            .where('id', '=', write!.profileChangeRequestId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ status: 'pending', reason: write!.normalized.reason });
        expect(
          (
            await sql<{
              id: string;
            }>`SELECT id FROM identity.account_deletion_records WHERE user_id=${owner}::uuid`.execute(
              database,
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('subject_id', '=', write!.profileChangeRequestId)
            .where('event_type', '=', 'profile.protected-change-closed.v1')
            .execute(),
        ).toHaveLength(0);
      } finally {
        await sql`DROP TRIGGER a_test_close_fault ON ${sql.table(fault === 'audit' ? 'platform.audit_logs' : 'profile.profile_change_requests')};DROP FUNCTION profile.test_close_fault()`.execute(
          database,
        );
      }
    }
  });
  it('captures request identity, payload and command ownership before a real User lock wait', async () => {
    const owner = await createProtectedChangeProfile(database),
      other = await createProtectedChangeProfile(database);
    const write = protectedChangeWrite(owner.userId),
      original = structuredClone(write),
      store = new PostgresProfileChangeStore(database);
    let pending: ReturnType<typeof store.requestProtectedChange> | undefined;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT id FROM identity.users WHERE id=${owner.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      pending = store.requestProtectedChange(write);
      await waitForLock();
      Object.assign(write.command.actor, { userId: other.userId });
      Object.assign(write.command.data, { requestedValue: 1980, reason: 'changed' });
      Object.assign(write.normalized, { requestedValue: 1980, reason: 'changed' });
    });
    expect((await pending!).request.requestId).toBe(original.profileChangeRequestId);
    expect(
      await store.getProtectedChangeRequest(owner.userId, original.profileChangeRequestId),
    ).toMatchObject({ requestedValue: 1994 });
    expect(
      await store.getProtectedChangeRequest(other.userId, original.profileChangeRequestId),
    ).toBeUndefined();
    expect(
      (
        await database
          .selectFrom('platform.idempotency_records')
          .select('actor_user_id')
          .where('id', '=', original.command.commandId)
          .executeTakeFirstOrThrow()
      ).actor_user_id,
    ).toBe(owner.userId);
  });
  it('captures the review target, decision and reviewer before a real administrator lock wait', async () => {
    const owner = await createProtectedChangeProfile(database),
      other = await createProtectedChangeProfile(database),
      store = new PostgresProfileChangeStore(database);
    const first = protectedChangeWrite(owner.userId),
      second = protectedChangeWrite(other.userId);
    await store.requestProtectedChange(first);
    await store.requestProtectedChange(second);
    const review = await protectedReviewWrite(database, first.profileChangeRequestId),
      foreign = await protectedReviewWrite(database, second.profileChangeRequestId),
      original = structuredClone(review);
    let pending: ReturnType<typeof store.resolveProtectedChange> | undefined;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT id FROM administration.admin_users WHERE id=${review.authorization.adminUserId}::uuid FOR UPDATE`.execute(
        tx,
      );
      pending = store.resolveProtectedChange(review);
      await waitForLock();
      Object.assign(review.command.data, {
        profileChangeRequestId: second.profileChangeRequestId,
        decision: 'rejected',
      });
      Object.assign(review.command.actor, foreign.command.actor);
      Object.assign(review.authorization, foreign.authorization);
    });
    expect((await pending!).request.requestId).toBe(first.profileChangeRequestId);
    expect(
      await store.getProtectedChangeRequest(owner.userId, first.profileChangeRequestId),
    ).toMatchObject({ status: 'approved' });
    expect(
      await store.getProtectedChangeRequest(other.userId, second.profileChangeRequestId),
    ).toMatchObject({ status: 'pending' });
    expect(
      (
        await database
          .selectFrom('profile.profile_change_reviews')
          .select('admin_user_id')
          .where('request_id', '=', first.profileChangeRequestId)
          .executeTakeFirstOrThrow()
      ).admin_user_id,
    ).toBe(original.authorization.adminUserId);
  });
  it('serializes twenty exact reviews with deletion and never replays a prior-life decision into a new Profile', async () => {
    let write: RequestProtectedProfileChangeWrite | undefined,
      review: Awaited<ReturnType<typeof protectedReviewWrite>> | undefined;
    let attempts: PromiseSettledResult<
      Awaited<ReturnType<PostgresProfileChangeStore['resolveProtectedChange']>>
    >[] = [];
    let running: Promise<typeof attempts> | undefined;
    const store = new PostgresProfileChangeStore(database);
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        await createProtectedChangeProfile(database, userId);
        write = protectedChangeWrite(userId);
        await store.requestProtectedChange(write);
        review = await protectedReviewWrite(database, write.profileChangeRequestId);
        running = Promise.allSettled(
          Array.from({ length: 20 }, () => store.resolveProtectedChange(review!)),
        );
      },
      beforeEvidenceCheckpoint: async (lease) => {
        expect(
          (await new PostgresAccountDeletionProfileStore(database).archive(lease)).archived,
        ).toBe(true);
      },
    });
    attempts = await running!;
    expect(
      attempts.filter((r) => r.status === 'fulfilled' && !r.value.replayed).length,
    ).toBeLessThanOrEqual(1);
    const old = await database
      .selectFrom('profile.profile_change_requests')
      .select('status')
      .where('id', '=', write!.profileChangeRequestId)
      .executeTakeFirstOrThrow();
    expect(['approved', 'cancelled']).toContain(old.status);
    expect(
      await store.getProtectedChangeRequest(f.userId, write!.profileChangeRequestId),
    ).toBeUndefined();
    await returned(f);
    const fresh = await createProtectedChangeProfile(database, f.userId);
    await expect(store.resolveProtectedChange(review!)).rejects.toMatchObject({
      code: 'profile_change_invalid',
    });
    expect(
      (
        await database
          .selectFrom('profile.profiles')
          .select('birth_year')
          .where('id', '=', fresh.profileId)
          .executeTakeFirstOrThrow()
      ).birth_year,
    ).toBe(1995);
  });
  it('rolls back a review when its mandatory audit, review or resolution is suppressed or corrupted', async () => {
    for (const fault of [
      'audit_missing',
      'audit_wrong',
      'review_missing',
      'resolution_missing',
    ] as const) {
      const owner = await createProtectedChangeProfile(database),
        store = new PostgresProfileChangeStore(database),
        write = protectedChangeWrite(owner.userId);
      await store.requestProtectedChange(write);
      const review = await protectedReviewWrite(database, write.profileChangeRequestId);
      const table = fault.startsWith('audit')
        ? 'platform.audit_logs'
        : fault === 'review_missing'
          ? 'profile.profile_change_reviews'
          : 'profile.profile_change_requests';
      const operation = fault === 'resolution_missing' ? 'UPDATE' : 'INSERT';
      const body =
        fault === 'audit_missing'
          ? "IF NEW.event_type='profile.protected-change-reviewed.v1' THEN RETURN NULL;END IF;"
          : fault === 'audit_wrong'
            ? "IF NEW.event_type='profile.protected-change-reviewed.v1' THEN NEW.metadata='{}'::jsonb;END IF;"
            : 'RETURN NULL;';
      await sql
        .raw(
          `CREATE FUNCTION profile.test_review_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NEW;END $$;CREATE TRIGGER test_review_fault BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION profile.test_review_fault()`,
        )
        .execute(database);
      try {
        await expect(store.resolveProtectedChange(review)).rejects.toThrow();
        expect(
          await store.getProtectedChangeRequest(owner.userId, write.profileChangeRequestId),
        ).toMatchObject({ status: 'pending' });
        expect(
          (
            await database
              .selectFrom('profile.profiles')
              .select('birth_year')
              .where('id', '=', owner.profileId)
              .executeTakeFirstOrThrow()
          ).birth_year,
        ).toBe(1995);
        expect(
          await database
            .selectFrom('profile.profile_change_reviews')
            .selectAll()
            .where('request_id', '=', write.profileChangeRequestId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('platform.idempotency_records')
            .select('id')
            .where('id', '=', review.command.commandId)
            .execute(),
        ).toHaveLength(0);
        expect(
          await database
            .selectFrom('platform.audit_logs')
            .select('id')
            .where('command_id', '=', review.command.commandId)
            .execute(),
        ).toHaveLength(0);
      } finally {
        await sql
          .raw(
            `DROP TRIGGER test_review_fault ON ${table};DROP FUNCTION profile.test_review_fault()`,
          )
          .execute(database);
      }
      await store.resolveProtectedChange(review);
      expect(
        await store.getProtectedChangeRequest(owner.userId, write.profileChangeRequestId),
      ).toMatchObject({ status: 'approved' });
    }
  });
  it('upgrades populated migration 147 without rebinding old lives or rewriting original retained proof', async () => {
    const upgrade = await createIsolatedTestDatabase(url!, 'm8_change_upgrade');
    const previous = await mkdtemp(join(tmpdir(), 'nakh-profile-upgrade-'));
    let legacy: NakhDatabase | undefined;
    try {
      for (const filename of await readdir(resolve('migrations'))) {
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(filename) && Number(filename.slice(0, 6)) <= 147)
          await copyFile(join(resolve('migrations'), filename), join(previous, filename));
      }
      expect((await runMigrations(upgrade.url, previous)).applied).toHaveLength(147);
      legacy = createDatabase({
        url: upgrade.url,
        poolMax: 6,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const db = legacy,
        store = new PostgresProfileChangeStore(db);
      const live = await createProtectedChangeProfile(db),
        liveWrite = protectedChangeWrite(live.userId);
      await store.requestProtectedChange(liveWrite);
      const terminal = await createProtectedChangeProfile(db),
        terminalWrite = protectedChangeWrite(terminal.userId);
      await store.requestProtectedChange(terminalWrite);
      const review = await protectedReviewWrite(db, terminalWrite.profileChangeRequestId);
      // Pre-148 terminal history fixture, preserving the existing M1 row/audit shape.
      await db.transaction().execute(async (tx) => {
        await tx
          .insertInto('profile.profile_change_reviews')
          .values({
            request_id: terminalWrite.profileChangeRequestId,
            admin_user_id: review.authorization.adminUserId,
            decision: 'rejected',
            admin_note: review.normalizedNote ?? null,
            reviewed_at: review.processedAt,
          })
          .execute();
        await tx
          .updateTable('profile.profile_change_requests')
          .set({ status: 'rejected', resolved_at: review.processedAt })
          .where('id', '=', terminalWrite.profileChangeRequestId)
          .execute();
        await tx
          .insertInto('platform.audit_logs')
          .values({
            id: review.auditId,
            category: 'admin',
            event_type: 'profile.protected-change-reviewed.v1',
            actor_type: 'admin',
            actor_user_id: null,
            actor_admin_id: review.authorization.adminUserId,
            subject_type: 'profile_change_request',
            subject_id: terminalWrite.profileChangeRequestId,
            result_code: 'rejected',
            metadata_schema_version: 1,
            metadata: { field: 'birth_year', decision: 'rejected' },
            request_id: review.command.requestId,
            command_id: review.command.commandId,
            occurred_at: review.processedAt,
          })
          .execute();
      });
      let oldWrite: RequestProtectedProfileChangeWrite | undefined;
      const old = await createAccountReturnFixture(db, {
        beforeDeletion: async (userId) => {
          await createProtectedChangeProfile(db, userId);
          oldWrite = protectedChangeWrite(userId);
          await store.requestProtectedChange(oldWrite);
        },
        beforeEvidenceCheckpoint: async (lease) => {
          expect((await new PostgresAccountDeletionProfileStore(db).archive(lease)).archived).toBe(
            true,
          );
        },
      });
      const ids = [
        liveWrite.profileChangeRequestId,
        terminalWrite.profileChangeRequestId,
        oldWrite!.profileChangeRequestId,
      ];
      const originalRows = await db
        .selectFrom('profile.profile_change_requests')
        .selectAll()
        .where('id', 'in', ids)
        .orderBy('id')
        .execute();
      const originalAudits = await db
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('subject_id', 'in', ids)
        .orderBy('id')
        .execute();
      const originalReviews = await db
        .selectFrom('profile.profile_change_reviews')
        .selectAll()
        .where('request_id', 'in', ids)
        .execute();
      type RetainedSnapshot = {
        root: Record<string, unknown>;
        manifests: unknown;
        sources: unknown;
      };
      const retained = async (): Promise<RetainedSnapshot[]> =>
        (
          await sql<RetainedSnapshot>`SELECT
        (SELECT to_jsonb(r) FROM identity.account_deletion_records r WHERE id=${old.recordId}::uuid) AS root,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM identity.data_retention_records r WHERE deletion_record_id=${old.recordId}::uuid) AS manifests,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM platform.audit_logs r WHERE subject_id=${old.recordId}::uuid AND event_type='account.retained-source-recorded.v1') AS sources`.execute(
            db,
          )
        ).rows;
      const originalRetained = await retained();
      expect((await runMigrations(upgrade.url, resolve('migrations'))).applied).toEqual([
        '000148_m8_protected_profile_change_lives.sql',
        '000149_m8_live_retained_safety_holds.sql',
        '000150_m8_batched_photo_sources.sql',
        '000151_m8_minimal_review_response_receipts.sql',
        '000152_m9_signup_presentation.sql',
        '000153_m9_candidate_media_authority.sql',
        '000154_m9_preview_consumption_disposition.sql',
        '000155_m9_guest_preview_delivery.sql',
        '000156_m9_profile_detail_presentation.sql',
        '000157_m9_public_report_presentation.sql',
      ]);
      await verifyMigrations(upgrade.url, resolve('migrations/verify'));
      expect((await runMigrations(upgrade.url, resolve('migrations'))).applied).toHaveLength(0);
      expect(await retained()).toEqual(originalRetained);
      expect(
        await db
          .selectFrom('platform.audit_logs')
          .selectAll()
          .where(
            'id',
            'in',
            originalAudits.map((a) => a.id),
          )
          .orderBy('id')
          .execute(),
      ).toEqual(originalAudits);
      expect(
        await db
          .selectFrom('profile.profile_change_reviews')
          .selectAll()
          .where('request_id', 'in', ids)
          .execute(),
      ).toEqual(originalReviews);
      for (const before of originalRows) {
        const after = await db
          .selectFrom('profile.profile_change_requests')
          .selectAll()
          .where('id', '=', before.id)
          .executeTakeFirstOrThrow();
        expect(after).toEqual(
          before.id === oldWrite!.profileChangeRequestId
            ? { ...before, status: 'cancelled', resolved_at: expect.any(Date) as Date }
            : before,
        );
      }
      expect(
        await store.getProtectedChangeRequest(live.userId, liveWrite.profileChangeRequestId),
      ).toMatchObject({ status: 'pending' });
      expect(
        await store.getProtectedChangeRequest(
          terminal.userId,
          terminalWrite.profileChangeRequestId,
        ),
      ).toMatchObject({ status: 'rejected' });
      expect(
        await store.getProtectedChangeRequest(old.userId, oldWrite!.profileChangeRequestId),
      ).toBeUndefined();
      const births = (
        await sql<{
          subject_id: string;
          mode: string;
          valid: boolean;
        }>`SELECT subject_id,metadata->>'mode' AS mode,profile.change_life_valid(a) AS valid FROM platform.audit_logs a WHERE event_type='profile.protected-change-life-bound.v1' AND subject_id=ANY(${ids}::uuid[])`.execute(
          db,
        )
      ).rows;
      expect(births).toHaveLength(2);
      expect(
        births.every(
          (a) =>
            a.mode === 'legacy' && a.valid && a.subject_id !== oldWrite!.profileChangeRequestId,
        ),
      ).toBe(true);
      const closure = (
        await sql<{
          valid: boolean;
          mode: string;
        }>`SELECT profile.change_close_valid(a,false) AS valid,metadata->>'mode' AS mode FROM platform.audit_logs a WHERE subject_id=${oldWrite!.profileChangeRequestId}::uuid AND event_type='profile.protected-change-closed.v1'`.execute(
          db,
        )
      ).rows;
      expect(closure).toEqual([{ valid: true, mode: 'unbound' }]);
      expect(
        (
          await sql<{
            valid: boolean;
          }>`SELECT bool_and(identity.retained_source_proof_valid(a,false)) AS valid FROM platform.audit_logs a WHERE subject_id=${old.recordId}::uuid AND event_type='account.retained-source-recorded.v1'`.execute(
            db,
          )
        ).rows[0]!.valid,
      ).toBe(true);
      const commandId = randomUUID();
      await new PostgresAccountReturnStore(db, old.control).return({
        commandId,
        commandType: 'account.return',
        schemaVersion: 1,
        actor: { kind: 'user', userId: old.userId },
        requestId: randomUUID(),
        idempotencyKey: commandId,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: old.version },
      });
      await createProtectedChangeProfile(db, old.userId);
      await expect(store.requestProtectedChange(oldWrite!)).rejects.toMatchObject({
        code: 'profile_change_invalid',
      });
      await expect(
        store.resolveProtectedChange(
          await protectedReviewWrite(db, oldWrite!.profileChangeRequestId),
        ),
      ).rejects.toMatchObject({ code: 'profile_change_invalid' });
      const fresh = await protectedChangeOwnerStore(db, old.userId, 1);
      const next = protectedChangeWrite(old.userId, 1992);
      await fresh.requestProtectedChange(next);
      expect(
        await fresh.getProtectedChangeRequest(old.userId, next.profileChangeRequestId),
      ).toMatchObject({ requestedValue: 1992 });
      expect(await retained()).toEqual(
        originalRetained.map((row) => ({
          ...row,
          root: { ...row.root, reactivation_allowed: true },
        })),
      );
      expect(
        (
          await sql<{
            disabled: boolean;
          }>`SELECT NOT identity.retained_content_release_enabled() AS disabled`.execute(db)
        ).rows[0]!.disabled,
      ).toBe(true);
    } finally {
      await legacy?.destroy();
      await upgrade.destroy();
      for (const filename of await readdir(previous)) await unlink(join(previous, filename));
      await rmdir(previous);
    }
  });
  it('never refreshes a captured owner into a later life while waiting for a database connection', async () => {
    const stalled = createDatabase({
      url: isolated.url,
      poolMax: 1,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>((done) => {
        ready = done;
      }),
      hold = new Promise<void>((done) => {
        release = done;
      });
    const holding = stalled.connection().execute(async () => {
      ready();
      await hold;
    });
    await entered;
    let actor: UserSessionActor | undefined, write: RequestProtectedProfileChangeWrite | undefined;
    let pending:
      | Promise<
          PromiseSettledResult<
            Awaited<ReturnType<PostgresProfileChangeStore['requestProtectedChange']>>
          >
        >
      | undefined;
    try {
      const f = await createAccountReturnFixture(database, {
        beforeDeletion: async (userId) => {
          await createProtectedChangeProfile(database, userId);
          const grant = await new PostgresUserSessionStore(database).issue(
            { userId, productEpoch: 0 },
            randomUUID(),
          );
          expect(grant).toBeDefined();
          actor = { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant!.id };
          write = protectedChangeWrite(userId);
          pending = new PostgresProfileChangeStore(stalled, actor)
            .requestProtectedChange(write)
            .then(
              (value) => ({ status: 'fulfilled' as const, value }),
              (reason: unknown) => ({ status: 'rejected' as const, reason }),
            );
        },
        beforeEvidenceCheckpoint: async (lease) => {
          expect(
            (await new PostgresAccountDeletionProfileStore(database).archive(lease)).archived,
          ).toBe(true);
        },
      });
      await returned(f);
      await createProtectedChangeProfile(database, f.userId);
      const current = await new PostgresUserSessionStore(database).issue(
        { userId: f.userId, productEpoch: 1 },
        randomUUID(),
      );
      expect(current).toBeDefined();
      // A caller replacing its principal cannot replace the store's saved copy.
      Object.assign(actor!, { productEpoch: 1, sessionGrantId: current!.id });
      release();
      await holding;
      expect(await pending!).toMatchObject({
        status: 'rejected',
        reason: { code: 'profile_change_invalid' },
      });
      expect(
        await database
          .selectFrom('profile.profile_change_requests')
          .select('id')
          .where('id', '=', write!.profileChangeRequestId)
          .execute(),
      ).toHaveLength(0);
      expect(
        await database
          .selectFrom('platform.idempotency_records')
          .select('id')
          .where('id', '=', write!.command.commandId)
          .execute(),
      ).toHaveLength(0);
    } finally {
      release();
      await holding;
      await pending;
      await stalled.destroy();
    }
  });
  it('rejects borrowed grants and rechecks real revocation after a User lock wait without a legacy fallback', async () => {
    const owner = await createProtectedChangeProfile(database),
      other = await createProtectedChangeProfile(database),
      sessions = new PostgresUserSessionStore(database);
    const initial = protectedChangeWrite(owner.userId);
    await new PostgresProfileChangeStore(database).requestProtectedChange(initial);
    const grant = await sessions.issue({ userId: owner.userId, productEpoch: 0 }, randomUUID());
    const foreign = await sessions.issue({ userId: other.userId, productEpoch: 0 }, randomUUID());
    expect(grant).toBeDefined();
    expect(foreign).toBeDefined();
    const store = new PostgresProfileChangeStore(database, {
      kind: 'user',
      userId: owner.userId,
      productEpoch: 0,
      sessionGrantId: grant!.id,
    });
    const borrowed = new PostgresProfileChangeStore(database, {
      kind: 'user',
      userId: owner.userId,
      productEpoch: 0,
      sessionGrantId: foreign!.id,
    });
    expect(
      await borrowed.getProtectedChangeRequest(owner.userId, initial.profileChangeRequestId),
    ).toBeUndefined();
    expect(
      await new PostgresProfileChangeStore(database).getProtectedChangeRequest(
        owner.userId,
        initial.profileChangeRequestId,
      ),
    ).toBeUndefined();
    expect(
      await store.getProtectedChangeRequest(owner.userId, initial.profileChangeRequestId),
    ).toMatchObject({ status: 'pending' });
    let revoke: Promise<void> | undefined, pending: Promise<unknown> | undefined;
    await database.transaction().execute(async (tx) => {
      await sql`SELECT id FROM identity.users WHERE id=${owner.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      revoke = sessions.revoke({ userId: owner.userId, productEpoch: 0 }, grant!.id, randomUUID());
      await waitForLock();
      pending = store
        .requestProtectedChange(protectedGenderChangeWrite(owner.userId))
        .catch((error) => error as Error);
      await waitForLock(2);
    });
    await revoke;
    expect(await pending).toMatchObject({ code: 'profile_change_invalid' });
    expect(
      await store.getProtectedChangeRequest(owner.userId, initial.profileChangeRequestId),
    ).toBeUndefined();
    expect(
      await database
        .selectFrom('profile.profile_change_requests')
        .select('id')
        .where('user_id', '=', owner.userId)
        .execute(),
    ).toHaveLength(1);
  });
});
