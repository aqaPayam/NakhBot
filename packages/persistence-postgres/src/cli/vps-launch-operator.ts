import { isAbsolute } from 'node:path';
import {
  captureLaunchOperatorRequest,
  launchOperatorCommandDigest,
} from '../launch-operator-host.js';
import { loadLaunchReviewFiles } from '../launch-review-files.js';
import { runVpsLaunchOperator } from '../vps-trusted-operators.js';
import {
  openVpsPrivateInput,
  readVpsPrivateJson,
  requireVpsRoot,
  reserveVpsPrivateOutput,
} from '../vps-private-files.js';

async function request(value: unknown, digestOnly: boolean): Promise<unknown> {
  if (value !== null && typeof value === 'object' && 'operation' in value) {
    if (value.operation === 'apply-reviewed') {
      if (
        Object.keys(value).length !== 3 ||
        !('input' in value) ||
        !('reviewPath' in value) ||
        typeof value.reviewPath !== 'string' ||
        !isAbsolute(value.reviewPath)
      )
        throw new Error();
      const selected = captureLaunchOperatorRequest({ operation: 'apply', input: value.input });
      if (selected.operation !== 'apply' || selected.input.mode !== 'cohort') throw new Error();
      return digestOnly
        ? selected
        : captureLaunchOperatorRequest({
            operation: 'apply-reviewed',
            input: selected.input,
            review: await readVpsPrivateJson(value.reviewPath),
          });
    }
    if (value.operation === 'prepare-review')
      return loadLaunchReviewFiles(value, (path) => openVpsPrivateInput(path, 1048576));
  }
  return captureLaunchOperatorRequest(value);
}
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
    const selected = await request(command, digestOnly);
    const result = digestOnly
      ? { commandDigest: launchOperatorCommandDigest(selected) }
      : await runVpsLaunchOperator(binding, selected, readVpsPrivateJson);
    await output.writeFile(JSON.stringify(result) + '\n');
    await output.sync();
  } finally {
    await output.close();
  }
  process.stdout.write('Private staging VPS launch operation recorded.\n');
}
main().catch(() => {
  process.stderr.write('Private VPS operator unavailable.\n');
  process.exitCode = 1;
});
