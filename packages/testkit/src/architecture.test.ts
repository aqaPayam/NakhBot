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
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/from ['"]@nakh\/[^'"]+\/(?:src\/)?[^'"]+['"]/u.test(source)) {
        violations.push(relative(process.cwd(), file));
      }
    }
    expect(violations).toEqual([]);
  });
});
