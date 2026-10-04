export type M7PlanSummary = Readonly<{
  executionMs: number;
  actualRows: number;
  indexNames: readonly string[];
}>;
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
  const visit = (node: Readonly<Record<string, unknown>>): void => {
    const index = node['Index Name'];
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
  return { executionMs, actualRows: rows, indexNames: [...indexNames].sort() };
}
