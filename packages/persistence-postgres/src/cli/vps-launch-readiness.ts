import { isAbsolute } from 'node:path';
import { readVpsLaunchReadiness } from '../vps-launch-readiness.js';
import {
  readVpsPrivateJson,
  requireVpsRoot,
  reserveVpsPrivateOutput,
} from '../vps-private-files.js';

async function main(): Promise<void> {
  requireVpsRoot();
  const paths = process.argv.slice(2);
  if (paths.length !== 2 || !paths.every(isAbsolute)) throw new Error();
  const binding = await readVpsPrivateJson(paths[0]!);
  const output = await reserveVpsPrivateOutput(paths[1]!);
  try {
    const receipt = await readVpsLaunchReadiness(binding, readVpsPrivateJson);
    await output.writeFile(JSON.stringify(receipt) + '\n');
    await output.sync();
  } finally {
    await output.close();
  }
  process.stdout.write('Private VPS readiness recorded; launch remains unauthorized.\n');
}
main().catch(() => {
  process.stderr.write('Private VPS readiness unavailable.\n');
  process.exitCode = 1;
});
