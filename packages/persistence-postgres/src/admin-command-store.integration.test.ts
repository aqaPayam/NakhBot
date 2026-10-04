import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AdminCommandAttempt,
  AdminCommandRecordedOutcome,
  EvidenceAccessAttempt,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import {
  PostgresAdminCommandStore,
  recordEvidenceAccessInTransaction,
} from './admin-command-store.js';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { scanAdmins } from './moderation-safety-reconciliation.js';
import { reconciliationCursorBefore } from './testing/reconciliation-cursor.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
const genderOptionId = '20000000-0000-4000-8000-000000000001';
const genderPreferenceId = '20000000-0000-4000-8000-000000000013';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createUser(database: NakhDatabase): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  return id;
}

async function createAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createUser(database);
  const adminUserId = randomUUID();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  const now = new Date();
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_users')
    .values({
      id: adminUserId,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_user_roles')
    .values({
      admin_user_id: adminUserId,
      role_code: 'super_admin',
      assigned_by_admin_id: adminUserId,
      revoked_by_admin_id: null,
      revoked_at: null,
    })
    .execute();
  return adminUserId;
}

function commandAttempt(adminUserId: string, targetId: string): AdminCommandAttempt {
  return {
    logId: randomUUID(),
    adminUserId,
    commandId: randomUUID(),
    requestId: randomUUID(),
    requestDigest: digest(`request:${targetId}`),
    commandCode: 'administration.test_transition',
    requiredPermission: 'view_reports',
    targetType: 'user',
    targetId,
    expectedTargetVersion: 1,
    reasonDigest: digest('approved test reason'),
    metadata: { source: 'integration_test' },
    correlationId: randomUUID(),
  };
}

async function createEvidence(
  database: NakhDatabase,
): Promise<Readonly<{ reportId: string; evidenceId: string }>> {
  const reporterUserId = await createUser(database);
  const targetUserId = await createUser(database);
  const targetProfileId = randomUUID();
  const now = new Date();
  await database
    .insertInto('profile.profiles')
    .values({
      id: targetProfileId,
      user_id: targetUserId,
      name: 'Evidence fixture',
      birth_year: now.getUTCFullYear() - 30,
      gender_option_id: genderOptionId,
      gender_preference_id: genderPreferenceId,
      relationship_goal_id: relationshipGoalId,
      country_id: countryId,
      province_id: provinceId,
      city_id: cityId,
      highlight: 'Evidence fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await database
    .insertInto('interaction.likes')
    .values({
      id: randomUUID(),
      sender_user_id: targetUserId,
      receiver_user_id: reporterUserId,
      status: 'active',
      created_at: now,
      closed_at: null,
    })
    .execute();
  const reason = await database
    .selectFrom('moderation.report_reasons')
    .select('id')
    .where('code', '=', 'harassment')
    .executeTakeFirstOrThrow();
  const reportId = randomUUID();
  const evidenceId = randomUUID();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('moderation.reports')
      .values({
        id: reportId,
        reporter_user_id: reporterUserId,
        target_user_id: targetUserId,
        reason_id: reason.id,
        extra_text: null,
        status: 'submitted',
        command_id: randomUUID(),
        request_id: randomUUID(),
        idempotency_key: `report:${reportId}`,
        request_digest: digest(`report:${reportId}`),
        reviewed_at: null,
        closed_at: null,
      })
      .execute();
    await transaction
      .insertInto('moderation.report_evidence')
      .values({
        id: evidenceId,
        report_id: reportId,
        evidence_type: 'profile',
        profile_id: targetProfileId,
        profile_photo_id: null,
        chat_session_id: null,
        chat_message_id: null,
        unmatch_record_id: null,
      })
      .execute();
  });
  return { reportId, evidenceId };
}

describe.skipIf(databaseUrl === undefined)('M7 durable admin command execution', () => {
  let database: NakhDatabase;
  let store: PostgresAdminCommandStore;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 6,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    });
    store = new PostgresAdminCommandStore(database);
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('rejects execution after verified identity loss and records a content-free attempt', async () => {
    const adminId = await createAdmin(database),
      targetId = await createUser(database);
    const admin = await database
      .selectFrom('administration.admin_users')
      .select('user_id')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow();
    const identity = await database
      .selectFrom('identity.telegram_identities')
      .selectAll()
      .where('user_id', '=', admin.user_id)
      .executeTakeFirstOrThrow();
    const attempt = commandAttempt(adminId, targetId);
    await database
      .deleteFrom('identity.telegram_identities')
      .where('user_id', '=', admin.user_id)
      .execute();
    try {
      let executed = false;
      const outcome = await new PostgresAdminCommandStore(database).execute(attempt, () => {
        executed = true;
        return Promise.resolve({ safeCode: 'completed', value: 'Private effect result' });
      });
      expect(executed).toBe(false);
      expect(outcome).toMatchObject({
        result: 'rejected',
        safeCode: 'forbidden',
        value: undefined,
      });
      expect(
        (
          await scanAdmins(
            database,
            { phase: 'admins', lastId: reconciliationCursorBefore(adminId) },
            1,
          )
        ).findings,
      ).toEqual([
        {
          anomalyType: 'active_admin_identity_mismatch',
          entityType: 'admin_user',
          entityId: adminId,
          keyId: adminId,
          safeDetail: {},
        },
      ]);
      expect(
        await database
          .selectFrom('administration.admin_action_logs')
          .select(['result', 'safe_code'])
          .where('command_id', '=', attempt.commandId)
          .execute(),
      ).toEqual([{ result: 'rejected', safe_code: 'forbidden' }]);
    } finally {
      await database.insertInto('identity.telegram_identities').values(identity).execute();
    }
  });
  it('serializes concurrent identical commands and rejects changed replay without a second effect', async () => {
    const adminUserId = await createAdmin(database);
    const targetId = randomUUID();
    const attempt = commandAttempt(adminUserId, targetId);
    let effectExecutions = 0;
    const effect = async (
      transaction: NakhDatabase,
    ): Promise<Readonly<{ value: string; safeCode: string }>> => {
      effectExecutions += 1;
      const now = new Date();
      await transaction
        .insertInto('identity.users')
        .values({ id: targetId, last_activity_at: now, created_at: now, updated_at: now })
        .execute();
      return { value: 'created', safeCode: 'user_created' };
    };

    const results = await Promise.all([
      store.execute(attempt, effect),
      store.execute(attempt, effect),
    ]);
    expect(effectExecutions).toBe(1);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results.every((result) => result.result === 'succeeded')).toBe(true);
    expect(results.filter((result) => result.value === 'created')).toHaveLength(1);
    await expect(
      store.execute({ ...attempt, requestDigest: digest('changed') }, effect),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      store.execute({ ...attempt, reasonDigest: digest('changed reason') }, effect),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select(['result', 'safe_code'])
      .where('admin_user_id', '=', adminUserId)
      .where('command_id', '=', attempt.commandId)
      .execute();
    expect(logs).toEqual([{ result: 'succeeded', safe_code: 'user_created' }]);
  });

  it('rolls back rejected and failed effects while committing one sanitized outcome each', async () => {
    const adminUserId = await createAdmin(database);
    const rejectedTargetId = randomUUID();
    const rejectedAttempt = commandAttempt(adminUserId, rejectedTargetId);
    const rejected = await store.execute(rejectedAttempt, async (transaction) => {
      const now = new Date();
      await transaction
        .insertInto('identity.users')
        .values({
          id: rejectedTargetId,
          last_activity_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      throw new ApplicationError('forbidden', 'must not enter the audit record', 403);
    });
    expect(rejected).toMatchObject({ result: 'rejected', safeCode: 'forbidden', replayed: false });

    const failedTargetId = randomUUID();
    const failedAttempt = commandAttempt(adminUserId, failedTargetId);
    const failed = await store.execute(failedAttempt, async (transaction) => {
      const now = new Date();
      await transaction
        .insertInto('identity.users')
        .values({
          id: failedTargetId,
          last_activity_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      throw new Error('private provider detail');
    });
    expect(failed).toMatchObject({ result: 'failed', safeCode: 'internal_error', replayed: false });

    const rolledBackUsers = await database
      .selectFrom('identity.users')
      .select('id')
      .where('id', 'in', [rejectedTargetId, failedTargetId])
      .execute();
    expect(rolledBackUsers).toEqual([]);
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .select(['result', 'safe_code', 'metadata'])
      .where('admin_user_id', '=', adminUserId)
      .orderBy('result')
      .execute();
    expect(logs).toEqual([
      { result: 'failed', safe_code: 'internal_error', metadata: { source: 'integration_test' } },
      { result: 'rejected', safe_code: 'forbidden', metadata: { source: 'integration_test' } },
    ]);
  });

  it('records revealed and rejected evidence access as append-only idempotent facts', async () => {
    const adminUserId = await createAdmin(database);
    const evidence = await createEvidence(database);
    const revealed: EvidenceAccessAttempt = {
      auditId: randomUUID(),
      reportId: evidence.reportId,
      reportEvidenceId: evidence.evidenceId,
      adminUserId,
      reasonCode: 'assigned_report_review',
      requestId: randomUUID(),
      commandId: randomUUID(),
      permissionCode: 'view_reports',
      outcome: 'revealed',
      safeCode: 'evidence_revealed',
    };
    await expect(store.recordEvidenceAccess(revealed)).resolves.toMatchObject({
      auditId: revealed.auditId,
      outcome: 'revealed',
      replayed: false,
    });
    await expect(store.recordEvidenceAccess(revealed)).resolves.toMatchObject({
      auditId: revealed.auditId,
      outcome: 'revealed',
      replayed: true,
    });
    await expect(
      store.recordEvidenceAccess({ ...revealed, outcome: 'rejected' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const rejected: EvidenceAccessAttempt = {
      ...revealed,
      auditId: randomUUID(),
      requestId: randomUUID(),
      commandId: randomUUID(),
      outcome: 'rejected',
      safeCode: 'confirmation_required',
    };
    await expect(store.recordEvidenceAccess(rejected)).resolves.toMatchObject({
      auditId: rejected.auditId,
      outcome: 'rejected',
      safeCode: 'confirmation_required',
      replayed: false,
    });
    const rows = await database
      .selectFrom('moderation.evidence_access_audits')
      .select(['outcome', 'safe_code'])
      .where('report_id', '=', evidence.reportId)
      .where('admin_user_id', '=', adminUserId)
      .orderBy('outcome')
      .execute();
    expect(rows).toEqual([
      { outcome: 'rejected', safe_code: 'confirmation_required' },
      { outcome: 'revealed', safe_code: 'evidence_revealed' },
    ]);
  });

  it('commits access audits for success, rejection and failure with the attempt and observes each command once', async () => {
    const adminUserId = await createAdmin(database),
      evidence = await createEvidence(database);
    let observations = 0;
    for (const expected of ['succeeded', 'rejected', 'failed'] as const) {
      const attempt = commandAttempt(adminUserId, evidence.evidenceId);
      const observe = async (
        transaction: NakhDatabase,
        outcome: AdminCommandRecordedOutcome,
      ): Promise<void> => {
        observations++;
        expect(outcome).not.toHaveProperty('value');
        await recordEvidenceAccessInTransaction(transaction, {
          auditId: randomUUID(),
          reportId: evidence.reportId,
          reportEvidenceId: evidence.evidenceId,
          adminUserId,
          commandId: attempt.commandId,
          requestId: attempt.requestId,
          reasonCode: 'report_evidence_review',
          permissionCode: 'view_reports',
          outcome: outcome.result === 'succeeded' ? 'revealed' : 'rejected',
          safeCode: outcome.safeCode,
        });
      };
      const effect = (): Promise<Readonly<{ value: string; safeCode: string }>> => {
        if (expected === 'rejected')
          return Promise.reject(new ApplicationError('forbidden', 'private rejection detail', 403));
        if (expected === 'failed') return Promise.reject(new Error('private provider detail'));
        return Promise.resolve({ value: 'private content', safeCode: 'evidence_revealed' });
      };
      await expect(store.execute(attempt, effect, observe)).resolves.toMatchObject({
        result: expected,
        replayed: false,
      });
      await expect(store.execute(attempt, effect, observe)).resolves.toMatchObject({
        result: expected,
        replayed: true,
        value: undefined,
      });
    }
    expect(observations).toBe(3);
    const access = await database
      .selectFrom('moderation.evidence_access_audits')
      .select(['outcome', 'safe_code'])
      .where('admin_user_id', '=', adminUserId)
      .orderBy('safe_code')
      .execute();
    expect(access).toEqual([
      { outcome: 'revealed', safe_code: 'evidence_revealed' },
      { outcome: 'rejected', safe_code: 'forbidden' },
      { outcome: 'rejected', safe_code: 'internal_error' },
    ]);
    const logs = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('admin_user_id', '=', adminUserId)
      .execute();
    expect(logs).toHaveLength(3);
    expect(JSON.stringify(logs)).not.toContain('private');
  });

  it('rolls back the effect, admin log and access audit when required audit recording fails', async () => {
    const adminUserId = await createAdmin(database),
      evidence = await createEvidence(database),
      targetId = randomUUID();
    const attempt = commandAttempt(adminUserId, targetId),
      auditId = randomUUID();
    await expect(
      store.execute(
        attempt,
        async (transaction) => {
          const now = new Date();
          await transaction
            .insertInto('identity.users')
            .values({ id: targetId, created_at: now, updated_at: now, last_activity_at: now })
            .execute();
          return { value: 'must not escape', safeCode: 'user_created' };
        },
        async (transaction) => {
          await recordEvidenceAccessInTransaction(transaction, {
            auditId,
            reportId: evidence.reportId,
            reportEvidenceId: evidence.evidenceId,
            adminUserId,
            commandId: attempt.commandId,
            requestId: attempt.requestId,
            reasonCode: 'report_evidence_review',
            permissionCode: 'view_reports',
            outcome: 'revealed',
            safeCode: 'evidence_revealed',
          });
          throw new Error('required audit failed');
        },
      ),
    ).rejects.toThrow('required audit failed');
    expect(
      await database.selectFrom('identity.users').select('id').where('id', '=', targetId).execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('command_id', '=', attempt.commandId)
        .execute(),
    ).toHaveLength(0);
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('id', '=', auditId)
        .execute(),
    ).toHaveLength(0);
  });

  it('keeps evidence access command identity independent for each admin', async () => {
    const admins = await Promise.all([createAdmin(database), createAdmin(database)]),
      evidence = await createEvidence(database),
      commandId = randomUUID();
    const attempts: EvidenceAccessAttempt[] = admins.map((adminUserId) => ({
      auditId: randomUUID(),
      adminUserId,
      reportId: evidence.reportId,
      reportEvidenceId: evidence.evidenceId,
      commandId,
      requestId: randomUUID(),
      reasonCode: 'report_evidence_review',
      permissionCode: 'view_reports',
      outcome: 'revealed',
      safeCode: 'evidence_revealed',
    }));
    const results = await Promise.all(
      attempts.map((attempt) => store.recordEvidenceAccess(attempt)),
    );
    expect(new Set(results.map((result) => result.auditId)).size).toBe(2);
    for (const attempt of attempts)
      await expect(store.recordEvidenceAccess(attempt)).resolves.toMatchObject({
        auditId: attempt.auditId,
        replayed: true,
      });
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('command_id', '=', commandId)
        .execute(),
    ).toHaveLength(2);
  });
});
