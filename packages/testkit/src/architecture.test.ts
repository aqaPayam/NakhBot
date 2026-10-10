import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

async function typescriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'dist' && entry.name !== 'node_modules')
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return typescriptFiles(path);
        return entry.name.endsWith('.ts') ? [path] : [];
      }),
  );
  return nested.flat();
}

describe('architecture boundaries', () => {
  it('keeps the domain free of framework and infrastructure dependencies', async () => {
    const root = join(process.cwd(), 'packages/domain/src');
    const violations: string[] = [];
    for (const file of await typescriptFiles(root)) {
      const source = await readFile(file, 'utf8');
      if (/from ['"](?:@nakh\/|@nestjs\/|pg|kysely|ioredis|bullmq|fastify)/u.test(source)) {
        violations.push(relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('rejects cross-package deep imports', async () => {
    const files = [
      ...(await typescriptFiles(join(process.cwd(), 'packages'))),
      ...(await typescriptFiles(join(process.cwd(), 'apps'))),
    ];
    const violations: string[] = [];
    // Bound I/O while scanning every source, including integration tests. Keep
    // the same assertion and deadline without serial disk waits per file.
    for (let offset = 0; offset < files.length; offset += 32) {
      const batch = await Promise.all(
        files.slice(offset, offset + 32).map(async (file) => {
          const source = await readFile(file, 'utf8');
          return /from ['"]@nakh\/[^'"]+\/(?:src\/)?[^'"]+['"]/u.test(source)
            ? relative(process.cwd(), file)
            : undefined;
        }),
      );
      for (const violation of batch) {
        if (violation !== undefined) violations.push(violation);
      }
    }
    expect(violations).toEqual([]);
  });
});
