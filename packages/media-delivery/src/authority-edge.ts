import type { MediaDeliveryClaims } from './claims.js';
import type { EdgeMediaSourceAuthority } from './edge.js';

/** A fixed HTTPS authority endpoint; no signature-only or positive-cache fallback. */
export class EdgeHttpMediaSourceAuthority implements EdgeMediaSourceAuthority {
  private readonly endpoint: string;
  public constructor(
    endpoint: string,
    private readonly request: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.pathname !== '/internal/media/source-authority'
    )
      throw new Error('media_authority_invalid');
    this.endpoint = url.toString();
  }

  public async isCurrent(request: Request, claims: MediaDeliveryClaims): Promise<boolean> {
    try {
      const token = new URL(request.url).searchParams.get('token');
      const authorization = request.headers.get('authorization');
      if (
        token === null ||
        token.length > 2048 ||
        authorization === null ||
        authorization.length > 520
      )
        return false;
      const response = await this.request(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(2000)]),
        headers: { 'content-type': 'application/json', authorization },
        body: JSON.stringify({ path: claims.path, token }),
      });
      if (
        response.status !== 200 ||
        response.headers.get('cache-control') !== 'no-store' ||
        !response.headers.get('content-type')?.startsWith('application/json') ||
        response.body === null
      ) {
        void response.body?.cancel().catch(() => {});
        return false;
      }
      const reader: ReadableStreamDefaultReader<unknown> = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) {
          void reader.cancel().catch(() => {});
          return false;
        }
        length += chunk.value.byteLength;
        if (length > 64) {
          void reader.cancel().catch(() => {});
          return false;
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 1 &&
        'allowed' in value &&
        value.allowed === true
      );
    } catch {
      return false;
    }
  }
}
