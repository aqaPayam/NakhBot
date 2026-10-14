import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { PostgresLegacyOpaqueRetirementAudit } from './legacy-opaque-retirement-audit.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('native legacy-cache cutover auditing', () => {
  let database: NakhDatabase,
    isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
    audit: PostgresLegacyOpaqueRetirementAudit;
  const input = {
    namespaceHash: createHash('sha256').update('synthetic namespace').digest('hex'),
    cursorHash: createHash('sha256').update('0').digest('hex'),
    limit: 7,
  };
  const observation = { removed: 7, nextCursorHash: input.cursorHash, hasMore: true };
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_opaque_audits');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 15000,
    });
    audit = new PostgresLegacyOpaqueRetirementAudit(database);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  it('retains exact content-free authorization and serializes twenty identical observations once', async () => {
    const id = await audit.prepare(input);
    const prepared = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(prepared.metadata).toEqual(input);
    expect(prepared.actor_type).toBe('system');
    expect(prepared.actor_user_id).toBeNull();
    expect(prepared.subject_id).toBe(id);
    expect(prepared.request_id).toBe(id);
    expect(prepared.command_id).toBe(id);
    await Promise.all(Array.from({ length: 20 }, () => audit.observe(id, observation)));
    const rows = await database
      .selectFrom('platform.audit_logs')
      .selectAll()
      .where('subject_id', '=', id)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id !== id)?.metadata).toEqual(observation);
    await expect(audit.observe(id, { ...observation, removed: 6 })).rejects.toThrow(/unavailable/);
    await expect(
      database
        .updateTable('platform.audit_logs')
        .set({ result_code: 'altered' })
        .where('id', '=', id)
        .execute(),
    ).rejects.toBeDefined();
  });
  it('rejects borrowed or missing authorization, malformed hashes and observations above the authorized bound', async () => {
    const id = await audit.prepare(input);
    for (const altered of [
      { ...input, namespaceHash: 'private namespace' },
      { ...input, cursorHash: '' },
      { ...input, limit: 101 },
    ])
      await expect(audit.prepare(altered)).rejects.toThrow(/unavailable/);
    await expect(audit.observe(randomUUID(), observation)).rejects.toThrow(/unavailable/);
    await expect(audit.observe(id, { ...observation, removed: 8 })).rejects.toThrow(/unavailable/);
    await expect(
      audit.observe(id, { ...observation, nextCursorHash: 'untrusted cursor' }),
    ).rejects.toThrow(/unavailable/);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', id)
        .execute(),
    ).toHaveLength(1);
  });
  it('does not invent successful observations when the required native write fails', async () => {
    const id = await audit.prepare(input);
    await sql`CREATE FUNCTION platform.m8_opaque_observation_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='platform.legacy-opaque-retirement-observed.v1' THEN RAISE EXCEPTION 'private synthetic failure'; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_opaque_observation_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.m8_opaque_observation_fault()`.execute(
      database,
    );
    try {
      await expect(audit.observe(id, observation)).rejects.toThrow(
        'Legacy opaque retirement audit is unavailable.',
      );
      expect(
        await database
          .selectFrom('platform.audit_logs')
          .select('id')
          .where('subject_id', '=', id)
          .execute(),
      ).toHaveLength(1);
    } finally {
      await sql`DROP TRIGGER m8_opaque_observation_fault ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION platform.m8_opaque_observation_fault()`.execute(database);
    }
    await audit.observe(id, observation);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', id)
        .execute(),
    ).toHaveLength(2);
  });
  it('binds the authorized removal bound to the observation captured before database waits', async () => {
    const id = await audit.prepare(input);
    const mutable = { ...observation, removed: 8 };
    const pending = audit.observe(id, mutable);
    mutable.removed = 0;
    await expect(pending).rejects.toThrow(/unavailable/);
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('subject_id', '=', id)
        .execute(),
    ).toHaveLength(1);
  });
  it('does not return authority if its mandatory initial audit cannot be persisted', async () => {
    await sql`CREATE FUNCTION platform.m8_opaque_authorization_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='platform.legacy-opaque-retirement-authorized.v1' THEN RAISE EXCEPTION 'private synthetic failure'; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER m8_opaque_authorization_fault BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION platform.m8_opaque_authorization_fault()`.execute(
      database,
    );
    try {
      await expect(audit.prepare(input)).rejects.toThrow(
        'Legacy opaque retirement audit is unavailable.',
      );
    } finally {
      await sql`DROP TRIGGER m8_opaque_authorization_fault ON platform.audit_logs`.execute(
        database,
      );
      await sql`DROP FUNCTION platform.m8_opaque_authorization_fault()`.execute(database);
    }
  });
});
