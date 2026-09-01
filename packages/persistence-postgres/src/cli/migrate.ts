import { resolve } from 'node:path';

import { loadConfig } from '@nakh/config';

import { runMigrations } from '../migrations.js';

const config = loadConfig();
const result = await runMigrations(config.database.url, resolve(process.cwd(), 'migrations'));
process.stdout.write(`${JSON.stringify(result)}\n`);
