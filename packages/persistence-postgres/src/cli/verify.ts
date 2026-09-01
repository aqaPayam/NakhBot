import { resolve } from 'node:path';

import { loadConfig } from '@nakh/config';

import { verifyMigrations } from '../migrations.js';

const config = loadConfig();
const result = await verifyMigrations(
  config.database.url,
  resolve(process.cwd(), 'migrations/verify'),
);
process.stdout.write(`${JSON.stringify({ verified: result })}\n`);
