import { loadConfig } from '@nakh/config';

import { migrationStatus } from '../migrations.js';

const config = loadConfig();
const result = await migrationStatus(config.database.url);
process.stdout.write(`${JSON.stringify(result)}\n`);
