import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql, type Selectable } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase, type ReconciliationRunTable } from './database.js';
import { runMigrations } from './migrations.js';
import { createRetainedReportPhoto } from './testing/report-fixture.js';
import { PostgresModerationReconciliationStore } from './moderation-reconciliation-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('bounded M7 report/evidence reconciliation', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 20,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
  });
  it('serializes starts and batches, resumes after audit-write failure, and quarantines without content or repeated findings', async () => {
    const photo = await createRetainedReportPhoto(database);
    const snapshot = await database
      .selectFrom('moderation.report_snapshots')
      .selectAll()
      .where('report_evidence_id', '=', photo.evidenceId)
      .executeTakeFirstOrThrow();
    // Disposable corruption is isolated to one connection; ordinary writes cannot delete captures.
    await database.connection().execute(async (connection) => {
      await sql`SET session_replication_role = replica`.execute(connection);
      try {
        await connection
          .deleteFrom('moderation.report_snapshots')
          .where('id', '=', snapshot.id)
          .execute();
      } finally {
        await sql`SET session_replication_role = origin`.execute(connection);
      }
    });
    const store = new PostgresModerationReconciliationStore(database);
    const suffix = randomUUID().replaceAll('-', ''),
      functionName = `fail_m7_finding_${suffix}`;
    let installed = false;
    try {
      const starts = await Promise.all(
        Array.from({ length: 12 }, () => store.resumeOrStart(randomUUID())),
      );
      expect(new Set(starts).size).toBe(1);
      const runId = starts[0]!;
      const first = await Promise.all([
        store.scanNextBatch(runId, 1),
        store.scanNextBatch(runId, 1),
      ]);
      expect(first.every((batch) => batch.scannedCount <= 1)).toBe(true);
      const state = (): Promise<
        Pick<
          Selectable<ReconciliationRunTable>,
          'cursor' | 'scanned_count' | 'anomaly_count' | 'status'
        >
      > =>
        database
          .selectFrom('billing.reconciliation_runs')
          .select(['cursor', 'scanned_count', 'anomaly_count', 'status'])
          .where('id', '=', runId)
          .executeTakeFirstOrThrow();
      expect(BigInt((await state()).scanned_count)).toBe(
        BigInt(first.reduce((sum, batch) => sum + batch.scannedCount, 0)),
      );
      await sql
        .raw(
          `CREATE FUNCTION billing.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.entity_id = '${photo.reportId}'::uuid AND NEW.anomaly_type = 'report_capture_missing_or_invalid' THEN
          RAISE EXCEPTION 'injected reconciliation finding failure'; END IF; RETURN NEW; END $$`,
        )
        .execute(database);
      await sql
        .raw(
          `CREATE TRIGGER ${functionName} BEFORE INSERT ON billing.reconciliation_anomalies
        FOR EACH ROW EXECUTE FUNCTION billing.${functionName}()`,
        )
        .execute(database);
      installed = true;
      let failed = false;
      for (let iteration = 0; iteration < 100 && !failed; iteration++) {
        const before = await state();
        try {
          await store.scanNextBatch(runId, 500);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain('injected reconciliation finding failure');
          expect(await state()).toEqual(before);
          failed = true;
        }
      }
      expect(failed).toBe(true);
      expect(
        await database
          .selectFrom('billing.reconciliation_anomalies')
          .select('id')
          .where('entity_id', '=', photo.reportId)
          .execute(),
      ).toHaveLength(0);
      await sql
        .raw(`DROP TRIGGER ${functionName} ON billing.reconciliation_anomalies`)
        .execute(database);
      await sql.raw(`DROP FUNCTION billing.${functionName}()`).execute(database);
      installed = false;
      const restarted = new PostgresModerationReconciliationStore(database);
      expect(await restarted.resumeOrStart(randomUUID())).toBe(runId);
      let completed = false;
      for (let iteration = 0; iteration < 100 && !completed; iteration++)
        completed = (await restarted.scanNextBatch(runId, 500)).completed;
      expect(completed).toBe(true);
      await expect(restarted.scanNextBatch(runId, 500)).rejects.toMatchObject({ code: 'conflict' });
      const findings = await database
        .selectFrom('billing.reconciliation_anomalies')
        .select(['anomaly_type', 'disposition', 'safe_detail'])
        .where('entity_id', '=', photo.reportId)
        .execute();
      expect(findings).toEqual([
        {
          anomaly_type: 'report_capture_missing_or_invalid',
          disposition: 'quarantined',
          safe_detail: { evidenceType: 'photo' },
        },
      ]);
      expect(JSON.stringify(findings)).not.toContain(snapshot.content_sha256);
      expect(JSON.stringify(findings)).not.toContain(photo.reporter);
      // Repeated runs preserve one finding for the same structural incident.
      const nextRun = await restarted.resumeOrStart(randomUUID());
      completed = false;
      for (let iteration = 0; iteration < 100 && !completed; iteration++)
        completed = (await restarted.scanNextBatch(nextRun, 500)).completed;
      expect(completed).toBe(true);
      expect(
        await database
          .selectFrom('billing.reconciliation_anomalies')
          .select('id')
          .where('entity_id', '=', photo.reportId)
          .execute(),
      ).toHaveLength(1);
    } finally {
      if (installed) {
        await sql
          .raw(`DROP TRIGGER ${functionName} ON billing.reconciliation_anomalies`)
          .execute(database);
        await sql.raw(`DROP FUNCTION billing.${functionName}()`).execute(database);
      }
      await database.insertInto('moderation.report_snapshots').values(snapshot).execute();
    }
    expect(
      await database
        .selectFrom('media.report_photo_evidence_holds')
        .select('report_evidence_id')
        .where('report_evidence_id', '=', photo.evidenceId)
        .execute(),
    ).toHaveLength(1);
  });
});
