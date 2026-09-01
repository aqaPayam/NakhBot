import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

const { Pool } = pg;

export type MigrationResult = Readonly<{ applied: readonly string[]; existing: readonly string[] }>;

async function migrationFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((name) => /^\d{6}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
}

export async function runMigrations(
  databaseUrl: string,
  directory: string,
): Promise<MigrationResult> {
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'nakh-migration' });
  const client = await pool.connect();
  const applied: string[] = [];
  const existing: string[] = [];
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS platform`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform.schema_migrations (
        name text PRIMARY KEY,
        sha256 text NOT NULL CHECK (char_length(sha256) = 64),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`SELECT pg_advisory_lock(hashtext('nakh-schema-migrations'))`);
    for (const name of await migrationFiles(directory)) {
      const sql = await readFile(join(directory, name), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const row = await client.query<{ sha256: string }>(
        'SELECT sha256 FROM platform.schema_migrations WHERE name = $1',
        [name],
      );
      if (row.rowCount === 1) {
        if (row.rows[0]?.sha256 !== sha256) {
          throw new Error(`Applied migration ${name} has been modified.`);
        }
        existing.push(name);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL lock_timeout = '1s'`);
        await client.query(`SET LOCAL statement_timeout = '30s'`);
        await client.query(sql);
        await client.query(
          'INSERT INTO platform.schema_migrations (name, sha256) VALUES ($1, $2)',
          [name, sha256],
        );
        await client.query('COMMIT');
        applied.push(name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return { applied, existing };
  } finally {
    await client
      .query(`SELECT pg_advisory_unlock(hashtext('nakh-schema-migrations'))`)
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}

export async function verifyMigrations(databaseUrl: string, directory: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'nakh-verify' });
  const verified: string[] = [];
  try {
    for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
      await pool.query(await readFile(join(directory, name), 'utf8'));
      verified.push(name);
    }
    return verified;
  } finally {
    await pool.end();
  }
}

export async function migrationStatus(
  databaseUrl: string,
): Promise<ReadonlyArray<Readonly<{ name: string; appliedAt: Date }>>> {
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'nakh-status' });
  try {
    const result = await pool.query<{ name: string; applied_at: Date }>(
      'SELECT name, applied_at FROM platform.schema_migrations ORDER BY name',
    );
    return result.rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
  } finally {
    await pool.end();
  }
}
