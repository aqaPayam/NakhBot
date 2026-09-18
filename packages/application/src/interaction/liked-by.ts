import type { GetLikedByPageQuery } from '@nakh/contracts';

export type LikedByKeyset = Readonly<{ createdAt: Date; likeId: string }>;

/** Internal projection only. Never serialize these identifiers to a locked client. */
export type ActionableLikedByRow = Readonly<{
  likeId: string;
  primaryPhotoId: string;
  createdAt: Date;
}>;

export type ActionableLikedByPage = Readonly<{
  totalCount: number;
  rows: readonly ActionableLikedByRow[];
  hasMore: boolean;
}>;

export interface LikedByReadStore {
  readActionablePage(
    query: GetLikedByPageQuery,
    after?: LikedByKeyset,
  ): Promise<ActionableLikedByPage>;
}
