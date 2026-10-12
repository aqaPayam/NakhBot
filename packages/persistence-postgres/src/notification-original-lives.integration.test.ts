import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createReportUser } from './testing/report-fixture.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresNotificationStore } from './notification-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 populated original notification-life upgrade', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let userId: string, notificationId: string, deliveryId: string;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_notice_lives');
    const directory = await mkdtemp(join(tmpdir(), 'm8-notice108-'));
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 108)
          await copyFile(join(resolve('migrations'), file), join(directory, file));
      await runMigrations(isolated.url, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 10000,
    });
    userId = await createReportUser(database, true);
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: new Date(), updated_at: new Date() })
      .execute();
    const cause = randomUUID();
    // Historical producer omits the not-yet-existing epoch, as migration 108 did.
    const recorded = await new PostgresNotificationStore(database).record({
      userId,
      type: 'safety_notice',
      titleKey: 'notification.safety_notice.title',
      bodyKey: 'notification.safety_notice.body',
      payload: { cause },
      deduplicationKey: `legacy-notice:${cause}`,
      correlationId: cause,
      causationId: cause,
    });
    notificationId = recorded.notificationId;
    deliveryId = recorded.telegramDeliveryId!;
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });

  it('rejects ambiguous legacy ownership, rolls back, and upgrades exactly once across twenty connections', async () => {
    const snapshot = async (): Promise<unknown[]> =>
      Promise.all([
        sql`SELECT id,user_id,notification_type,category,title_key,body_key,payload,payload_schema_version,status,deduplication_key,created_at::text,read_at::text,version FROM notification.notifications WHERE id=${notificationId}::uuid`
          .execute(database)
          .then((result) => result.rows),
        database
          .selectFrom('notification.notification_deliveries')
          .selectAll()
          .where('id', '=', deliveryId)
          .execute(),
        database
          .selectFrom('platform.outbox_events')
          .selectAll()
          .where('aggregate_id', '=', deliveryId)
          .execute(),
        database
          .selectFrom('billing.credit_transactions')
          .selectAll()
          .where('user_id', '=', userId)
          .execute(),
      ]);
    const original = await snapshot();
    const setEpoch = async (epoch: number): Promise<void> => {
      await database.connection().execute(async (connection) => {
        await sql`SET session_replication_role=replica`.execute(connection);
        try {
          await sql`UPDATE identity.accounts SET product_epoch=${epoch} WHERE user_id=${userId}::uuid`.execute(
            connection,
          );
        } finally {
          await sql`SET session_replication_role=origin`.execute(connection);
        }
      });
    };
    // Deliberate negative corruption only, not a genuine return.
    await setEpoch(1);
    try {
      await expect(runMigrations(isolated.url, resolve('migrations'))).rejects.toThrow(
        'legacy notification lacks its original recipient life',
      );
      expect(
        (
          await sql`SELECT column_name FROM information_schema.columns WHERE table_schema='notification' AND table_name='notifications' AND column_name='product_epoch'`.execute(
            database,
          )
        ).rows,
      ).toEqual([]);
      expect(await snapshot()).toEqual(original);
    } finally {
      await setEpoch(0);
    }
    const results = await Promise.all(
      Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
    );
    expect(results.flatMap((result) => result.applied)).toEqual([
      '000109_m8_notification_original_lives.sql',
      '000110_m8_nakh_retained_links.sql',
      '000111_m8_funded_nakh_archival.sql',
      '000112_m8_pending_nakh_references.sql',
      '000113_m8_pending_funding_binding.sql',
    ]);
    expect(await snapshot()).toEqual(original);
    expect(
      await database
        .selectFrom('notification.notifications')
        .select('product_epoch')
        .where('id', '=', notificationId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ product_epoch: 0 });
    expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
    expect(await verifyMigrations(isolated.url, resolve('migrations/verify'))).toContain(
      '000109_m8_notification_original_lives.sql',
    );
    assertDeletionCatalogCoverage(await readDeletionCatalog(database));
  });
});
