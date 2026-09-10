export type CloudflareCachePurgeConfig = Readonly<{
  zoneId: string;
  apiToken: string;
  mediaOrigin: string;
  timeoutMs?: number;
}>;

type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const pathPattern =
  /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:thumbnail-v1|blurred-preview-v1)\.webp$/u;

function invalidConfiguration(): never {
  throw new Error('invalid_cloudflare_cache_purge_configuration');
}

function origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    invalidConfiguration();
  return url.origin;
}

function succeeded(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'success') === true;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new Error('cloudflare_cache_purge_unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array)) throw new Error('cloudflare_cache_purge_unavailable');
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error('cloudflare_cache_purge_unavailable');
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error('cloudflare_cache_purge_unavailable');
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new Error('cloudflare_cache_purge_unavailable');
  }
}

export class CloudflareMediaCachePurger {
  private readonly endpoint: string;
  private readonly mediaOrigin: string;
  private readonly timeoutMs: number;
  private readonly apiToken: string;

  public constructor(
    config: CloudflareCachePurgeConfig,
    private readonly request: FetchPort = fetch,
  ) {
    if (!/^[a-f0-9]{32}$/u.test(config.zoneId) || !/^[\x21-\x7e]{20,256}$/u.test(config.apiToken))
      invalidConfiguration();
    this.timeoutMs = config.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 30_000)
      invalidConfiguration();
    this.mediaOrigin = origin(config.mediaOrigin);
    this.apiToken = config.apiToken;
    this.endpoint = `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`;
  }

  public async purgePaths(paths: readonly string[]): Promise<void> {
    if (paths.length > 1000 || paths.some((path) => !pathPattern.test(path)))
      throw new Error('invalid_media_delivery_path');
    const unique = [...new Set(paths)].sort();
    for (let offset = 0; offset < unique.length; offset += 30) {
      const files = unique
        .slice(offset, offset + 30)
        .map((path) => new URL(path, this.mediaOrigin).toString());
      const response = await this.request(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const result = await responseJson(response);
      if (!response.ok || !succeeded(result)) throw new Error('cloudflare_cache_purge_unavailable');
    }
  }
}
