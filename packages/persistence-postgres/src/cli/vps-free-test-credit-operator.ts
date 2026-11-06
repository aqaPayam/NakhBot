import { isAbsolute } from 'node:path';
import { freeTestCreditModeDigest } from '../free-test-credit-mode.js';
import { runVpsFreeTestCreditControl } from '../vps-free-test-credit-control.js';
import {
  readVpsPrivateJson,
  requireVpsRoot,
  reserveVpsPrivateOutput,
} from '../vps-private-files.js';

async function main(): Promise<void> {
  requireVpsRoot();
  const args = process.argv.slice(2),
    digestOnly = args[0] === '--digest',
    paths = digestOnly ? args.slice(1) : args;
  if (paths.length !== (digestOnly ? 2 : 3) || !paths.every(isAbsolute)) throw new Error();
  const command = await readVpsPrivateJson(paths[digestOnly ? 0 : 1]!);
  const binding = digestOnly ? undefined : await readVpsPrivateJson(paths[0]!);
  const output = await reserveVpsPrivateOutput(paths.at(-1)!);
  try {
    const result = digestOnly
      ? { commandDigest: freeTestCreditModeDigest(command) }
      : await runVpsFreeTestCreditControl(binding, command, readVpsPrivateJson);
    await output.writeFile(JSON.stringify(result) + '\n');
    await output.sync();
  } finally {
    await output.close();
  }
  process.stdout.write('Free test credit operation recorded.\n');
}
main().catch(() => {
  process.stderr.write('Free test credit operator unavailable.\n');
  process.exitCode = 1;
});
