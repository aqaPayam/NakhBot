export type M7PlanSummary = Readonly<{
  executionMs: number;
  actualRows: number;
  indexNames: readonly string[];
  diagnostics?: Readonly<{
    tempReadBlocks: number;
    tempWrittenBlocks: number;
    maximumHashBatches: number;
    diskSortKb: number;
    maximumLoops: number;
  }>;
}>;
export function m7PlanPasses(
  plan: M7PlanSummary | undefined,
  indexes: readonly string[] | undefined,
): boolean {
  return (
    plan !== undefined &&
    plan.executionMs <= 1500 &&
    (indexes === undefined || indexes.some((index) => plan.indexNames.includes(index)))
  );
}
function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
/** Export a positive allowlist only. EXPLAIN predicates can contain private bound parameters. */
export function summarizeM7Plan(value: unknown): M7PlanSummary {
  const document = object(Array.isArray(value) ? (value as readonly unknown[])[0] : value);
  const root = object(document?.Plan),
    executionMs = document?.['Execution Time'];
  if (
    root === undefined ||
    typeof executionMs !== 'number' ||
    !Number.isFinite(executionMs) ||
    executionMs < 0
  )
    throw new Error('M7 query plan unavailable.');
  const indexNames = new Set<string>();
  let maximumHashBatches = 0,
    diskSortKb = 0,
    maximumLoops = 0;
  const numeric = (node: Readonly<Record<string, unknown>>, key: string): number => {
    const field = node[key];
    return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : 0;
  };
  const visit = (node: Readonly<Record<string, unknown>>): void => {
    const index = node['Index Name'];
    maximumHashBatches = Math.max(maximumHashBatches, numeric(node, 'Hash Batches'));
    maximumLoops = Math.max(maximumLoops, numeric(node, 'Actual Loops'));
    if (node['Sort Space Type'] === 'Disk') diskSortKb += numeric(node, 'Sort Space Used');
    if (typeof index === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(index)) indexNames.add(index);
    if (Array.isArray(node.Plans))
      for (const child of node.Plans as readonly unknown[]) {
        const record = object(child);
        if (record !== undefined) visit(record);
      }
  };
  visit(root);
  const rows = root['Actual Rows'];
  if (typeof rows !== 'number' || !Number.isSafeInteger(rows) || rows < 0)
    throw new Error('M7 query plan invalid.');
  return {
    executionMs,
    actualRows: rows,
    indexNames: [...indexNames].sort(),
    diagnostics: {
      tempReadBlocks: numeric(root, 'Temp Read Blocks'),
      tempWrittenBlocks: numeric(root, 'Temp Written Blocks'),
      maximumHashBatches,
      diskSortKb,
      maximumLoops,
    },
  };
}
