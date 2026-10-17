import { archiveSha } from './release-archive.js';
import type { ReleaseCiReceipt } from './release-ci.js';
/** Redirected artifact bytes receive no GitHub credential. Bodies are streamed with a ceiling. */
export function archiveGitHub(
  repository: string,
  token: string,
): Readonly<{
  json: (path: string) => Promise<unknown>;
  download: (artifact: ReleaseCiReceipt['artifacts'][number]) => Promise<Buffer>;
}> {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/u.test(repository) || !token)
    throw new Error('Archive GitHub context unavailable.');
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2026-03-10',
    'User-Agent': 'NakhBot-release-archive',
    'Cache-Control': 'no-cache',
  };
  async function bytes(response: Response, max: number): Promise<Buffer> {
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get('content-length') ?? 0) > max
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Archive download unavailable.');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        const chunk: unknown = part.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid archive body.');
        size += chunk.length;
        if (size > max) throw new Error('Archive body exceeds ceiling.');
        chunks.push(chunk);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return Buffer.concat(chunks);
  }
  return {
    json: async (path) => {
      if (
        !new URL('https://api.github.com' + path).pathname.startsWith('/repos/' + repository + '/')
      )
        throw new Error('Foreign archive API path.');
      const result = await fetch('https://api.github.com' + path, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      return JSON.parse((await bytes(result, 1048576)).toString('utf8')) as unknown;
    },
    download: async (artifact) => {
      if (
        !Number.isSafeInteger(artifact.id) ||
        artifact.id < 1 ||
        artifact.size < 1 ||
        artifact.size > 16777216
      )
        throw new Error('Archive artifact unavailable.');
      const response = await fetch(
        `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
        { headers, redirect: 'manual', signal: AbortSignal.timeout(30000) },
      );
      if (response.status !== 302) throw new Error('Archive redirect unavailable.');
      const location = new URL(response.headers.get('location') ?? '');
      if (
        location.protocol !== 'https:' ||
        location.username ||
        location.password ||
        location.port ||
        ![
          'blob.core.windows.net',
          'githubusercontent.com',
          'actions.githubusercontent.com',
          's3.amazonaws.com',
        ].some((d) => location.hostname.endsWith('.' + d))
      )
        throw new Error('Untrusted archive redirect.');
      const content = await bytes(
        await fetch(location, {
          headers: { 'User-Agent': 'NakhBot-release-archive' },
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        }),
        artifact.size,
      );
      if (content.length !== artifact.size || 'sha256:' + archiveSha(content) !== artifact.digest)
        throw new Error('Archive artifact digest mismatch.');
      return content;
    },
  };
}
