import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AesGcmPhotoReportSnapshotReader, type EvidenceRevealDraft } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresConfirmedReportEvidenceReveals } from './confirmed-evidence-reveal-store.js';
import { PostgresGetReportEvidenceActionsHandler } from './report-evidence-actions-store.js';
import { createRetainedReportPhoto, createReportFixtureAdmin } from './testing/report-fixture.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('confirmed audited retained-photo reveal', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 10,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  it('releases the captured photo only after confirmed audited access, never on replay or reference mismatch', async () => {
    const input = await createRetainedReportPhoto(database);
    const report = { reportId: input.reportId };
    await database
      .updateTable('media.profile_photos')
      .set({ status: 'hidden', is_primary: false, hidden_at: new Date(), version: 2 })
      .where('id', '=', input.photoId)
      .execute();
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
    const fixture = await confirmationFixture(database, admin);
    const query = {
      actor: fixture.actor,
      requestId: randomUUID(),
      adminActionToken: await fixture.issue({
        commandCode: 'moderation.evidence-metadata',
        requiredPermission: 'view_reports',
        targetType: 'report',
        targetId: report.reportId,
        expectedTargetVersion: 1,
      }),
    };
    const unsupported = await new PostgresGetReportEvidenceActionsHandler(
      database,
      fixture.tokens,
      fixture.key,
    ).execute(query, fixture.actor);
    expect(unsupported.items[0]!.revealActionToken).toBeUndefined();
    const selected = await new PostgresGetReportEvidenceActionsHandler(
      database,
      fixture.tokens,
      fixture.key,
      Date.now,
      ['photo'],
    ).execute(query, fixture.actor);
    const evidence = selected.items[0]!;
    const draft: EvidenceRevealDraft = {
      commandType: 'moderation.reveal-evidence',
      schemaVersion: 1,
      actor: fixture.actor,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        adminActionToken: evidence.revealActionToken!,
        evidenceId: evidence.evidenceId,
        reason: 'Review captured photo evidence',
      },
    };
    let decryptions = 0;
    const reader = new AesGcmPhotoReportSnapshotReader({ resolve: () => input.key });
    const handler = new PostgresConfirmedReportEvidenceReveals(
      database,
      fixture.tokens,
      fixture.key,
      {
        photo: {
          decrypt: (subject, snapshot) => {
            decryptions++;
            return reader.decrypt(subject, snapshot);
          },
        },
      },
    );
    const command = {
      ...draft,
      data: { ...draft.data, confirmationToken: await handler.prepare(draft, fixture.actor) },
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => handler.execute(command, fixture.actor)),
    );
    expect(decryptions).toBe(1);
    expect(results.filter((result) => result.value !== undefined)).toHaveLength(1);
    expect(results.find((result) => result.value !== undefined)!.value!.content).toEqual(
      input.content,
    );
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('outcome')
        .where('command_id', '=', draft.commandId)
        .execute(),
    ).toEqual([{ outcome: 'revealed' }]);
    const corrupt = new PostgresConfirmedReportEvidenceReveals(
      database,
      fixture.tokens,
      fixture.key,
      {
        photo: {
          decrypt: () => ({ ...input.content, evidenceObjectRef: `v1.pe.${randomUUID()}` }),
        },
      },
    );
    const changed = { ...draft, commandId: randomUUID(), idempotencyKey: randomUUID() };
    const denied = await corrupt.execute(
      {
        ...changed,
        data: { ...changed.data, confirmationToken: await corrupt.prepare(changed, fixture.actor) },
      },
      fixture.actor,
    );
    expect(denied.value).toBeUndefined();
    expect(denied.result).toBe('failed');
    expect(
      await database
        .selectFrom('moderation.evidence_access_audits')
        .select('outcome')
        .where('command_id', '=', changed.commandId)
        .execute(),
    ).toEqual([{ outcome: 'rejected' }]);
  });
});
