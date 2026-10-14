import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OwnPhotoCollection } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportPhoto, createReportUser } from './testing/report-fixture.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresPhotoManagementStore } from './photo-management-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M8 photo management original life', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_photo_life');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  const store = (): PostgresPhotoManagementStore => new PostgresPhotoManagementStore(database);
  async function owner(): Promise<
    Readonly<{ userId: string; photoId: string; collection: OwnPhotoCollection }>
  > {
    const userId = await createReportUser(database, true);
    await createReportPhoto(database, userId);
    const photoId = await createReportPhoto(database, userId, false);
    const collection = await store().listOwn(userId, 0);
    return { userId, photoId, collection };
  }
  function command(
    userId: string,
    photoId: string,
    expectedProfileVersion = 1,
  ): Parameters<PostgresPhotoManagementStore['mutateOwn']>[0] {
    return {
      userId,
      expectedProductEpoch: 0,
      expectedProfileVersion,
      action: { type: 'select_primary' as const, photoId },
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
      profileEventId: randomUUID(),
      occurredAt: new Date(),
    };
  }
  // Privileged corruption probe only, never evidence of an approved native Return.
  async function changeEpoch(tx: NakhDatabase, userId: string): Promise<void> {
    await sql`ALTER TABLE identity.accounts DISABLE TRIGGER USER`.execute(tx);
    try {
      await tx
        .updateTable('identity.accounts')
        .set({ product_epoch: 1 })
        .where('user_id', '=', userId)
        .execute();
    } finally {
      await sql`ALTER TABLE identity.accounts ENABLE TRIGGER USER`.execute(tx);
    }
  }
  it('requires the captured life for reads and rejects malformed epochs', async () => {
    const f = await owner();
    expect(await store().listOwn(f.userId, 0)).toEqual(f.collection);
    for (const epoch of [1, -1, NaN, 0.5])
      await expect(store().listOwn(f.userId, epoch)).rejects.toMatchObject({
        code: 'capability_denied',
      });
  });
  it('denies mismatched mutation before receipt, audit or event allocation', async () => {
    const f = await owner(),
      input = command(f.userId, f.photoId, f.collection.profileVersion);
    await expect(store().mutateOwn({ ...input, expectedProductEpoch: 1 })).rejects.toMatchObject({
      code: 'capability_denied',
    });
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('actor_user_id', '=', f.userId)
        .where('scope', '=', 'media.manage-own-photos')
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('id', '=', input.auditId)
        .execute(),
    ).toEqual([]);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('id', '=', input.eventId)
        .execute(),
    ).toEqual([]);
    expect(await store().listOwn(f.userId, 0)).toEqual(f.collection);
  });
  it('converges twenty native retries to one mutation and immutable replay result', async () => {
    const f = await owner(),
      input = command(f.userId, f.photoId, f.collection.profileVersion);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        store().mutateOwn({
          ...input,
          commandId: randomUUID(),
          requestId: randomUUID(),
          auditId: randomUUID(),
          eventId: randomUUID(),
          profileEventId: randomUUID(),
        }),
      ),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]!.profileVersion).toBe(f.collection.profileVersion + 1);
    expect(results[0]!.photos.find((photo) => photo.id === f.photoId)?.isPrimary).toBe(true);
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('actor_user_id', '=', f.userId)
        .where('scope', '=', 'media.manage-own-photos')
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', f.userId)
        .where('event_type', '=', 'media.photo-primary-selected.v1')
        .execute(),
    ).toHaveLength(1);
  });
  it('rejects old-life receipt replay and a later-life reuse of the same command identity', async () => {
    const f = await owner(),
      input = command(f.userId, f.photoId, f.collection.profileVersion);
    const result = await store().mutateOwn(input);
    await database.transaction().execute((tx) => changeEpoch(tx, f.userId));
    await expect(store().mutateOwn(input)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(store().listOwn(f.userId, 0)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(store().mutateOwn({ ...input, expectedProductEpoch: 1 })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(await store().listOwn(f.userId, 1)).toEqual(result);
    const receipt = await database
      .selectFrom('platform.idempotency_records')
      .select('response_json')
      .where('actor_user_id', '=', f.userId)
      .where('idempotency_key', '=', input.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(receipt.response_json).toEqual(result);
  });
  it('rechecks the captured epoch after waiting for the stable identity lock', async () => {
    const f = await owner(),
      input = command(f.userId, f.photoId, f.collection.profileVersion);
    let release!: () => void, acquired!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => {
      acquired = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', f.userId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      acquired(
        (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!.pid,
      );
      await wait;
      await changeEpoch(tx, f.userId);
    });
    const pid = await locked;
    const pending = store()
      .mutateOwn(input)
      .then(
        () => undefined,
        (error) => error as unknown,
      );
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        blocked = (
          await sql<{ blocked: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND ${pid}::integer=ANY(pg_blocking_pids(pid))) AS blocked`.execute(
            database,
          )
        ).rows[0]!.blocked;
        if (!blocked) await setTimeout(20);
      }
    } finally {
      release();
      await blocker;
    }
    expect(blocked).toBe(true);
    expect(await pending).toMatchObject({ code: 'capability_denied' });
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('actor_user_id', '=', f.userId)
        .where('scope', '=', 'media.manage-own-photos')
        .execute(),
    ).toEqual([]);
  });
  it('denies reads and delayed writes immediately after an actual deletion tombstone', async () => {
    const { userId } = await createDeletionFixture(database);
    await expect(store().listOwn(userId, 0)).rejects.toMatchObject({ code: 'capability_denied' });
    await expect(store().mutateOwn(command(userId, randomUUID()))).rejects.toMatchObject({
      code: 'capability_denied',
    });
    expect(
      await database
        .selectFrom('platform.idempotency_records')
        .select('id')
        .where('actor_user_id', '=', userId)
        .where('scope', '=', 'media.manage-own-photos')
        .execute(),
    ).toEqual([]);
  });
});
