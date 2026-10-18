import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { OperatorAwsCall } from '../admin-totp-operator-host.js';
import {
  captureLaunchOperatorRequest,
  launchOperatorCommandDigest,
  runLaunchOperator,
} from '../launch-operator-host.js';
import { loadLaunchReviewFiles } from '../launch-review-files.js';
import { verifyLaunchReviewReference } from '../launch-review.js';

const exec = promisify(execFile);
async function readPrivateJson(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 16384) throw new Error();
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
  } finally {
    await file.close();
  }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2),
    digestOnly = args[0] === '--digest',
    verifyOnly = args[0] === '--verify-review';
  const paths = digestOnly || verifyOnly ? args.slice(1) : args;
  if (paths.length !== (digestOnly ? 2 : 3) || !paths.every(isAbsolute)) throw new Error();
  const binding = digestOnly ? undefined : await readPrivateJson(paths[0]!);
  let command = await readPrivateJson(paths[digestOnly ? 0 : 1]!);
  if (
    command !== null &&
    typeof command === 'object' &&
    'operation' in command &&
    command.operation === 'apply-reviewed'
  ) {
    if (
      Object.keys(command).length !== 3 ||
      !('input' in command) ||
      !('reviewPath' in command) ||
      typeof command.reviewPath !== 'string' ||
      !isAbsolute(command.reviewPath)
    )
      throw new Error();
    const selected = captureLaunchOperatorRequest({ operation: 'apply', input: command.input });
    if (selected.operation !== 'apply' || selected.input.mode !== 'cohort') throw new Error();
    const reviewPath = command.reviewPath;
    if (!digestOnly && !verifyOnly) {
      const review = await readPrivateJson(reviewPath);
      verifyLaunchReviewReference(review, selected.input, new Date());
      command = { operation: 'apply-reviewed', input: selected.input, review };
    } else command = selected;
  }
  if (
    !digestOnly &&
    !verifyOnly &&
    command !== null &&
    typeof command === 'object' &&
    'operation' in command &&
    command.operation === 'apply'
  ) {
    const selected = captureLaunchOperatorRequest(command);
    if (selected.operation !== 'apply' || selected.input.mode === 'cohort') throw new Error();
    command = selected;
  }
  if (
    !digestOnly &&
    !verifyOnly &&
    command !== null &&
    typeof command === 'object' &&
    'operation' in command &&
    command.operation === 'prepare-review'
  )
    command = await loadLaunchReviewFiles(command);
  const aws: OperatorAwsCall = async (service, operation, input, region) => {
    const result = await exec(
      'aws',
      [
        service,
        operation,
        '--region',
        region,
        '--endpoint-url',
        `https://${service}.${region}.amazonaws.com`,
        '--cli-input-json',
        JSON.stringify(input),
        '--output',
        'json',
        '--no-cli-pager',
      ],
      {
        timeout: 30000,
        maxBuffer: 1048576,
        env: {
          ...process.env,
          AWS_PAGER: '',
          AWS_MAX_ATTEMPTS: '1',
          AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
        },
      },
    );
    return JSON.parse(result.stdout) as unknown;
  };
  // Exclusive reservation precedes effects. Windows requires a private directory ACL.
  const receipt = await open(paths.at(-1)!, 'wx', 0o600);
  try {
    let result: unknown;
    if (verifyOnly) {
      const selected = captureLaunchOperatorRequest(command);
      if (selected.operation !== 'apply') throw new Error();
      result = verifyLaunchReviewReference(binding, selected.input, new Date());
    } else
      result = digestOnly
        ? { commandDigest: launchOperatorCommandDigest(command) }
        : await runLaunchOperator(binding, command, aws);
    await receipt.writeFile(JSON.stringify(result) + '\n', 'utf8');
    await receipt.sync();
    process.stdout.write(
      JSON.stringify(
        verifyOnly
          ? { completed: true, reviewReferenceVerified: true }
          : { completed: true, digestOnly },
      ) + '\n',
    );
  } finally {
    await receipt.close();
  }
}
void main().catch(() => {
  process.stderr.write('Launch operator unavailable.\n');
  process.exitCode = 1;
});
