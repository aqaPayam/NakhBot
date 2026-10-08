import { describe, expect, it } from 'vitest';
import {
  assertDeletionCatalogCoverage,
  DELETION_REGISTRY,
  DELETION_OBJECT_PREFIXES,
  type DeletionCatalog,
} from './deletion-registry.js';

function expectedCatalog(): DeletionCatalog {
  return {
    tables: DELETION_REGISTRY.map((entry) => ({
      schema: entry.table.split('.')[0]!,
      table: entry.table.split('.')[1]!,
      columns: entry.columns,
    })),
    foreignKeys: DELETION_REGISTRY.flatMap((entry) =>
      entry.foreignKeys.map((key) => ({ table: entry.table, ...key })),
    ),
  };
}
describe('M8 schema coverage denial', () => {
  it('rejects a new entity instead of applying an inherited retain/purge default', () => {
    const actual = expectedCatalog();
    expect(() =>
      assertDeletionCatalogCoverage({
        ...actual,
        tables: [
          ...actual.tables,
          { schema: 'profile', table: 'unclassified_private_data', columns: [] },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
  it.each(['new_column', 'removed_column', 'type', 'nullable'] as const)(
    'rejects unreviewed %s drift even when all table names match',
    (kind) => {
      const actual = expectedCatalog(),
        first = actual.tables[0]!;
      const columns =
        kind === 'new_column'
          ? [...first.columns, { name: 'private_payload', type: 'text', nullable: true }]
          : kind === 'removed_column'
            ? first.columns.slice(1)
            : first.columns.map((item, index) =>
                index !== 0
                  ? item
                  : kind === 'type'
                    ? { ...item, type: 'text' }
                    : { ...item, nullable: !item.nullable },
              );
      expect(() =>
        assertDeletionCatalogCoverage({
          ...actual,
          tables: [{ ...first, columns }, ...actual.tables.slice(1)],
        }),
      ).toThrow(expect.objectContaining({ code: 'conflict' }));
    },
  );
  it.each(['added', 'removed', 'cascade'] as const)('rejects %s dependency drift', (kind) => {
    const actual = expectedCatalog(),
      first = actual.foreignKeys[0]!;
    const foreignKeys =
      kind === 'added'
        ? [...actual.foreignKeys, { ...first, definition: first.definition + ' DEFERRABLE' }]
        : kind === 'removed'
          ? actual.foreignKeys.slice(1)
          : [
              { ...first, definition: first.definition.replace('RESTRICT', 'CASCADE') },
              ...actual.foreignKeys.slice(1),
            ];
    expect(() => assertDeletionCatalogCoverage({ ...actual, foreignKeys })).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    );
  });
  it('keeps financial, safety and workforce authority out of ordinary purge', () => {
    for (const table of [
      'billing.credit_transactions',
      'billing.telegram_stars_receipts',
      'moderation.reports',
      'media.report_photo_evidence_holds',
      'administration.admin_totp_credentials',
    ]) {
      const entry = DELETION_REGISTRY.find((item) => item.table === table)!;
      expect(entry.action).not.toBe('purge_product');
      expect(entry.releasePolicy).toBe('approval_required');
    }
    expect(
      DELETION_REGISTRY.find((item) => item.table === 'identity.guest_preview_counters')
        ?.classification,
    ).toBe('stable_identity');
    expect(
      DELETION_OBJECT_PREFIXES.find((item) => item.prefix.startsWith('variants/'))?.action,
    ).toBe('verify_absence_except_exact_held_variant');
    expect(() => {
      Object.assign(DELETION_REGISTRY[0]!, { action: 'purge_product' });
    }).toThrow();
  });
});
