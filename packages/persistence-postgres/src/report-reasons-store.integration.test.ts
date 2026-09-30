import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresGetReportReasonsHandler } from './report-reasons-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('current report reason catalog', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 4,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 1000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  it('returns ordered active labels without row identities and rechecks current account eligibility', async () => {
    const userId = await createReportUser(database),
      inactiveId = randomUUID();
    const code = `inactive_${inactiveId.replaceAll('-', '')}`;
    await database
      .insertInto('moderation.report_reasons')
      .values({
        id: inactiveId,
        code,
        label_key: `report.reason.${code}`,
        is_active: false,
        display_order: 100000000 + Math.floor(Math.random() * 100000000),
      })
      .execute();
    const actor = { kind: 'user' as const, userId },
      query = { actor, requestId: randomUUID() };
    const handler = new PostgresGetReportReasonsHandler(database);
    const catalog = await handler.execute(query, actor);
    expect(catalog.items.map((item) => item.code)).toEqual([
      'fake_profile',
      'harassment',
      'inappropriate_photo',
      'spam_or_scam',
      'under_18',
      'offensive_behavior',
      'other',
    ]);
    for (const item of catalog.items)
      expect(item).toEqual({ code: item.code, labelKey: `report.reason.${item.code}` });
    expect(JSON.stringify(catalog)).not.toContain(inactiveId);
    expect(JSON.stringify(catalog)).not.toContain(userId);
    for (const state of ['restricted', 'banned'] as const) {
      await database
        .updateTable('identity.accounts')
        .set({
          state,
          state_reason: 'catalog_fixture',
          state_changed_at: sql<Date>`GREATEST(clock_timestamp(), state_changed_at + interval '1 microsecond')`,
          version: sql<number>`version + 1`,
        })
        .where('user_id', '=', userId)
        .execute();
      if (state === 'restricted') expect(await handler.execute(query, actor)).toEqual(catalog);
      else
        await expect(handler.execute(query, actor)).rejects.toMatchObject({
          code: 'report_unavailable',
        });
    }
  });
});
