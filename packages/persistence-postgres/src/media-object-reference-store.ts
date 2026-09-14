import type { MediaObjectReferencePort } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

export class PostgresMediaObjectReferenceStore implements MediaObjectReferencePort {
  public constructor(private readonly database: NakhDatabase) {}

  public async findReferenced(keys: readonly string[]): Promise<ReadonlySet<string>> {
    if (keys.length > 100 || new Set(keys).size !== keys.length)
      throw new ApplicationError('invalid_request', 'error.media.orphan_batch.invalid', 400);
    if (keys.length === 0) return new Set();
    const [quarantine, validated, variants] = await Promise.all([
      this.database
        .selectFrom('media.media_assets')
        .select('quarantine_key as key')
        .where('quarantine_key', 'in', keys)
        .execute(),
      this.database
        .selectFrom('media.media_assets')
        .select('validated_key as key')
        .where('validated_key', 'in', keys)
        .execute(),
      this.database
        .selectFrom('media.photo_variants')
        .select('storage_key as key')
        .where('storage_key', 'in', keys)
        .execute(),
    ]);
    return new Set(
      [...quarantine, ...validated, ...variants]
        .map((row) => row.key)
        .filter((key): key is string => key !== null),
    );
  }
}
