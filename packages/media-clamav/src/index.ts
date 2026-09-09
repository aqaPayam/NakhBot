import { createConnection, type Socket } from 'node:net';
import type { MalwareScannerPort, MalwareScanSession, MalwareScanVerdict } from '@nakh/application';

export type ClamdConfig = Readonly<{
  host: string;
  port: number;
  timeoutMs: number;
  maximumChunkBytes?: number;
}>;

type Version = Readonly<{ scannerVersion: string; signatureVersion: string }>;

function boundedText(value: string): string {
  if (!/^[\x20-\x7e]{1,128}$/u.test(value)) throw new Error('clamd_response_invalid');
  return value;
}

function parseVersion(response: string): Version {
  const match = /^ClamAV ([0-9A-Za-z._-]+)\/([0-9]+)\//u.exec(response.trim());
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('clamd_version_invalid');
  return { scannerVersion: boundedText(match[1]), signatureVersion: boundedText(match[2]) };
}

function parseVerdict(response: string, version: Version): MalwareScanVerdict {
  const normalized = response.replace(/\0+$/u, '').trim();
  if (normalized === 'stream: OK') return { result: 'clean', ...version };
  if (/^stream: .+ FOUND$/u.test(normalized)) return { result: 'detected', ...version };
  throw new Error('clamd_scan_failed');
}

async function write(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (socket.destroyed) throw new Error('clamd_connection_closed');
  if (socket.write(bytes)) return;
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const drained = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      socket.off('error', failed);
      socket.off('drain', drained);
    };
    socket.once('error', failed);
    socket.once('drain', drained);
  });
}

async function connect(config: ClamdConfig, signal?: AbortSignal): Promise<Socket> {
  if (
    !/^[A-Za-z0-9.-]{1,253}$/u.test(config.host) ||
    !Number.isSafeInteger(config.port) ||
    config.port < 1 ||
    config.port > 65_535
  )
    throw new Error('clamd_configuration_invalid');
  const socket = createConnection({ host: config.host, port: config.port });
  socket.setTimeout(config.timeoutMs, () => socket.destroy(new Error('clamd_timeout')));
  const aborted = (): void => {
    socket.destroy(new Error('clamd_aborted'));
  };
  signal?.addEventListener('abort', aborted, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.once('close', () => signal?.removeEventListener('abort', aborted));
    return socket;
  } catch {
    signal?.removeEventListener('abort', aborted);
    socket.destroy();
    throw new Error('clamd_unavailable');
  }
}

async function response(socket: Socket, maximumBytes = 1024): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const failed = (): void => {
      cleanup();
      reject(new Error('clamd_unavailable'));
    };
    const data = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        socket.destroy();
        failed();
        return;
      }
      chunks.push(chunk);
      if (chunk.includes(0)) {
        cleanup();
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    const cleanup = (): void => {
      socket.off('data', data);
      socket.off('error', failed);
      socket.off('timeout', failed);
      socket.off('close', failed);
    };
    socket.on('data', data);
    socket.once('error', failed);
    socket.once('timeout', failed);
    socket.once('close', failed);
  });
}

class ClamdScanSession implements MalwareScanSession {
  private finished = false;
  public constructor(
    private readonly socket: Socket,
    private readonly version: Version,
    private readonly maximumChunkBytes: number,
  ) {}

  public async inspect(chunk: Uint8Array): Promise<void> {
    if (this.finished || chunk.byteLength === 0 || chunk.byteLength > this.maximumChunkBytes)
      throw new Error('clamd_chunk_invalid');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(chunk.byteLength);
    await write(this.socket, length);
    await write(this.socket, chunk);
  }

  public async complete(): Promise<MalwareScanVerdict> {
    if (this.finished) throw new Error('clamd_session_finished');
    this.finished = true;
    const reply = response(this.socket);
    await write(this.socket, Buffer.alloc(4));
    try {
      return parseVerdict(await reply, this.version);
    } finally {
      this.socket.destroy();
    }
  }

  public abort(): Promise<void> {
    this.finished = true;
    this.socket.destroy();
    return Promise.resolve();
  }
}

export class ClamdMalwareScanner implements MalwareScannerPort {
  public constructor(private readonly config: ClamdConfig) {
    if (
      !Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs < 100 ||
      config.timeoutMs > 120_000 ||
      (config.maximumChunkBytes !== undefined &&
        (!Number.isSafeInteger(config.maximumChunkBytes) ||
          config.maximumChunkBytes < 1 ||
          config.maximumChunkBytes > 1024 * 1024))
    )
      throw new Error('clamd_configuration_invalid');
  }

  public async start(signal?: AbortSignal): Promise<MalwareScanSession> {
    const versionSocket = await connect(this.config, signal);
    let version: Version;
    try {
      const reply = response(versionSocket);
      await write(versionSocket, Buffer.from('zVERSION\0'));
      version = parseVersion(await reply);
    } finally {
      versionSocket.destroy();
    }
    const socket = await connect(this.config, signal);
    await write(socket, Buffer.from('zINSTREAM\0'));
    return new ClamdScanSession(socket, version, this.config.maximumChunkBytes ?? 1024 * 1024);
  }
}
