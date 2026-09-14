import type { MediaObjectCandidate, OrphanReconciliationResult } from '@nakh/application';

type Environment = 'development' | 'test' | 'staging' | 'production';

export interface MediaObjectListingPort {
  listObjects(
    input: Readonly<{ prefix: string; cursor?: string; limit: number; signal?: AbortSignal }>,
  ): Promise<Readonly<{ objects: readonly MediaObjectCandidate[]; nextCursor?: string }>>;
}

export interface ScanCursorPort {
  get(prefix: string): Promise<string | undefined>;
  advance(prefix: string, cursor: string | undefined): Promise<void>;
}

type CandidateReconciler = Readonly<{
  execute(candidates: readonly MediaObjectCandidate[]): Promise<OrphanReconciliationResult>;
}>;

export class MediaOrphanScanner {
  public constructor(
    private readonly listing: MediaObjectListingPort,
    private readonly cursors: ScanCursorPort,
    private readonly reconciler: CandidateReconciler,
    private readonly environment: Environment,
  ) {}

  public async scanOnePagePerPrefix(): Promise<OrphanReconciliationResult> {
    const total = { examined: 0, deferred: 0, referenced: 0, deleted: 0 };
    for (const namespace of ['quarantine', 'validated', 'variants'] as const) {
      const prefix = `${namespace}/${this.environment}/`;
      const cursor = await this.cursors.get(prefix);
      const page = await this.listing.listObjects({
        prefix,
        ...(cursor === undefined ? {} : { cursor }),
        limit: 20,
        signal: AbortSignal.timeout(30_000),
      });
      const result = await this.reconciler.execute(page.objects);
      total.examined += result.examined;
      total.deferred += result.deferred;
      total.referenced += result.referenced;
      total.deleted += result.deleted;
      await this.cursors.advance(prefix, page.nextCursor);
    }
    return total;
  }
}
