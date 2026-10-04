import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** Test-only isolation for fixtures that add immutable RBAC seeds. */
export async function createIsolatedTestDatabase(
  sourceUrl: string,
  prefix: string,
): Promise<Readonly<{ url: string; destroy: () => Promise<void> }>> {
  if (!/^[a-z][a-z0-9_]{0,25}$/u.test(prefix)) throw new Error('Invalid test database prefix.');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const server = new pg.Pool({ connectionString: sourceUrl });
  try {
    await server.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await server.end();
    throw error;
  }
  const target = new URL(sourceUrl);
  target.pathname = `/${name}`;
  return {
    url: target.toString(),
    destroy: async () => {
      try {
        await server.query(`DROP DATABASE "${name}"`);
      } finally {
        await server.end();
      }
    },
  };
}
