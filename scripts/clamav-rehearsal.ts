import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { ClamdMalwareScanner } from '@nakh/media-clamav';
import manifest from '../deploy/runtime-product.json' with { type: 'json' };

const exec = promisify(execFile);
async function docker(args: readonly string[], timeout = 30000): Promise<string> {
  return (await exec('docker', [...args], { timeout, maxBuffer: 1048576 })).stdout.trim();
}
const name = 'nakh-m9-scanner-' + randomUUID();
let phase = 'source';
try {
  const sourceSha = process.env.GITHUB_SHA ?? '';
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error();
  phase = 'pull';
  await docker(['pull', '--platform', 'linux/amd64', manifest.scanner.image], 120000);
  phase = 'start';
  await docker([
    'run',
    '--detach',
    '--name',
    name,
    '--platform',
    'linux/amd64',
    '--user',
    manifest.scanner.user,
    '--entrypoint',
    manifest.scanner.entryPoint[0]!,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '4g',
    '--cpus',
    '1',
    '--env',
    'CLAMAV_NO_MILTERD=true',
    '--env',
    'CLAMAV_NO_FRESHCLAMD=true',
    '--publish',
    '127.0.0.1::3310',
    '--health-cmd',
    'clamdcheck.sh',
    '--health-interval',
    '2s',
    '--health-start-period',
    '1s',
    '--health-retries',
    '60',
    manifest.scanner.image,
  ]);
  phase = 'ready';
  let port = 0;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const inspected = JSON.parse(await docker(['inspect', name])) as Array<{
      Config: { User: string };
      State: { Running: boolean; Health?: { Status: string } };
      NetworkSettings: { Ports: Record<string, Array<{ HostPort: string }> | null> };
    }>;
    const container = inspected[0];
    if (container?.Config.User !== manifest.scanner.user || !container.State.Running)
      throw new Error();
    if (container.State.Health?.Status === 'healthy') {
      port = Number(container.NetworkSettings.Ports['3310/tcp']?.[0]?.HostPort);
      break;
    }
    await pause(2000);
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error();
  const scanner = new ClamdMalwareScanner({ host: '127.0.0.1', port, timeoutMs: 10000 });
  phase = 'clean';
  const clean = await scanner.start();
  await clean.inspect(Buffer.from('NakhBot scanner transport rehearsal.'));
  const cleanVerdict = await clean.complete();
  phase = 'eicar';
  const infected = await scanner.start();
  // Standard harmless EICAR antivirus test payload; never publish or log scan content.
  await infected.inspect(
    Buffer.from(
      'WDVPIVAlQEFQWzRcUFpYNTQoUF4pN0NDKTd9JEVJQ0FSLVNUQU5EQVJELUFOVElWSVJVUy1URVNULUZJTEUhJEgrSCo=',
      'base64',
    ),
  );
  const detectedVerdict = await infected.complete();
  if (
    cleanVerdict.result !== 'clean' ||
    detectedVerdict.result !== 'detected' ||
    cleanVerdict.scannerVersion !== manifest.scanner.version ||
    detectedVerdict.scannerVersion !== manifest.scanner.version ||
    !/^[1-9][0-9]*$/u.test(cleanVerdict.signatureVersion)
  )
    throw new Error();
  phase = 'receipt';
  const receipt = {
    schemaVersion: 1,
    sourceSha,
    image: manifest.scanner.image,
    user: manifest.scanner.user,
    actualClamdTransport: true,
    cleanDetected: true,
    eicarRejected: true,
    scannerVersion: cleanVerdict.scannerVersion,
    signatureVersion: cleanVerdict.signatureVersion,
    readyWithinMs: 120000,
    providerAcceptance: false,
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/m9-scanner-rehearsal.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} catch (error) {
  // This isolated container receives only public test content and vendor toggles,
  // never application/provider credentials. Keep bounded startup diagnostics so
  // a failed CI head can be diagnosed before a changed repair is attempted.
  const logs = await exec('docker', ['logs', '--tail', '40', name], {
    timeout: 10000,
    maxBuffer: 16384,
  }).catch(() => ({ stdout: '', stderr: '' }));
  console.error(
    JSON.stringify({
      phase,
      error: error instanceof Error ? error.message.slice(0, 1024) : 'unavailable',
      scannerStartup: (logs.stdout + logs.stderr).slice(-4096),
    }),
  );
  console.error('Pinned unprivileged scanner rehearsal unavailable.');
  process.exitCode = 1;
} finally {
  await docker(['rm', '--force', name]).catch(() => undefined);
}
