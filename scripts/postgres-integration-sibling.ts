import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function docker(args: readonly string[]): Promise<string> {
  const result = await exec('docker', [...args], { timeout: 30000, maxBuffer: 65536 });
  return result.stdout.trim();
}

/** CI-only disposable services. A separate cluster also isolates global SQL roles;
 * a separate Redis server isolates legacy fixtures that reserve database 15. */
export async function startNativeSiblingServices(): Promise<
  Readonly<{ databaseUrl: string; redisUrl: string; destroy: () => Promise<void> }>
> {
  const ids: string[] = [];
  const destroy = async (): Promise<void> => {
    const results = await Promise.allSettled(
      ids.map((id) => docker(['rm', '--force', '--volumes', id])),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Native sibling service cleanup failed.');
  };
  try {
    const specifications = [
      {
        image: 'postgres:17.11-alpine3.23',
        port: 5432,
        args: [
          '--memory',
          '1536m',
          '-e',
          'POSTGRES_USER=nakh',
          '-e',
          'POSTGRES_PASSWORD=nakh_test',
          '-e',
          'POSTGRES_DB=nakh',
        ],
        health: ['pg_isready', '-h', '127.0.0.1', '-U', 'nakh', '-d', 'nakh'],
      },
      {
        image: 'redis:7.4.5-alpine3.21',
        port: 6379,
        args: ['--memory', '256m'],
        health: ['redis-cli', 'ping'],
      },
    ];
    const ports: number[] = [];
    for (const spec of specifications) {
      const id = await docker([
        'run',
        '--detach',
        '--rm',
        '--label',
        'nakh.purpose=native-ci-sibling',
        '--publish',
        `127.0.0.1::${spec.port}`,
        ...spec.args,
        spec.image,
      ]);
      if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error();
      ids.push(id);
      const mapping = await docker(['port', id, `${spec.port}/tcp`]);
      const match = /^127\.0\.0\.1:([0-9]{1,5})$/u.exec(mapping);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) throw new Error();
      ports.push(Number(match[1]));
      let ready = false;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const health = await docker(['exec', id, ...spec.health]);
          if (spec.port === 6379 && health !== 'PONG') throw new Error();
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!ready) throw new Error();
    }
    return {
      databaseUrl: `postgresql://nakh:nakh_test@127.0.0.1:${ports[0]!}/nakh`,
      redisUrl: `redis://127.0.0.1:${ports[1]!}/0`,
      destroy,
    };
  } catch {
    await destroy();
    throw new Error('Native sibling services unavailable.');
  }
}
