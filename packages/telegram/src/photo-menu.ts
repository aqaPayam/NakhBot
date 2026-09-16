import type { LocalizedIntent, OwnPhotoCollection } from '@nakh/application';

import type { TelegramPhotoActionTokens } from './action-token.js';

export type TelegramPhotoMenuButton = Readonly<{
  kind: 'delete' | 'move_down' | 'move_up' | 'select_primary';
  label: LocalizedIntent;
  callbackData: string;
}>;

export type TelegramPhotoMenuRow = Readonly<{
  label: LocalizedIntent;
  buttons: readonly TelegramPhotoMenuButton[];
}>;

export type TelegramPhotoMenu = Readonly<{
  title: LocalizedIntent;
  emptyState?: LocalizedIntent;
  rows: readonly TelegramPhotoMenuRow[];
}>;

type ActionTokenIssuer = Pick<TelegramPhotoActionTokens, 'issue'>;

function intent(key: string, variables: LocalizedIntent['variables'] = {}): LocalizedIntent {
  return { key, variables };
}

function moved(ids: readonly string[], from: number, to: number): readonly string[] {
  const result = [...ids];
  const [photoId] = result.splice(from, 1);
  if (photoId === undefined) throw new Error('Photo menu ordering is invalid.');
  result.splice(to, 0, photoId);
  return result;
}

export class TelegramPhotoMenuPresenter {
  public constructor(
    private readonly tokens: ActionTokenIssuer,
    private readonly tokenTtlSeconds = 900,
  ) {
    if (!Number.isSafeInteger(tokenTtlSeconds) || tokenTtlSeconds < 30 || tokenTtlSeconds > 3600)
      throw new Error('Telegram photo-menu token lifetime is invalid.');
  }

  public async present(
    telegramUserId: string,
    collection: OwnPhotoCollection,
  ): Promise<TelegramPhotoMenu> {
    const photos = collection.photos
      .filter((photo) => photo.status !== 'deleted')
      .toSorted(
        (left, right) => left.displayOrder - right.displayOrder || left.id.localeCompare(right.id),
      );
    const orderedPhotoIds = photos.map((photo) => photo.id);
    const rows: TelegramPhotoMenuRow[] = [];

    for (const [index, photo] of photos.entries()) {
      const issue = async (
        action: Parameters<ActionTokenIssuer['issue']>[0]['action'],
      ): Promise<string> =>
        this.tokens.issue(
          {
            telegramUserId,
            expectedProfileVersion: collection.profileVersion,
            action,
          },
          this.tokenTtlSeconds,
        );
      const buttons: TelegramPhotoMenuButton[] = [];

      if (photo.status === 'visible' && !photo.isPrimary) {
        buttons.push({
          kind: 'select_primary',
          label: intent('media.photos.button.set_primary'),
          callbackData: await issue({ type: 'select_primary', photoId: photo.id }),
        });
      }
      if (index > 0) {
        buttons.push({
          kind: 'move_up',
          label: intent('media.photos.button.move_up'),
          callbackData: await issue({
            type: 'reorder',
            orderedPhotoIds: moved(orderedPhotoIds, index, index - 1),
          }),
        });
      }
      if (index < photos.length - 1) {
        buttons.push({
          kind: 'move_down',
          label: intent('media.photos.button.move_down'),
          callbackData: await issue({
            type: 'reorder',
            orderedPhotoIds: moved(orderedPhotoIds, index, index + 1),
          }),
        });
      }
      if (!photo.isPrimary) {
        buttons.push({
          kind: 'delete',
          label: intent('media.photos.button.delete'),
          callbackData: await issue({ type: 'delete', photoId: photo.id }),
        });
      }

      rows.push({
        label: intent(
          photo.isPrimary
            ? 'media.photos.item.primary'
            : photo.status === 'visible'
              ? 'media.photos.item.visible'
              : 'media.photos.item.hidden',
          { position: index + 1 },
        ),
        buttons,
      });
    }

    return {
      title: intent('media.photos.title', { count: photos.length }),
      ...(rows.length === 0 ? { emptyState: intent('media.photos.empty') } : {}),
      rows,
    };
  }
}
