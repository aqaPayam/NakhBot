import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('verifies the physical-drain observer rejects active, changed and unqualified producer snapshots', async () => {
  const result = await promisify(execFile)(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'deploy/vps', '-p', 'test_deletion_cutover.py'],
    { timeout: 20000, maxBuffer: 65536 },
  );
  expect(result.stderr).toContain('Ran 22 tests');
  expect(result.stderr).toContain('OK');
  expect(result.stdout).not.toContain('DO_NOT_LEAK');
});
