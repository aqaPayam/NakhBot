import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WORKSPACE_SOURCE_ALIASES } from './workspace-source-aliases.js';

describe('cold workspace test resolution', () => {
  it('resolves every real workspace runtime export to its declared existing source before any package prefix', () => {
    const expected: string[] = [];
    for (const directory of readdirSync(resolve('packages'), { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const root = resolve('packages', directory.name),
        path = resolve(root, 'package.json');
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        name: string;
        exports: Record<string, { types: string; default: string }>;
      };
      for (const [subpath, entry] of Object.entries(manifest.exports)) {
        const name = manifest.name + (subpath === '.' ? '' : subpath.slice(1));
        expected.push(name);
        expect(entry.types).toMatch(/^\.\/src\/.+\.ts$/u);
        expect(entry.default).toMatch(/^\.\/dist\/.+\.js$/u);
        const source = resolve(root, entry.types);
        expect(existsSync(source)).toBe(true);
        expect(WORKSPACE_SOURCE_ALIASES[name]).toBe(source);
        const first = Object.keys(WORKSPACE_SOURCE_ALIASES).find(
          (alias) => name === alias || name.startsWith(`${alias}/`),
        );
        expect(first).toBe(name);
      }
    }
    expect(Object.keys(WORKSPACE_SOURCE_ALIASES).sort()).toEqual(expected.sort());
  });
});
