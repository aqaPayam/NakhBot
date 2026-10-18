import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { runAdminTotpOperator, type OperatorAwsCall } from '../admin-totp-operator-host.js';

const exec = promisify(execFile);
async function main(): Promise<void> {
  const [bindingPath, commandPath, receiptPath, ...extra] = process.argv.slice(2);
  if (
    !bindingPath ||
    !commandPath ||
    !receiptPath ||
    extra.length ||
    ![bindingPath, commandPath, receiptPath].every(isAbsolute)
  )
    throw new Error();
  for (const file of [bindingPath, commandPath])
    if ((await stat(file)).size > 16384) throw new Error();
  const binding: unknown = JSON.parse(await readFile(bindingPath, 'utf8'));
  const command: unknown = JSON.parse(await readFile(commandPath, 'utf8'));
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
  // Reserve exclusive private output BEFORE native effects. Never print invitation tokens.
  // On Windows, run inside an operator-only ACL directory; POSIX mode is not an ACL.
  const receipt = await open(receiptPath, 'wx', 0o600);
  try {
    const result = await runAdminTotpOperator(binding, command, aws);
    await receipt.writeFile(JSON.stringify(result) + '\n', 'utf8');
    await receipt.sync();
    process.stdout.write(JSON.stringify({ completed: true, status: result.status }) + '\n');
  } finally {
    await receipt.close();
  }
}
void main().catch(() => {
  process.stderr.write('Administrator operator unavailable.\n');
  process.exitCode = 1;
});
