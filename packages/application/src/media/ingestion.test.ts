import { describe, expect, it } from 'vitest';
import { boundedMediaStream } from './ingestion.js';

async function consume(chunks: number[][], limit: number, expected?: number): Promise<number> {
  const source = (async function* () {
    await Promise.resolve();
    for (const chunk of chunks) yield new Uint8Array(chunk);
  })();
  let bytes = 0;
  for await (const chunk of boundedMediaStream(source, limit, expected)) bytes += chunk.byteLength;
  return bytes;
}

describe('boundedMediaStream', () => {
  it('accepts the exact boundary across chunks', async () => {
    await expect(consume([[1, 2], [3]], 3, 3)).resolves.toBe(3);
  });
  it('rejects overflow before delivering the oversized chunk', async () => {
    await expect(
      consume(
        [
          [1, 2],
          [3, 4],
        ],
        3,
      ),
    ).rejects.toMatchObject({ code: 'media_too_large' });
  });
  it.each([{ chunks: [] }, { chunks: [[]] }, { chunks: [[1]] }])(
    'rejects empty or truncated streams %#',
    async ({ chunks }) => {
      await expect(consume(chunks, 3, 2)).rejects.toMatchObject({ code: 'media_download_invalid' });
    },
  );
});
