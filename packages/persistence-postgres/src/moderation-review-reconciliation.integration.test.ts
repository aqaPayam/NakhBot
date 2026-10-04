import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AesGcmReviewNoteProtector } from '@nakh/application';
import type {
  PrepareAccountModerationActionCommand,
  PrepareReviewDecisionCommand,
} from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createRetainedPhotoReview, createReportFixtureAdmin } from './testing/report-fixture.js';
import { confirmationFixture } from './testing/admin-confirmation.js';
import { PostgresConfirmedAccountActions } from './confirmed-account-store.js';
import { PostgresConfirmedReviewDecisions } from './confirmed-review-decision-store.js';
import {
  scanModerationReviews,
  scanModerationActions,
} from './moderation-review-reconciliation.js';
import { reconciliationCursorBefore as beforeId } from './testing/reconciliation-cursor.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('historical M7 review/action reconciliation', () => {
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
    await database?.destroy();
  });
  it('preserves finalized report effects and guest restoration, detects drift, and never copies restricted content', async () => {
    const photo = await createRetainedPhotoReview(database),
      adminId = await createReportFixtureAdmin(database);
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'moderator',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const fixture = await confirmationFixture(database, adminId);
    await database
      .updateTable('moderation.moderation_reviews')
      .set({
        status: 'in_review',
        assigned_admin_id: adminId,
        assigned_at: sql<Date>`clock_timestamp()`,
        updated_at: sql<Date>`clock_timestamp()`,
        version: 2,
      })
      .where('id', '=', photo.reviewId)
      .execute();
    const accounts = new PostgresConfirmedAccountActions(database, fixture.tokens, fixture.key);
    const apply = async (
      targetId: string,
      action: 'restrict_user' | 'unrestrict_user',
      version: number,
      reportId?: string,
    ): Promise<string> => {
      const draft: PrepareAccountModerationActionCommand = {
        actor: fixture.actor,
        commandType: 'moderation.apply-account-action',
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          expectedTargetVersion: version,
          action,
          reason: 'Safety review',
          adminActionToken: await fixture.issue({
            commandCode: 'moderation.apply-account-action',
            requiredPermission: action,
            targetType: 'user',
            targetId,
            expectedTargetVersion: version,
            ...(reportId === undefined ? {} : { sourceReportId: reportId }),
          }),
        },
      };
      const result = await accounts.execute(
        {
          ...draft,
          data: { ...draft.data, confirmationToken: await accounts.prepare(draft, fixture.actor) },
        },
        fixture.actor,
      );
      expect(result.result).toBe('succeeded');
      return result.value!.actionId;
    };
    const actionId = await apply(photo.target, 'restrict_user', 1, photo.reportId);
    const decisions = new PostgresConfirmedReviewDecisions(
      database,
      fixture.tokens,
      fixture.key,
      new AesGcmReviewNoteProtector('reconciliation-note', 1, Buffer.alloc(32, 71)),
    );
    const decision: PrepareReviewDecisionCommand = {
      actor: fixture.actor,
      commandType: 'moderation.decide-review',
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: {
        decision: 'actioned',
        expectedTargetVersion: 2,
        reason: 'Finalize successful effect',
        note: 'Private reconciliation review note',
        adminActionToken: await fixture.issue({
          commandCode: 'moderation.decide-review',
          requiredPermission: 'view_reports',
          targetType: 'moderation_review',
          targetId: photo.reviewId,
          expectedTargetVersion: 2,
        }),
      },
    };
    expect(
      (
        await decisions.execute(
          {
            ...decision,
            data: {
              ...decision.data,
              confirmationToken: await decisions.prepare(decision, fixture.actor),
            },
          },
          fixture.actor,
        )
      ).result,
    ).toBe('succeeded');
    await apply(photo.target, 'unrestrict_user', 2);
    expect(
      (await scanModerationActions(database, { phase: 'actions', lastId: beforeId(actionId) }, 1))
        .findings,
    ).toEqual([]);
    expect(
      (
        await scanModerationReviews(
          database,
          { phase: 'reviews', lastId: beforeId(photo.reviewId) },
          1,
        )
      ).findings,
    ).toEqual([]);
    const guestId = randomUUID(),
      now = new Date();
    await database
      .insertInto('identity.users')
      .values({ id: guestId, created_at: now, updated_at: now, last_activity_at: now })
      .execute();
    await database
      .insertInto('identity.accounts')
      .values({ user_id: guestId, state: 'guest', state_reason: null, state_changed_at: now })
      .execute();
    await apply(guestId, 'restrict_user', 1);
    const restoredId = await apply(guestId, 'unrestrict_user', 2);
    expect(
      (
        await database
          .selectFrom('identity.accounts')
          .select('state')
          .where('user_id', '=', guestId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('guest');
    expect(
      (await scanModerationActions(database, { phase: 'actions', lastId: beforeId(restoredId) }, 1))
        .findings,
    ).toEqual([]);
    const report = await database
      .selectFrom('moderation.reports')
      .select(['status', 'version'])
      .where('id', '=', photo.reportId)
      .executeTakeFirstOrThrow();
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .updateTable('moderation.reports')
          .set({ status: 'dismissed', version: report.version + 1 })
          .where('id', '=', photo.reportId)
          .execute();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });
    try {
      const drift = await scanModerationReviews(
        database,
        { phase: 'reviews', lastId: beforeId(photo.reviewId) },
        1,
      );
      expect(drift.findings).toEqual([
        {
          anomalyType: 'review_report_state_mismatch',
          entityType: 'moderation_review',
          entityId: photo.reviewId,
          keyId: photo.reviewId,
          safeDetail: {},
        },
      ]);
      expect(JSON.stringify(drift)).not.toContain('Private');
      expect(JSON.stringify(drift)).not.toContain(photo.reporter);
    } finally {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role = replica`.execute(connection);
        try {
          await connection
            .updateTable('moderation.reports')
            .set(report)
            .where('id', '=', photo.reportId)
            .execute();
        } finally {
          await sql`SET session_replication_role = origin`.execute(connection);
        }
      });
    }
  });
});
