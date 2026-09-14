export type MediaObjectCandidate = Readonly<{ key: string; lastModified: Date }>;

export interface MediaObjectReferencePort {
  findReferenced(keys: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface OrphanDeletionPort {
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

export type OrphanReconciliationResult = Readonly<{
  examined: number;
  deferred: number;
  referenced: number;
  deleted: number;
}>;

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export class ReconcileMediaObjectCandidates {
  private readonly keyPattern: RegExp;

  public constructor(
    private readonly references: MediaObjectReferencePort,
    private readonly objects: OrphanDeletionPort,
    environment: 'development' | 'test' | 'staging' | 'production',
    private readonly graceMs = 24 * 60 * 60 * 1_000,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 60 * 60 * 1_000)
      throw new Error('invalid_media_orphan_grace');
    this.keyPattern = new RegExp(
      `^(?:quarantine|validated)/${environment}/${uuid}/original$|^variants/${environment}/${uuid}/(?:thumbnail|blurred-preview)-v[1-9][0-9]*\\.webp$`,
      'u',
    );
  }

  public async execute(
    candidates: readonly MediaObjectCandidate[],
  ): Promise<OrphanReconciliationResult> {
    if (candidates.length > 100) throw new Error('media_orphan_batch_too_large');
    const cutoff = this.now().getTime() - this.graceMs;
    const eligible: string[] = [];
    let deferred = 0;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (
        !this.keyPattern.test(candidate.key) ||
        !(candidate.lastModified instanceof Date) ||
        !Number.isFinite(candidate.lastModified.getTime()) ||
        seen.has(candidate.key)
      )
        throw new Error('invalid_media_orphan_candidate');
      seen.add(candidate.key);
      if (candidate.lastModified.getTime() > cutoff) deferred += 1;
      else eligible.push(candidate.key);
    }
    const referenced = await this.references.findReferenced(eligible);
    const eligibleSet = new Set(eligible);
    if ([...referenced].some((key) => !eligibleSet.has(key)))
      throw new Error('invalid_media_orphan_reference_result');
    let deleted = 0;
    for (const key of eligible) {
      if (referenced.has(key)) continue;
      await this.objects.delete(key, AbortSignal.timeout(15_000));
      deleted += 1;
    }
    return {
      examined: candidates.length,
      deferred,
      referenced: eligible.length - deleted,
      deleted,
    };
  }
}
