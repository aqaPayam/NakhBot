import { isAbsolute } from 'node:path';
import { runVpsMfaOperator, vpsMfaCommandDigest } from '../vps-trusted-operators.js';
import {
  readVpsPrivateJson,
  requireVpsRoot,
  reserveVpsPrivateOutput,
} from '../vps-private-files.js';

async function main(): Promise<void> {
  requireVpsRoot();
  const args = process.argv.slice(2),
    digestOnly = args[0] === '--digest';
  const paths = digestOnly ? args.slice(1) : args;
  if (paths.length !== (digestOnly ? 2 : 3) || !paths.every(isAbsolute)) throw new Error();
  const binding = digestOnly ? undefined : await readVpsPrivateJson(paths[0]!);
  const command = await readVpsPrivateJson(paths[digestOnly ? 0 : 1]!);
  const output = await reserveVpsPrivateOutput(paths.at(-1)!);
  try {
    const result = digestOnly
      ? { commandDigest: vpsMfaCommandDigest(command) }
      : await runVpsMfaOperator(binding, command, readVpsPrivateJson);
    await output.writeFile(JSON.stringify(result) + '\n');
    await output.sync();
  } finally {
    await output.close();
  }
  process.stdout.write('Private staging VPS MFA operation recorded.\n');
}
main().catch(() => {
  process.stderr.write('Private VPS operator unavailable.\n');
  process.exitCode = 1;
});
