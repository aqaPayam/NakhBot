import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
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
import { PostgresConfirmedEvidenceReveals } from './confirmed-evidence-reveal-store.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import type { EvidenceRevealDraft } from '@nakh/application';
import { PostgresGetReportEvidenceActionsHandler } from './report-evidence-actions-store.js';
import {
  PostgresGetReportEvidenceMetadataHandler,
  PostgresReportEvidenceMetadataStore,
} from './report-evidence-metadata-store.js';

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
  it('takes a report-scoped selection through an opaque action, exact confirmation and audited reveal', async () => {
    const fixture = await confirmationFixture(database, admin);
    const report = await database
      .selectFrom('moderation.report_evidence')
      .select('report_id')
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    const query = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: await fixture.issue({
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: report.report_id,
        expectedTargetVersion: 1,
      }),
    };
    const selection = await new PostgresGetReportEvidenceActionsHandler(
      database,
      fixture.tokens,
      fixture.key,
    ).execute(query, fixture.actor);
    const token = selection.items[0]!.revealActionToken!;
    expect(token).toMatch(/^v1\.ad\./u);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token).not.toContain(evidenceId);
    expect(JSON.stringify(selection)).not.toContain('Private report');
    const handler = new PostgresConfirmedEvidenceReveals(
      database,
      fixture.tokens,
      fixture.key,
      reader,
    );
    const draft: EvidenceRevealDraft = {
      commandType: 'moderation.reveal-evidence',
      schemaVersion: 1,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: fixture.actor,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { adminActionToken: token, evidenceId, reason: 'Review the selected evidence' },
    };
    const result = await handler.execute(
      {
        ...draft,
        data: { ...draft.data, confirmationToken: await handler.prepare(draft, fixture.actor) },
      },
      fixture.actor,
    );
    expect(result.value?.content).toMatchObject({ displayName: 'Private report fixture' });
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('id')
        .where('command_id', '=', draft.commandId)
        .execute(),
    ).toHaveLength(1);
  });
  it('lists only selected-report evidence metadata and rejects stale, cross-actor and disabled access', async () => {
    const fixture = await confirmationFixture(database, admin);
    const report = await database
      .selectFrom('moderation.report_evidence')
      .select('report_id')
      .where('id', '=', evidenceId)
      .executeTakeFirstOrThrow();
    const scope = {
      commandCode: 'moderation.evidence-metadata',
      requiredPermission: 'view_reports' as const,
      targetType: 'report',
      targetId: report.report_id,
      expectedTargetVersion: 1,
    };
    const handler = new PostgresGetReportEvidenceMetadataHandler(
      database,
      fixture.tokens,
      fixture.key,
    );
    const query = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: await fixture.issue(scope),
    };
    expect(await handler.execute(query, fixture.actor)).toEqual({
      reportId: report.report_id,
      items: [{ evidenceId, evidenceType: 'profile', snapshotSchemaVersion: 1 }],
    });
    await expect(
      handler.execute(query, { ...fixture.actor, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      handler.execute(
        { ...query, adminActionToken: await fixture.issue({ ...scope, expectedTargetVersion: 2 }) },
        fixture.actor,
      ),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    await expect(
      handler.execute(
        { ...query, adminActionToken: await fixture.issue({ ...scope, targetId: randomUUID() }) },
        fixture.actor,
      ),
    ).rejects.toMatchObject({ code: 'report_unavailable' });
    const disabled = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: disabled,
        role_code: 'super_admin',
        assigned_by_admin_id: admin,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    await database
      .updateTable('administration.admin_users')
      .set({
        is_active: false,
        disabled_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')`,
        version: sql<number>`version + 1`,
      })
      .where('id', '=', disabled)
      .execute();
    const actorId = (
      await database
        .selectFrom('administration.admin_users')
        .select('user_id')
        .where('id', '=', disabled)
        .executeTakeFirstOrThrow()
    ).user_id;
    await expect(
      new PostgresReportEvidenceMetadataStore(database).list({
        ...scope,
        adminUserId: disabled,
        actorUserId: actorId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('binds explicit reveal confirmation to evidence, reason and actor and rechecks revoked permissions', async () => {
    const confirmedAdmin = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: confirmedAdmin,
        role_code: 'super_admin',
        assigned_by_admin_id: admin,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, confirmedAdmin);
    let reads = 0;
    const handler = new PostgresConfirmedEvidenceReveals(database, fixture.tokens, fixture.key, {
      decrypt: (subject, snapshot) => {
        reads++;
        return reader.decrypt(subject, snapshot);
      },
    });
    async function draft(): Promise<EvidenceRevealDraft> {
      return {
        commandType: 'moderation.reveal-evidence',
        schemaVersion: 1,
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        actor: fixture.actor,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          evidenceId,
          reason: 'Investigate selected report evidence',
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.reveal-evidence',
            requiredPermission: 'view_reports',
            targetType: 'report_evidence',
            targetId: evidenceId,
            expectedTargetVersion: 1,
          }),
        },
      };
    }
    const valid = await draft();
    const command = {
      ...valid,
      data: { ...valid.data, confirmationToken: await handler.prepare(valid, fixture.actor) },
    };
    await expect(
      handler.execute(command, { ...fixture.actor, userId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(reads).toBe(0);
    expect((await handler.execute(command, fixture.actor)).value).toBeDefined();
    expect((await handler.execute(command, fixture.actor)).value).toBeUndefined();
    expect(reads).toBe(1);
    for (const modification of [
      { evidenceId: randomUUID() },
      { reason: 'Changed reason' },
      { confirmationToken: 'invalid' },
    ]) {
      const input = await draft();
      const confirmationToken = await handler.prepare(input, fixture.actor);
      const result = await handler.execute(
        { ...input, data: { ...input.data, confirmationToken, ...modification } },
        fixture.actor,
      );
      expect(result).toMatchObject({
        result: 'rejected',
        safeCode: 'invalid_request',
        value: undefined,
      });
    }
    // Even a confirmation prepared for a mismatched client ID cannot override the opaque target.
    const mismatch = await draft();
    const wrong = { ...mismatch, data: { ...mismatch.data, evidenceId: randomUUID() } };
    expect(
      (
        await handler.execute(
          {
            ...wrong,
            data: { ...wrong.data, confirmationToken: await handler.prepare(wrong, fixture.actor) },
          },
          fixture.actor,
        )
      ).safeCode,
    ).toBe('invalid_request');
    const revoked = await draft();
    const revokedCommand = {
      ...revoked,
      data: { ...revoked.data, confirmationToken: await handler.prepare(revoked, fixture.actor) },
    };
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: new Date(), revoked_by_admin_id: admin })
      .where('admin_user_id', '=', confirmedAdmin)
      .execute();
    expect((await handler.execute(revokedCommand, fixture.actor)).safeCode).toBe('forbidden');
    expect(reads).toBe(1);
  });
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
