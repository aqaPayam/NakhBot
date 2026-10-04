import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createRetainedReportPhoto } from './testing/report-fixture.js';
import { PostgresModerationOperationalMetricsStore } from './moderation-operational-metrics-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M7 aggregate liveness sampling', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 5,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('returns only finite aggregate ages and completion coverage, including an existing pending report', async () => {
    const photo = await createRetainedReportPhoto(database);
    const health = await new PostgresModerationOperationalMetricsStore(database).measure();
    expect(Object.keys(health).sort()).toEqual([
      'activeReconciliationAgeSeconds',
      'completedReconciliationAgeSeconds',
      'oldestInReviewAgeSeconds',
      'oldestPendingReportAgeSeconds',
      'reconciliationNeverCompleted',
    ]);
    for (const value of Object.values(health))
      expect(Number.isFinite(value) && value >= 0).toBe(true);
    expect([0, 1]).toContain(health.reconciliationNeverCompleted);
    const serialized = JSON.stringify(health);
    for (const privateValue of [
      photo.reportId,
      photo.evidenceId,
      photo.reporter,
      photo.target,
      photo.content.evidenceObjectRef,
    ])
      expect(serialized).not.toContain(privateValue);
  });
});
