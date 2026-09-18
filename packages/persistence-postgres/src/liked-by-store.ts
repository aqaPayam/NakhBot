import { sql, type RawBuilder } from 'kysely';

import type { ActionableLikedByPage, LikedByKeyset, LikedByReadStore } from '@nakh/application';
import type { GetLikedByPageQuery } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { NakhDatabase } from './database.js';

function actionableFrom(receiverUserId: string): RawBuilder<unknown> {
  return sql`
    FROM interaction.likes incoming
    JOIN identity.accounts liker_account ON liker_account.user_id = incoming.sender_user_id
    JOIN profile.profiles liker_profile ON liker_profile.user_id = incoming.sender_user_id
    JOIN media.profile_photos primary_photo ON primary_photo.profile_id = liker_profile.id
    JOIN media.media_assets primary_asset ON primary_asset.id = primary_photo.asset_id
    JOIN media.photo_variants thumbnail ON thumbnail.asset_id = primary_asset.id
    WHERE incoming.receiver_user_id = ${receiverUserId}::uuid
      AND incoming.status = 'active'
      AND liker_account.state = 'active'
      AND liker_profile.completion_status = 'complete'
      AND primary_photo.status = 'visible' AND primary_photo.is_primary
      AND primary_asset.validation_state = 'valid'
      AND primary_asset.deleted_at IS NULL AND primary_asset.storage_deleted_at IS NULL
      AND thumbnail.variant_type = 'thumbnail' AND thumbnail.transformation_version = 1
      AND thumbnail.deleted_at IS NULL AND thumbnail.storage_deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM interaction.user_pair_states pair
        WHERE pair.user_low_id = LEAST(incoming.sender_user_id, ${receiverUserId}::uuid)
          AND pair.user_high_id = GREATEST(incoming.sender_user_id, ${receiverUserId}::uuid)
      )
      AND NOT EXISTS (
        SELECT 1 FROM interaction.not_interested rejection
        WHERE rejection.sender_user_id = ${receiverUserId}::uuid
          AND rejection.receiver_user_id = incoming.sender_user_id
      )
  `;
}

function denied(): never {
  throw new ApplicationError('capability_denied', 'error.capability.denied', 403);
}

export class PostgresLikedByStore implements LikedByReadStore {
  public constructor(private readonly database: NakhDatabase) {}

  public readActionablePage(
    query: GetLikedByPageQuery,
    after?: LikedByKeyset,
  ): Promise<ActionableLikedByPage> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50)
      throw new ApplicationError('invalid_request', 'error.interaction.page_limit_invalid', 400);
    return this.database
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (transaction) => {
        const receiver = await transaction
          .selectFrom('identity.accounts as account')
          .innerJoin('identity.user_settings as settings', 'settings.user_id', 'account.user_id')
          .innerJoin('profile.profiles as profile', 'profile.user_id', 'account.user_id')
          .select(['account.state', 'settings.visibility_enabled', 'profile.completion_status'])
          .where('account.user_id', '=', query.actor.userId)
          .executeTakeFirst();
        if (
          receiver?.state !== 'active' ||
          receiver.completion_status !== 'complete' ||
          !receiver.visibility_enabled
        )
          denied();

        const from = actionableFrom(query.actor.userId);
        const countResult = await sql<{ count: string }>`SELECT count(*) AS count ${from}`.execute(
          transaction,
        );
        const totalCount = Number(countResult.rows[0]?.count);
        if (!Number.isSafeInteger(totalCount))
          throw new ApplicationError('internal_error', 'error.internal', 500);
        const position =
          after === undefined
            ? sql``
            : sql`AND (
                incoming.created_at < ${after.createdAt}
                OR (incoming.created_at = ${after.createdAt} AND incoming.id < ${after.likeId}::uuid)
              )`;
        const pageResult = await sql<{
          like_id: string;
          primary_photo_id: string;
          created_at: Date;
        }>`
          SELECT incoming.id AS like_id, primary_photo.id AS primary_photo_id,
            incoming.created_at AS created_at
          ${from}
          ${position}
          ORDER BY incoming.created_at DESC, incoming.id DESC
          LIMIT ${query.limit + 1}
        `.execute(transaction);
        return {
          totalCount,
          rows: pageResult.rows.slice(0, query.limit).map((row) => ({
            likeId: row.like_id,
            primaryPhotoId: row.primary_photo_id,
            createdAt: row.created_at,
          })),
          hasMore: pageResult.rows.length > query.limit,
        };
      });
  }
}
