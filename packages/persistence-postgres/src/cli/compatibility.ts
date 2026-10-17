import { resolve } from 'node:path';
import { loadConfig } from '@nakh/config';
import { verifyMigrationLedger } from '../migrations.js';
try {
  const config = loadConfig();
  if (!/^[a-f0-9]{40}$/u.test(config.release)) throw new Error('Image source unavailable.');
  const result = await verifyMigrationLedger(
    config.database.url,
    resolve(process.cwd(), 'migrations'),
  );
  console.log(JSON.stringify({ compatible: true, sourceSha: config.release, ...result }));
} catch {
  console.error('Selected image schema compatibility could not be verified. Activation is denied.');
  process.exitCode = 1;
}
