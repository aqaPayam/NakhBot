import { describe, expect, it, vi } from 'vitest';

import { CloudflareMediaCachePurger } from './purge.js';

const config = {
  zoneId: 'a'.repeat(32),
  apiToken: 'secret-token-value-that-is-long-enough',
  mediaOrigin: 'https://media.example.com',
};
const asset = (value: number): string =>
  `/media/10000000-0000-4000-8000-${String(value).padStart(12, '0')}/thumbnail-v1.webp`;

describe('CloudflareMediaCachePurger', () => {
  it('deduplicates, sorts, and bounds purge batches', async () => {
    const request = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    const paths = Array.from({ length: 31 }, (_, index) => asset(index + 1));
    await new CloudflareMediaCachePurger(config, request).purgePaths([
      ...paths.toReversed(),
      paths[0]!,
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    const first = request.mock.calls[0]!;
    expect(first[0]).toBe(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
    );
    expect(first[1]).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'application/json',
      },
    });
    const body = first[1]?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('expected JSON request body');
    expect(JSON.parse(body)).toEqual({
      files: paths.slice(0, 30).map((path) => `https://media.example.com${path}`),
    });
  });

  it('rejects arbitrary paths without network access', async () => {
    const request = vi.fn();
    const purger = new CloudflareMediaCachePurger(config, request);
    await expect(purger.purgePaths(['https://attacker.example/object'])).rejects.toThrow(
      'invalid_media_delivery_path',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('turns HTTP, malformed-body, and provider rejection into retryable failure', async () => {
    for (const response of [
      new Response('{}', { status: 500 }),
      new Response('not-json', { status: 200 }),
      new Response(JSON.stringify({ success: false }), { status: 200 }),
      new Response('x'.repeat(65 * 1024), { status: 200 }),
    ]) {
      const purger = new CloudflareMediaCachePurger(config, () => Promise.resolve(response));
      await expect(purger.purgePaths([asset(1)])).rejects.toThrow(
        'cloudflare_cache_purge_unavailable',
      );
    }
  });

  it('rejects unsafe startup configuration', () => {
    expect(
      () => new CloudflareMediaCachePurger({ ...config, mediaOrigin: 'http://media.example.com' }),
    ).toThrow('invalid_cloudflare_cache_purge_configuration');
    expect(() => new CloudflareMediaCachePurger({ ...config, zoneId: '../zone' })).toThrow(
      'invalid_cloudflare_cache_purge_configuration',
    );
  });
});
