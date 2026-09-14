export type PendingMediaCleanup = Readonly<{
  assetId: string;
  deletionGeneration: number;
  objectKeys: readonly string[];
}>;

export interface MediaCleanupStore {
  claimPhoto(
    input: Readonly<{ photoId: string; owner: string; leaseMs: number }>,
  ): Promise<PendingMediaCleanup | undefined>;
  complete(
    input: Readonly<{
      assetId: string;
      deletionGeneration: number;
      owner: string;
      completedAt: Date;
    }>,
  ): Promise<void>;
  release(assetId: string, owner: string): Promise<void>;
}

export interface MediaCleanupObjectPort {
  delete(key: string, signal?: AbortSignal): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export class DeletePhotoMediaObjects {
  public constructor(
    private readonly store: MediaCleanupStore,
    private readonly objects: MediaCleanupObjectPort,
    private readonly environment: 'development' | 'test' | 'staging' | 'production',
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs = 120_000,
  ) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 900_000)
      throw new Error('invalid_media_cleanup_lease');
  }

  public async execute(photoId: string, owner: string): Promise<void> {
    const plan = await this.store.claimPhoto({ photoId, owner, leaseMs: this.leaseMs });
    if (plan === undefined) return;
    try {
      this.validate(plan);
      for (const key of plan.objectKeys)
        await this.objects.delete(key, AbortSignal.timeout(15_000));
      await this.store.complete({
        assetId: plan.assetId,
        deletionGeneration: plan.deletionGeneration,
        owner,
        completedAt: this.now(),
      });
    } catch (error) {
      await this.store.release(plan.assetId, owner).catch(() => undefined);
      throw error;
    }
  }

  private validate(plan: PendingMediaCleanup): void {
    if (
      !uuid.test(plan.assetId) ||
      !Number.isSafeInteger(plan.deletionGeneration) ||
      plan.deletionGeneration < 1 ||
      plan.objectKeys.length < 1 ||
      plan.objectKeys.length > 8 ||
      new Set(plan.objectKeys).size !== plan.objectKeys.length
    )
      throw new Error('invalid_media_cleanup_plan');
    const prefix = `${this.environment}/${plan.assetId}`;
    const quarantineKey = `quarantine/${prefix}/original`;
    const validatedKey = `validated/${prefix}/original`;
    const variantKey = new RegExp(
      `^variants/${prefix}/(?:thumbnail|blurred-preview)-v[1-9][0-9]*\\.webp$`,
      'u',
    );
    if (
      !plan.objectKeys.includes(quarantineKey) ||
      plan.objectKeys.some(
        (key) => key !== quarantineKey && key !== validatedKey && !variantKey.test(key),
      )
    )
      throw new Error('invalid_media_cleanup_plan');
  }
}
