export interface MediaDeliveryPathStore {
  listDeliveryPaths(photoId: string): Promise<readonly string[]>;
}

export interface MediaCachePurger {
  purgePaths(paths: readonly string[]): Promise<void>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const deliveryPath = new RegExp(
  `^/media/${uuid.source.slice(1, -1)}/(?:thumbnail-v1|blurred-preview-v1)\\.webp$`,
  'u',
);

export class RevokePhotoDeliveryCache {
  public constructor(
    private readonly paths: MediaDeliveryPathStore,
    private readonly purger: MediaCachePurger,
  ) {}

  public async execute(photoId: string): Promise<void> {
    if (!uuid.test(photoId)) throw new Error('invalid_media_cache_revoke_request');
    const paths = [...new Set(await this.paths.listDeliveryPaths(photoId))].sort();
    if (paths.some((path) => !deliveryPath.test(path)))
      throw new Error('invalid_media_delivery_path');
    if (paths.length > 0) await this.purger.purgePaths(paths);
  }
}
