import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserSessionActor } from '@nakh/application';
import type { SaveExploreFilterCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { PostgresExploreFilterStore } from './explore-filter-store.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('owned Explore filters', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    database: NakhDatabase,
    userId: string,
    owner: UserSessionActor,
    store: PostgresExploreFilterStore;
  const effects = (): Readonly<{ auditId: string; eventId: string; processedAt: Date }> => ({
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: new Date(),
  });
  const command = (data: SaveExploreFilterCommand['data']): SaveExploreFilterCommand => ({
    commandId: randomUUID(),
    commandType: 'discovery.save-explore-filter',
    schemaVersion: 1,
    actor: { kind: 'user', userId },
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data,
  });
  const defaults = async (): Promise<SaveExploreFilterCommand['data']> => {
    const f = await store.getOwnFilter(userId);
    return {
      targetGenderOptionIds: [...f.targetGenderOptionIds],
      minAge: 24,
      maxAge: 40,
      cityId: f.city.id,
      ...(f.version === undefined ? {} : { expectedVersion: f.version }),
    };
  };
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'owned_explore_filters');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
  });
  beforeEach(async () => {
    userId = await createReportUser(database, true);
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (!grant) throw new Error('Synthetic user session missing');
    owner = { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
    store = new PostgresExploreFilterStore(database, owner);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  it('shows the native default ages, location and allowed preference without persisting a filter', async () => {
    const f = await store.getOwnFilter(userId),
      year = (
        await sql<{
          year: number;
        }>`SELECT extract(year FROM current_timestamp)::integer AS year`.execute(database)
      ).rows[0]!.year;
    expect(f.version).toBeUndefined();
    expect(f.minAge).toBe(year - 1995 - 5);
    expect(f.maxAge).toBe(year - 1995 + 5);
    expect(f.city.code).toBe('tehran');
    expect(f.preferenceAdjusted).toBe(false);
    expect(f.targetGenderOptionIds).toEqual(f.allowedGenders.map((g) => g.id).sort());
    expect(JSON.stringify(f)).not.toContain('Private report bio');
    expect(
      await database
        .selectFrom('discovery.explore_filters')
        .select('user_id')
        .where('user_id', '=', userId)
        .execute(),
    ).toEqual([]);
    expect(() => new PostgresExploreFilterStore(database).getOwnFilter(userId)).toThrow();
  });
  it('converges twenty concurrent identical saves to one audited version and one outbox event', async () => {
    const cmd = command(await defaults()),
      results = await Promise.all(
        Array.from({ length: 20 }, () => store.saveFilter(cmd, effects())),
      );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.version === 1)).toBe(true);
    expect(await store.getOwnFilter(userId)).toMatchObject({ version: 1, minAge: 24, maxAge: 40 });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', userId)
        .where('event_type', '=', 'discovery.filter-saved.v1')
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom('platform.outbox_events')
        .select('id')
        .where('aggregate_id', '=', userId)
        .where('event_type', '=', 'discovery.filter-saved.v1')
        .execute(),
    ).toHaveLength(1);
  });
  it('keeps both default age bounds valid for an older complete profile', async () => {
    const template = await database
        .selectFrom('profile.profiles')
        .selectAll()
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow(),
      aged = await createReportUser(database),
      now = new Date();
    await database
      .insertInto('profile.profiles')
      .values({
        ...template,
        id: randomUUID(),
        user_id: aged,
        birth_year: 1900,
        created_at: now,
        updated_at: now,
        completed_at: now,
      })
      .execute();
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId: aged, productEpoch: 0 },
      randomUUID(),
    );
    expect(
      await new PostgresExploreFilterStore(database, {
        kind: 'user',
        userId: aged,
        productEpoch: 0,
        sessionGrantId: grant!.id,
      }).getOwnFilter(aged),
    ).toMatchObject({ minAge: 120, maxAge: 120 });
  });
  it('lets only one competing edit commit against the same original version', async () => {
    await store.saveFilter(command(await defaults()), effects());
    const original = await defaults(),
      results = await Promise.allSettled([
        store.saveFilter(command({ ...original, minAge: 25 }), effects()),
        store.saveFilter(command({ ...original, minAge: 26 }), effects()),
      ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'version_conflict' },
    });
    expect((await store.getOwnFilter(userId)).version).toBe(2);
  });
  it('rechecks the original revoked session before reads or cached outcomes despite a newer sign-in', async () => {
    const cmd = command(await defaults());
    await store.saveFilter(cmd, effects());
    const sessions = new PostgresUserSessionStore(database);
    await sessions.revoke(owner, owner.sessionGrantId, randomUUID());
    const fresh = await sessions.issue(owner, randomUUID());
    expect(fresh).toBeDefined();
    await expect(store.getOwnFilter(userId)).rejects.toMatchObject({ status: 401 });
    await expect(store.saveFilter(cmd, effects())).rejects.toMatchObject({ status: 401 });
    await expect(
      new PostgresExploreFilterStore(database, {
        ...owner,
        sessionGrantId: fresh!.id,
      }).getOwnFilter(userId),
    ).resolves.toMatchObject({ version: 1 });
  });
  it('denies borrowed owners and checks current account capability before a cached save', async () => {
    const cmd = command(await defaults());
    await store.saveFilter(cmd, effects());
    const stranger = await createReportUser(database, true);
    expect(() => store.getOwnFilter(stranger)).toThrow();
    await expect(
      store.saveFilter({ ...cmd, actor: { kind: 'user', userId: stranger } }, effects()),
    ).rejects.toMatchObject({ status: 401 });
    await database
      .updateTable('identity.accounts')
      .set({ state: 'restricted' })
      .where('user_id', '=', userId)
      .execute();
    await expect(store.saveFilter(cmd, effects())).rejects.toMatchObject({ status: 403 });
    await expect(store.getOwnFilter(userId)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects an active city whose province or country was withdrawn and rolls back its claim', async () => {
    const data = await defaults(),
      hierarchy = await database
        .selectFrom('catalog.cities as c')
        .innerJoin('catalog.provinces as p', 'p.id', 'c.province_id')
        .select(['p.id', 'p.country_id'])
        .where('c.id', '=', data.cityId)
        .executeTakeFirstOrThrow();
    for (const [table, id] of [
      ['catalog.provinces', hierarchy.id],
      ['catalog.countries', hierarchy.country_id],
    ] as const) {
      const cmd = command(data);
      await database.updateTable(table).set({ is_active: false }).where('id', '=', id).execute();
      try {
        await expect(store.saveFilter(cmd, effects())).rejects.toMatchObject({ status: 400 });
        expect(
          await database
            .selectFrom('platform.idempotency_records')
            .select('id')
            .where('id', '=', cmd.commandId)
            .execute(),
        ).toEqual([]);
      } finally {
        await database.updateTable(table).set({ is_active: true }).where('id', '=', id).execute();
      }
    }
  });
  it('discloses changed preference choices without silently mutating the persisted filter', async () => {
    await store.saveFilter(command(await defaults()), effects());
    await database
      .updateTable('profile.profiles')
      .set({ gender_preference_id: '20000000-0000-4000-8000-000000000012' })
      .where('user_id', '=', userId)
      .execute();
    const f = await store.getOwnFilter(userId);
    expect(f.preferenceAdjusted).toBe(true);
    expect(f.allowedGenders).toHaveLength(1);
    expect(f.targetGenderOptionIds).toEqual([f.allowedGenders[0]!.id]);
    expect(
      await database
        .selectFrom('discovery.explore_filter_genders')
        .select('gender_option_id')
        .where('user_id', '=', userId)
        .execute(),
    ).not.toHaveLength(1);
    await store.saveFilter(command(await defaults()), effects());
    expect(await store.getOwnFilter(userId)).toMatchObject({
      version: 2,
      preferenceAdjusted: false,
    });
  });
});
