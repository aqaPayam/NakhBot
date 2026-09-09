import { createServer, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ClamdMalwareScanner } from './index.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fakeClamd(): Promise<number> {
  const server = createServer((socket: Socket) => {
    let input = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.subarray(0, 9).toString() === 'zVERSION\0') {
        socket.end('ClamAV 1.4.3/27880/Mon Sep 7 00:00:00 2026\0');
        return;
      }
      const prefix = Buffer.from('zINSTREAM\0');
      if (input.length < prefix.length || !input.subarray(0, prefix.length).equals(prefix)) return;
      let offset = prefix.length;
      const payload: Buffer[] = [];
      while (input.length >= offset + 4) {
        const size = input.readUInt32BE(offset);
        if (size === 0) {
          const detected = Buffer.concat(payload).includes(Buffer.from('virus'));
          socket.end(detected ? 'stream: synthetic FOUND\0' : 'stream: OK\0');
          return;
        }
        if (input.length < offset + 4 + size) return;
        payload.push(input.subarray(offset + 4, offset + 4 + size));
        offset += 4 + size;
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test server unavailable');
  return address.port;
}

describe('ClamdMalwareScanner', () => {
  it.each([
    { bytes: 'safe image bytes', result: 'clean' },
    { bytes: 'contains virus marker', result: 'detected' },
  ] as const)(
    'streams bytes and maps the $result verdict without exposing the signature name',
    async ({ bytes, result }) => {
      const scanner = new ClamdMalwareScanner({
        host: '127.0.0.1',
        port: await fakeClamd(),
        timeoutMs: 5_000,
      });
      const session = await scanner.start();
      await session.inspect(Buffer.from(bytes));
      await expect(session.complete()).resolves.toEqual({
        result,
        scannerVersion: '1.4.3',
        signatureVersion: '27880',
      });
    },
  );

  it('rejects invalid endpoints and oversized chunks', async () => {
    expect(() => new ClamdMalwareScanner({ host: '127.0.0.1', port: 3310, timeoutMs: 1 })).toThrow(
      'configuration',
    );
    const scanner = new ClamdMalwareScanner({
      host: '127.0.0.1',
      port: await fakeClamd(),
      timeoutMs: 5_000,
      maximumChunkBytes: 2,
    });
    const session = await scanner.start();
    await expect(session.inspect(Buffer.from([1, 2, 3]))).rejects.toThrow('chunk');
    await session.abort();
  });
});
