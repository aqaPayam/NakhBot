import type { MediaDeliveryPathStore } from '@nakh/application';

import type { NakhDatabase } from './database.js';

export class PostgresMediaDeliveryPathStore implements MediaDeliveryPathStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async listDeliveryPaths(photoId: string): Promise<readonly string[]> {
    const rows = await this.database
      .selectFrom('media.profile_photos as photo')
      .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'photo.asset_id')
      .select('variant.delivery_path')
      .where('photo.id', '=', photoId)
      .orderBy('variant.delivery_path')
      .execute();
    return rows.map((row) => row.delivery_path);
  }
}
