import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createTotpAdminSessionFixture } from './testing/totp-admin-session-fixture.js';
import {
  createProtectedChangeProfile,
  protectedChangeOwnerStore,
  protectedChangeWrite,
  protectedReviewWrite,
} from './testing/protected-profile-change-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresProfileChangeStore } from './profile-change-store.js';
import {
  PostgresProfileReviewStore,
  findNativeProfileReviewer,
  type ProfileReviewPosition,
} from './profile-review-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'native permission and original MFA profile correction reviews',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
    let f: Awaited<ReturnType<typeof createTotpAdminSessionFixture>>,
      store: PostgresProfileReviewStore;
    let userId: string, profileId: string, requestId: string;
    const fixtures: Array<Awaited<ReturnType<typeof createTotpAdminSessionFixture>>> = [];
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'native_profile_reviews');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 20000,
      });
    });
    beforeEach(async () => {
      f = await createTotpAdminSessionFixture(database);
      fixtures.push(f);
      store = new PostgresProfileReviewStore(database, f.principal);
      ({ userId, profileId } = await createProtectedChangeProfile(database));
      const write = protectedChangeWrite(userId);
      requestId = write.profileChangeRequestId;
      await (await protectedChangeOwnerStore(database, userId, 0)).requestProtectedChange(write);
    });
    afterAll(async () => {
      fixtures.forEach((f) => f.dispose());
      await database?.destroy();
      await isolated?.destroy();
    });
    it('binds a real authenticator session to its verified Telegram identity and rejects a borrowed principal', async () => {
      const context = await findNativeProfileReviewer(database, f.telegramUserId);
      expect(context?.principal).toEqual(f.principal);
      expect(await findNativeProfileReviewer(database, '999999999999999')).toBeUndefined();
      expect(
        await findNativeProfileReviewer(database, f.telegramUserId, {
          ...f.principal,
          sessionId: randomUUID(),
        }),
      ).toBeUndefined();
      await expect(
        new PostgresProfileReviewStore(database, {
          ...f.principal,
          actorUserId: randomUUID(),
        }).read(randomUUID(), requestId),
      ).rejects.toMatchObject({ status: 403 });
    });
    it('audits the private reason before returning it and keeps all private fields out of cached receipts', async () => {
      const operation = randomUUID(),
        first = await store.read(operation, requestId),
        replay = await store.read(operation, requestId);
      expect(first.value).toMatchObject({
        oldValue: 1995,
        requestedValue: 1994,
        reason: 'Private synthetic lifecycle correction',
      });
      expect(replay).toMatchObject({ result: 'succeeded', replayed: true, value: undefined });
      const reordered = new PostgresProfileReviewStore(database, {
        sessionId: f.principal.sessionId,
        actorUserId: f.principal.actorUserId,
        adminUserId: f.principal.adminUserId,
      });
      expect(await reordered.read(operation, requestId)).toMatchObject({
        replayed: true,
        value: undefined,
      });
      const actions = await database
        .selectFrom('administration.admin_action_logs')
        .selectAll()
        .where('target_id', '=', requestId)
        .execute();
      const audits = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('subject_id', '=', requestId)
        .where('event_type', '=', 'profile.reveal-change-request.v1')
        .execute();
      expect(actions).toHaveLength(1);
      expect(audits).toHaveLength(1);
      expect(
        (
          await sql<{
            minimal: boolean;
          }>`SELECT bool_and(platform.deletion_operational_metadata_minimal(metadata,ARRAY['actionType','decision'])) AS minimal
        FROM platform.audit_logs WHERE subject_id=${requestId}::uuid AND event_type='profile.reveal-change-request.v1'`.execute(
            database,
          )
        ).rows[0]?.minimal,
      ).toBe(true);
      expect(JSON.stringify({ actions, audits })).not.toContain(
        'Private synthetic lifecycle correction',
      );
      expect(actions.map((row) => row.metadata)).toEqual([{}]);
      expect(audits.map((row) => row.metadata)).toEqual([
        { actionType: 'profile_correction', decision: 'succeeded' },
      ]);
    });
    it('paginates pending metadata without reasons, private values or repeated rows', async () => {
      const added: string[] = [];
      for (let n = 0; n < 11; n++) {
        const target = await createProtectedChangeProfile(database),
          write = protectedChangeWrite(target.userId);
        await (
          await protectedChangeOwnerStore(database, target.userId, 0)
        ).requestProtectedChange(write);
        added.push(write.profileChangeRequestId);
      }
      const seen: string[] = [];
      let after: ProfileReviewPosition | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await store.list(randomUUID(), after);
        expect(result.result).toBe('succeeded');
        expect(result.value!.items.length).toBeLessThanOrEqual(10);
        for (const item of result.value!.items) {
          expect(Object.keys(item).sort()).toEqual(['field', 'id', 'submittedAt']);
          seen.push(item.id);
        }
        after = result.value!.next;
        if (!after) break;
        expect(after.at).toMatch(/\.\d{6}Z$/u);
      }
      expect(after).toBeUndefined();
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expect.arrayContaining(added));
    });
    it('converges twenty confirmed review retries to one protected change and one audited command', async () => {
      const operation = randomUUID(),
        results = await Promise.all(
          Array.from({ length: 20 }, () => store.review(operation, requestId, 'approved')),
        );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(results.every((r) => r.result === 'succeeded')).toBe(true);
      expect(
        await database
          .selectFrom('profile.profiles')
          .select(['birth_year', 'version'])
          .where('id', '=', profileId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ birth_year: 1994, version: 2 });
      expect(
        await database
          .selectFrom('profile.profile_change_reviews')
          .selectAll()
          .where('request_id', '=', requestId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('target_id', '=', requestId)
          .execute(),
      ).toHaveLength(1);
      const receipts = await database
        .selectFrom('platform.idempotency_records')
        .select('response_json')
        .where('scope', '=', 'profile.resolve-protected-change')
        .where('actor_user_id', '=', f.principal.actorUserId)
        .execute();
      expect(JSON.stringify(receipts)).not.toContain('requestedValue');
      expect(receipts).toEqual([
        {
          response_json: {
            receiptSchemaVersion: 1,
            profileChangeRequestId: requestId,
            decision: 'approved',
            profileVersion: 2,
          },
        },
      ]);
    });
    it('records a losing competing decision without overwriting the committed review', async () => {
      const results = await Promise.all([
        store.review(randomUUID(), requestId, 'approved'),
        store.review(randomUUID(), requestId, 'rejected'),
      ]);
      expect(results.map((r) => r.result).sort()).toEqual(['rejected', 'succeeded']);
      expect(
        await database
          .selectFrom('profile.profile_change_reviews')
          .select('request_id')
          .where('request_id', '=', requestId)
          .execute(),
      ).toHaveLength(1);
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select('id')
          .where('target_id', '=', requestId)
          .execute(),
      ).toHaveLength(2);
    });
    it('rejects cached private reads and review outcomes after permission revocation', async () => {
      const read = randomUUID(),
        review = randomUUID();
      await store.read(read, requestId);
      await store.review(review, requestId, 'approved');
      await database
        .updateTable('administration.admin_user_roles')
        .set({ revoked_at: new Date(), revoked_by_admin_id: f.principal.adminUserId })
        .where('admin_user_id', '=', f.principal.adminUserId)
        .execute();
      await expect(store.read(read, requestId)).rejects.toMatchObject({ status: 403 });
      await expect(store.review(review, requestId, 'approved')).rejects.toMatchObject({
        status: 403,
      });
      expect(await findNativeProfileReviewer(database, f.telegramUserId)).toBeUndefined();
    });
    it('never upgrades an old action to a later authenticator session', async () => {
      const operation = randomUUID();
      await store.read(operation, requestId);
      await f.revoke();
      const fresh = await f.issueNext();
      expect(fresh.sessionId).not.toBe(f.principal.sessionId);
      await expect(store.read(operation, requestId)).rejects.toMatchObject({ status: 403 });
      expect(
        await findNativeProfileReviewer(database, f.telegramUserId, f.principal),
      ).toBeUndefined();
      expect(
        (await new PostgresProfileReviewStore(database, fresh).read(randomUUID(), requestId))
          .result,
      ).toBe('succeeded');
    });
    it('requires current authenticator credentials and refuses the legacy resolver in a native host', async () => {
      const legacy = await protectedReviewWrite(database, requestId);
      await expect(
        new PostgresProfileChangeStore(database).resolveProtectedChange(legacy),
      ).rejects.toMatchObject({ status: 403 });
      const operation = randomUUID();
      await store.read(operation, requestId);
      await f.revokeCredential();
      await expect(store.read(operation, requestId)).rejects.toMatchObject({ status: 403 });
      await expect(store.review(randomUUID(), requestId, 'approved')).rejects.toMatchObject({
        status: 403,
      });
    });
    it('rolls back private access and the complete review when mandatory access audit storage fails', async () => {
      await sql
        .raw(
          `CREATE FUNCTION public.reject_profile_review_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type IN('profile.reveal-change-request.v1','profile.review-change-request.v1') THEN RAISE EXCEPTION 'synthetic required access audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_profile_review_audit BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_profile_review_audit()`,
        )
        .execute(database);
      try {
        await expect(store.read(randomUUID(), requestId)).rejects.toThrow();
        await expect(store.review(randomUUID(), requestId, 'approved')).rejects.toThrow();
        expect(
          (
            await database
              .selectFrom('profile.profiles')
              .select('birth_year')
              .where('id', '=', profileId)
              .executeTakeFirstOrThrow()
          ).birth_year,
        ).toBe(1995);
        expect(
          await database
            .selectFrom('profile.profile_change_reviews')
            .select('request_id')
            .where('request_id', '=', requestId)
            .execute(),
        ).toEqual([]);
        expect(
          await database
            .selectFrom('administration.admin_action_logs')
            .select('id')
            .where('target_id', '=', requestId)
            .execute(),
        ).toEqual([]);
      } finally {
        await sql
          .raw(
            'DROP TRIGGER reject_profile_review_audit ON platform.audit_logs; DROP FUNCTION public.reject_profile_review_audit()',
          )
          .execute(database);
      }
    });
    it('denies old private reads and decisions once the original target is tombstoned', async () => {
      let targetRequest = '',
        read = '';
      await createDeletionFixture(database, async (owner) => {
        await createProtectedChangeProfile(database, owner);
        const write = protectedChangeWrite(owner);
        targetRequest = write.profileChangeRequestId;
        await new PostgresProfileChangeStore(database).requestProtectedChange(write);
        read = randomUUID();
        expect((await store.read(read, targetRequest)).result).toBe('succeeded');
      });
      await expect(store.read(read, targetRequest)).rejects.toMatchObject({ status: 409 });
      expect((await store.review(randomUUID(), targetRequest, 'approved')).result).toBe('rejected');
      expect(
        await database
          .selectFrom('profile.profile_change_reviews')
          .select('request_id')
          .where('request_id', '=', targetRequest)
          .execute(),
      ).toEqual([]);
    });
  },
);
