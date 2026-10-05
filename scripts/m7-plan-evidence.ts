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
    maximumWorkersPlanned: number;
    maximumWorkersLaunched: number;
    jitTotalMs: number;
    nodes: readonly Readonly<{
      parent: number;
      nodeType: string;
      relation: string;
      rows: number;
      loops: number;
      totalMs: number;
    }>[];
    nodesTruncated: boolean;
    slowNodes: readonly Readonly<{
      nodeType: string;
      relation: string;
      totalMs: number;
      loops: number;
      cumulativeMs: number;
    }>[];
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
  let maximumWorkersPlanned = 0,
    maximumWorkersLaunched = 0;
  const nodeTypes = new Set([
    'Aggregate',
    'Append',
    'Hash Join',
    'Hash',
    'Seq Scan',
    'Index Scan',
    'Index Only Scan',
    'Sort',
    'Incremental Sort',
    'Nested Loop',
    'Subquery Scan',
    'Result',
    'Materialize',
    'Memoize',
    'Gather',
    'Gather Merge',
    'Bitmap Heap Scan',
    'Bitmap Index Scan',
    'Merge Join',
    'Unique',
    'WindowAgg',
    'CTE Scan',
  ]);
  const relations = new Set([
    'reports',
    'report_evidence',
    'report_snapshots',
    'photo_variants',
    'media_assets',
    'report_photo_evidence_holds',
    'moderation_actions',
    'audit_logs',
    'notifications',
    'notification_deliveries',
    'chat_message_snapshots',
    'account_state_history',
    'threshold_admission_witnesses',
    'restriction_episodes',
    'admin_action_logs',
    'user_appeals',
    'support_messages',
    'support_threads',
    'feature_unlocks',
    'matches',
    'likes',
    'profile_photos',
    'profiles',
    'moderation_reviews',
  ]);
  const slowNodes: {
    nodeType: string;
    relation: string;
    totalMs: number;
    loops: number;
    cumulativeMs: number;
  }[] = [];
  const nodes: {
    parent: number;
    nodeType: string;
    relation: string;
    rows: number;
    loops: number;
    totalMs: number;
  }[] = [];
  let nodesTruncated = false;
  const timing = (node: Readonly<Record<string, unknown>> | undefined, key: string): number => {
    const field = node?.[key];
    return typeof field === 'number' &&
      Number.isFinite(field) &&
      field >= 0 &&
      field <= Number.MAX_SAFE_INTEGER
      ? field
      : 0;
  };
  const numeric = (node: Readonly<Record<string, unknown>>, key: string): number => {
    const field = node[key];
    return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : 0;
  };
  const visit = (node: Readonly<Record<string, unknown>>, parent: number): void => {
    const index = node['Index Name'];
    maximumWorkersPlanned = Math.max(maximumWorkersPlanned, numeric(node, 'Workers Planned'));
    maximumWorkersLaunched = Math.max(maximumWorkersLaunched, numeric(node, 'Workers Launched'));
    const nodeType = node['Node Type'],
      relation = node['Relation Name'],
      totalMs = timing(node, 'Actual Total Time'),
      loops = numeric(node, 'Actual Loops');
    const position = nodes.length < 256 ? nodes.length : -1;
    if (position !== -1)
      nodes.push({
        parent,
        nodeType: typeof nodeType === 'string' && nodeTypes.has(nodeType) ? nodeType : 'Other',
        relation: typeof relation === 'string' && relations.has(relation) ? relation : 'Other',
        rows: numeric(node, 'Actual Rows'),
        loops,
        totalMs,
      });
    else nodesTruncated = true;
    if (totalMs > 0 && loops > 0) {
      slowNodes.push({
        nodeType: typeof nodeType === 'string' && nodeTypes.has(nodeType) ? nodeType : 'Other',
        relation: typeof relation === 'string' && relations.has(relation) ? relation : 'Other',
        totalMs,
        loops,
        cumulativeMs: timing({ time: totalMs * loops }, 'time'),
      });
      slowNodes.sort((left, right) => right.cumulativeMs - left.cumulativeMs);
      if (slowNodes.length > 24) slowNodes.length = 24;
    }
    maximumHashBatches = Math.max(maximumHashBatches, numeric(node, 'Hash Batches'));
    maximumLoops = Math.max(maximumLoops, numeric(node, 'Actual Loops'));
    if (node['Sort Space Type'] === 'Disk') diskSortKb += numeric(node, 'Sort Space Used');
    if (typeof index === 'string' && /^[a-z][a-z0-9_]{0,79}$/u.test(index)) indexNames.add(index);
    if (Array.isArray(node.Plans))
      for (const child of node.Plans as readonly unknown[]) {
        const record = object(child);
        if (record !== undefined) visit(record, position);
      }
  };
  visit(root, -1);
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
      maximumWorkersPlanned,
      maximumWorkersLaunched,
      jitTotalMs: timing(object(object(document?.JIT)?.Timing), 'Total'),
      nodes,
      nodesTruncated,
      slowNodes,
    },
  };
}
