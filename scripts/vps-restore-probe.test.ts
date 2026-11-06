import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('checks backup restore input integrity, isolation and failure cleanup without accessing private backups', async () => {
  const result = await promisify(execFile)(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'deploy/vps', '-p', 'test_restore_probe.py'],
    { timeout: 20000, maxBuffer: 65536 },
  );
  expect(result.stderr).toContain('Ran 15 tests');
  expect(result.stderr).toContain('OK');
  expect(result.stdout).not.toContain('DO_NOT_LEAK');
});
