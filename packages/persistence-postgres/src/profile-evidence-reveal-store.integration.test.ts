import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  ReportTokens,
  type AdminCommandAttempt,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import {
  createReportFixtureAdmin,
  createReportLike,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresPrepareProfileReportEvidenceHandler } from './profile-report-source-store.js';
import { PostgresSubmitProfileReportHandler } from './profile-report-submission-store.js';
import { PostgresProfileEvidenceRevealStore } from './profile-evidence-reveal-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL,
  key = Buffer.alloc(32, 49);
describe.skipIf(url === undefined)('audited profile evidence release', () => {
  let database: NakhDatabase, admin: string, evidenceId: string;
  const reader = new AesGcmProfileReportSnapshotReader({ resolve: () => key });
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 8,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
    admin = await createReportFixtureAdmin(database);
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
    const values = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      key,
    );
    const reporter = await createReportUser(database),
      target = await createReportUser(database, true);
    const actor = { kind: 'user' as const, userId: reporter };
    const source = await tokens.issueSource(reporter, {
      kind: 'received_like',
      referenceId: await createReportLike(database, reporter, target),
    });
    const prepared = await new PostgresPrepareProfileReportEvidenceHandler(
      database,
      tokens,
    ).execute(
      {
        actor,
        requestId: randomUUID(),
        sourceActionToken: source.token,
        requestedEvidenceTypes: ['profile'],
      },
      actor,
    );
    const report = await new PostgresSubmitProfileReportHandler(
      database,
      tokens,
      new AesGcmProfileReportSnapshotProtector('reveal-key', 1, key),
    ).execute(
      {
        commandType: 'moderation.submit-report',
        schemaVersion: 1,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        actor,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { reasonCode: 'harassment', evidenceIntentToken: prepared.evidenceIntentToken },
      },
      actor,
    );
    evidenceId = (
      await database
        .selectFrom('moderation.report_evidence')
        .select('id')
        .where('report_id', '=', report.reportId)
        .executeTakeFirstOrThrow()
    ).id;
    // Keep retained evidence without polluting other suites' unassigned review queue.
    await database
      .updateTable('moderation.moderation_reviews')
      .set({
        status: 'in_review',
        assigned_admin_id: admin,
        assigned_at: new Date(),
        updated_at: new Date(),
        version: 2,
      })
      .where('report_id', '=', report.reportId)
      .execute();
    await database
      .updateTable('profile.profiles')
      .set({ name: 'Changed after reporting' })
      .where('user_id', '=', target)
      .execute();
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  function attempt(): AdminCommandAttempt {
    return {
      logId: randomUUID(),
      adminUserId: admin,
      commandId: randomUUID(),
      requestId: randomUUID(),
      requestDigest: 'a'.repeat(64),
      commandCode: 'moderation.reveal-evidence',
      requiredPermission: 'view_reports',
      targetType: 'report_evidence',
      targetId: evidenceId,
      expectedTargetVersion: 1,
      reasonDigest: 'b'.repeat(64),
      metadata: { private: 'Never retain this' },
      correlationId: randomUUID(),
    };
  }
  it('releases the captured snapshot once across concurrent retries and never records plaintext', async () => {
    let reads = 0;
    const store = new PostgresProfileEvidenceRevealStore(database, {
        decrypt: (subject, snapshot) => {
          reads++;
          return reader.decrypt(subject, snapshot);
        },
      }),
      input = attempt();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.reveal(input)));
    expect(reads).toBe(1);
    expect(results.filter((result) => result.value !== undefined)).toHaveLength(1);
    expect(results.find((result) => result.value !== undefined)?.value?.content).toMatchObject({
      displayName: 'Private report fixture',
    });
    const audits = await database
      .selectFrom('moderation.evidence_access_audits')
      .selectAll()
      .where('command_id', '=', input.commandId)
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.outcome).toBe('revealed');
    const log = await database
      .selectFrom('administration.admin_action_logs')
      .selectAll()
      .where('id', '=', input.logId)
      .executeTakeFirstOrThrow();
    expect(log.metadata).toEqual({});
    expect(JSON.stringify([log, audits])).not.toContain('Private report');
    await expect(store.reveal({ ...input, reasonDigest: 'c'.repeat(64) })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(reads).toBe(1);
  });
  it('audits permission denials and decryption failures without releasing content', async () => {
    const denied = { ...attempt(), adminUserId: await createReportFixtureAdmin(database) };
    const broken = new PostgresProfileEvidenceRevealStore(database, {
      decrypt: () => {
        throw new Error('private key provider detail');
      },
    });
    for (const [input, expected] of [
      [denied, 'forbidden'],
      [attempt(), 'internal_error'],
    ] as const) {
      const result = await broken.reveal(input);
      expect(result.value).toBeUndefined();
      expect(result.safeCode).toBe(expected);
      const audit = await database
        .selectFrom('moderation.evidence_access_audits')
        .selectAll()
        .where('command_id', '=', input.commandId)
        .executeTakeFirstOrThrow();
      expect(audit.outcome).toBe('rejected');
      expect(JSON.stringify([result, audit])).not.toContain('private key');
    }
  });
  it('rolls back the admin outcome when required access auditing fails and permits a clean retry', async () => {
    const auditId = randomUUID();
    const store = new PostgresProfileEvidenceRevealStore(database, reader, { uuid: () => auditId });
    await store.reveal(attempt());
    const input = attempt();
    await expect(store.reveal(input)).rejects.toThrow();
    expect(
      await database
        .selectFrom('administration.admin_action_logs')
        .select('id')
        .where('id', '=', input.logId)
        .execute(),
    ).toHaveLength(0);
    expect(
      (await new PostgresProfileEvidenceRevealStore(database, reader).reveal(input)).value,
    ).toBeDefined();
  });
});
