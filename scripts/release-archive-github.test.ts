import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveGitHub } from './release-archive-github.js';
import { archiveSha } from './release-archive.js';
afterEach(() => vi.unstubAllGlobals());
describe('bounded authenticated archive downloads', () => {
  const body = Buffer.from('synthetic ZIP bytes'),
    artifact = {
      name: 'example',
      id: 1,
      digest: 'sha256:' + archiveSha(body),
      size: body.length,
      expiresAt: '2026-10-31T00:00:00Z',
    };
  it('does not forward GitHub credentials to the signed artifact storage redirect', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(
        calls.length === 1
          ? new Response(null, {
              status: 302,
              headers: {
                location: 'https://production.blob.core.windows.net/artifacts/file?sig=synthetic',
              },
            })
          : new Response(body),
      );
    });
    expect(await archiveGitHub('owner/repo', 'synthetic-secret').download(artifact)).toEqual(body);
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe(
      'Bearer synthetic-secret',
    );
    expect(new Headers(calls[1]!.init?.headers).get('authorization')).toBeNull();
    expect(calls[1]!.init?.redirect).toBe('error');
  });
  it('rejects foreign or insecure redirects before making a second request', async () => {
    for (const url of [
      'http://production.blob.core.windows.net/file',
      'https://attacker.invalid/file',
      'https://user@production.blob.core.windows.net/file',
    ]) {
      const call = vi.fn(() =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: url } })),
      );
      vi.stubGlobal('fetch', call);
      await expect(archiveGitHub('owner/repo', 'fixture').download(artifact)).rejects.toThrow();
      expect(call).toHaveBeenCalledTimes(1);
    }
  });
  it('enforces exact downloaded length and digest without trusting the content-length header', async () => {
    for (const bytes of [Buffer.from('corrupt'), Buffer.alloc(artifact.size + 1)]) {
      let calls = 0;
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          ++calls === 1
            ? new Response(null, {
                status: 302,
                headers: { location: 'https://production.blob.core.windows.net/file' },
              })
            : new Response(bytes),
        ),
      );
      await expect(archiveGitHub('owner/repo', 'fixture').download(artifact)).rejects.toThrow();
    }
  });
  it('rejects normalized foreign JSON paths and caps JSON before parsing', async () => {
    const call = vi.fn(() =>
      Promise.resolve(new Response('x', { headers: { 'content-length': '1048577' } })),
    );
    vi.stubGlobal('fetch', call);
    const client = archiveGitHub('owner/repo', 'fixture');
    await expect(client.json('/repos/owner/repo/../../../user')).rejects.toThrow();
    expect(call).not.toHaveBeenCalled();
    await expect(client.json('/repos/owner/repo/actions/runs')).rejects.toThrow();
    expect(call).toHaveBeenCalledTimes(1);
  });
});
