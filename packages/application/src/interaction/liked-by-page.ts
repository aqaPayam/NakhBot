import type { GetLikedByPageQuery, LockedLikedByPage } from '@nakh/contracts';
import { ApplicationError } from '@nakh/domain';

import type { EnsureBlurredPreview } from '../media/blur.js';
import type { ResolveMediaDeliveryGrantHandler } from '../media/delivery.js';
import type { LikedByOpaqueReferences } from './liked-by-tokens.js';
import type { LikedByReadStore } from './liked-by.js';

type References = Pick<LikedByOpaqueReferences, 'resolveCursor' | 'issueCursor' | 'issueAction'>;
type Blur = Pick<EnsureBlurredPreview, 'execute'>;
type Grants = Pick<ResolveMediaDeliveryGrantHandler, 'execute'>;

const mediaConcurrency = 4;

/** Only this privacy-reduced result may cross from the internal Like projection to a client. */
export class GetLockedLikedByPageHandler {
  public constructor(
    private readonly store: LikedByReadStore,
    private readonly references: References,
    private readonly blur: Blur,
    private readonly grants: Grants,
  ) {}

  public async execute(query: GetLikedByPageQuery): Promise<LockedLikedByPage> {
    if (query.actor.kind !== 'user')
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const after =
      query.cursor === undefined
        ? undefined
        : await this.references.resolveCursor(query.cursor, query.actor.userId);
    if (query.cursor !== undefined && after === undefined)
      throw new ApplicationError('invalid_request', 'error.interaction.cursor_invalid', 400);
    const page = await this.store.readActionablePage(query, after);
    const cards: LockedLikedByPage['cards'][number][] = [];
    for (let offset = 0; offset < page.rows.length; offset += mediaConcurrency) {
      const batch = page.rows.slice(offset, offset + mediaConcurrency);
      cards.push(
        ...(await Promise.all(
          batch.map(async (row) => {
            await this.blur.execute(row.assetId);
            const blurredPhoto = await this.grants.execute({
              actor: query.actor,
              requestId: query.requestId,
              photoId: row.primaryPhotoId,
              purpose: 'liked_by_blur',
              requestedVariant: 'blurred_preview',
            });
            if (
              blurredPhoto.variantType !== 'blurred_preview' ||
              blurredPhoto.cachePolicy !== 'no-store'
            )
              throw new ApplicationError('internal_error', 'error.internal', 500);
            const actionToken = await this.references.issueAction(query.actor.userId, row.likeId);
            return {
              actionToken,
              blurredPhoto: {
                deliveryUrl: blurredPhoto.deliveryUrl,
                expiresAt: blurredPhoto.expiresAt,
                variantType: 'blurred_preview' as const,
                cachePolicy: 'no-store' as const,
              },
            };
          }),
        )),
      );
    }
    if (!page.hasMore) return { totalCount: page.totalCount, cards };
    const last = page.rows.at(-1);
    if (last === undefined) throw new ApplicationError('internal_error', 'error.internal', 500);
    const nextCursor = await this.references.issueCursor(query.actor.userId, {
      createdAt: last.createdAt,
      likeId: last.likeId,
    });
    return { totalCount: page.totalCount, cards, nextCursor };
  }
}
