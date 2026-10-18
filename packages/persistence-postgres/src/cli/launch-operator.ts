import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { OperatorAwsCall } from '../admin-totp-operator-host.js';
import { launchOperatorCommandDigest, runLaunchOperator } from '../launch-operator-host.js';

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
    digestOnly = args[0] === '--digest';
  const paths = digestOnly ? args.slice(1) : args;
  if (paths.length !== (digestOnly ? 2 : 3) || !paths.every(isAbsolute)) throw new Error();
  const binding = digestOnly ? undefined : await readPrivateJson(paths[0]!);
  const command = await readPrivateJson(paths[digestOnly ? 0 : 1]!);
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
    const result = digestOnly
      ? { commandDigest: launchOperatorCommandDigest(command) }
      : await runLaunchOperator(binding, command, aws);
    await receipt.writeFile(JSON.stringify(result) + '\n', 'utf8');
    await receipt.sync();
    process.stdout.write(JSON.stringify({ completed: true, digestOnly }) + '\n');
  } finally {
    await receipt.close();
  }
}
void main().catch(() => {
  process.stderr.write('Launch operator unavailable.\n');
  process.exitCode = 1;
});
