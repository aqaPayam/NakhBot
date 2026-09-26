/**
 * Builds rounds across every independent scope before starting the next round.
 * This preserves per-scope contention without letting a bounded connection pool
 * fill entirely with work blocked behind only the first few scopes.
 */
export function roundRobinWork<TScope, TWork>(
  scopes: readonly TScope[],
  rounds: number,
  create: (scope: TScope, round: number) => TWork,
): TWork[] {
  if (!Number.isSafeInteger(rounds) || rounds < 0)
    throw new RangeError('rounds must be a non-negative safe integer');
  const work: TWork[] = [];
  for (let round = 0; round < rounds; round += 1)
    for (const scope of scopes) work.push(create(scope, round));
  return work;
}
