import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../deploy/terraform/staging/migration-inventory.json' with { type: 'json' };

describe('accepted staging state address migration', () => {
  it('maps every accepted resource exactly once into the shared runtime', () => {
    const text = readFileSync('deploy/terraform/staging/moved.tf', 'utf8');
    const moves = [...text.matchAll(/moved\s*\{\s*from\s*=\s*(\S+)\s*to\s*=\s*(\S+)\s*\}/gu)].map(
      (match) => ({ from: match[1]!, to: match[2]! }),
    );
    expect(moves.map((move) => move.from).sort()).toEqual([...inventory.resources].sort());
    expect(new Set(moves.map((move) => move.to)).size).toBe(moves.length);
    const files = readdirSync('deploy/terraform/modules/runtime').filter((file) =>
      file.endsWith('.tf'),
    );
    const resources = new Set(
      files.flatMap((file) =>
        [
          ...readFileSync(join('deploy/terraform/modules/runtime', file), 'utf8').matchAll(
            /^resource "([^"]+)" "([^"]+)"/gmu,
          ),
        ].map((match) => `${match[1]}.${match[2]}`),
      ),
    );
    for (const move of moves) {
      expect(move.to.startsWith('module.runtime.')).toBe(true);
      expect(
        resources.has(move.to.replace(/^module\.runtime\./u, '').replace(/\["shared"\]$/u, '')),
      ).toBe(true);
    }
    const indexed = moves
      .filter((move) => move.to.endsWith('["shared"]'))
      .map((move) => move.from)
      .sort();
    expect(indexed).toEqual([
      'aws_eip.nat',
      'aws_nat_gateway.main',
      'aws_route.private_egress',
      'aws_route_table.private',
    ]);
  });
  it('registers the moved migration task in both existing release workflows', () => {
    for (const name of ['deploy-staging.yml', 'rollback-staging.yml']) {
      const text = readFileSync(join('.github/workflows', name), 'utf8');
      expect(text).toContain("-target='module.runtime.aws_ecs_task_definition.migration'");
      expect(text).not.toContain("-target='aws_ecs_task_definition.migration'");
    }
  });
});
