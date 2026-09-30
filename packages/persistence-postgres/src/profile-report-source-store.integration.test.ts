import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportTokens } from '@nakh/application';
import type { PrepareReportEvidenceQuery } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { PostgresPrepareProfileReportEvidenceHandler } from './profile-report-source-store.js';
import {
  createReportDelivery,
  createReportLike,
  createReportUser,
} from './testing/report-fixture.js';
import { PostgresProfileReportSourceStore } from './profile-report-source-store.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(databaseUrl === undefined)('authoritative profile report sources', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 10,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 25000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('requires delivery success and exact viewer ownership before accepting discovery evidence', async () => {
    const viewer = await createReportUser(database),
      target = await createReportUser(database, true);
    const stranger = await createReportUser(database),
      store = new PostgresProfileReportSourceStore(database);
    for (const state of ['failed', 'reserved', 'delivered'] as const) {
      const referenceId = await createReportDelivery(database, viewer, target, state);
      const source = { kind: 'delivered_candidate' as const, referenceId };
      expect(await store.resolve(stranger, source)).toBeUndefined();
      expect(await store.resolve(target, source)).toBeUndefined();
      const resolved = await store.resolve(viewer, source);
      if (state === 'delivered') expect(resolved?.targetUserId).toBe(target);
      else expect(resolved).toBeUndefined();
      if (state === 'reserved')
        await database
          .updateTable('discovery.candidate_deliveries')
          .set({ state: 'failed', failed_at: new Date(), updated_at: new Date() })
          .where('id', '=', referenceId)
          .execute();
    }
  });
  it('resolves only the receiving user and does not expose source or profile content', async () => {
    const reporter = await createReportUser(database),
      target = await createReportUser(database, true),
      stranger = await createReportUser(database);
    const likeId = await createReportLike(database, reporter, target);
    const values = new Map<string, string>();
    const tokens = new ReportTokens(
      {
        get: (id) => Promise.resolve(values.get(id)),
        putIfAbsent: (id, value) => {
          values.set(id, value);
          return Promise.resolve(true);
        },
      },
      Buffer.alloc(32, 4),
    );
    const handler = new PostgresPrepareProfileReportEvidenceHandler(database, tokens);
    const source = { kind: 'received_like' as const, referenceId: likeId };
    const query = async (
      userId: string,
      referenceId = likeId,
    ): Promise<PrepareReportEvidenceQuery> => ({
      actor: { kind: 'user' as const, userId },
      requestId: randomUUID(),
      sourceActionToken: (await tokens.issueSource(userId, { ...source, referenceId })).token,
      requestedEvidenceTypes: ['profile' as const],
    });
    const input = await query(reporter);
    const result = await handler.execute(input, input.actor);
    const profile = await database
      .selectFrom('profile.profiles')
      .select('id')
      .where('user_id', '=', target)
      .executeTakeFirstOrThrow();
    expect(await tokens.resolveIntent(result.evidenceIntentToken, reporter)).toEqual({
      source,
      targetUserId: target,
      evidence: [{ evidenceType: 'profile', referenceId: profile.id }],
    });
    for (const user of [stranger, target]) {
      const denied = await query(user);
      await expect(handler.execute(denied, denied.actor)).rejects.toMatchObject({
        code: 'report_unavailable',
      });
    }
    const missing = await query(reporter, randomUUID());
    await expect(handler.execute(missing, missing.actor)).rejects.toMatchObject({
      code: 'report_unavailable',
    });
    const encoded = JSON.stringify(result);
    for (const secret of [reporter, target, likeId, profile.id, 'Private report bio'])
      expect(encoded).not.toContain(secret);
    expect(
      await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', reporter)
        .execute(),
    ).toHaveLength(0);
  });
});
