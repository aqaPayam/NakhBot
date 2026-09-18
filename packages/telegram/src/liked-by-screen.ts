import type { GetLockedLikedByPageHandler, LocalizedIntent } from '@nakh/application';

type LockedPage = Awaited<ReturnType<GetLockedLikedByPageHandler['execute']>>;
type BlurredGrant = LockedPage['cards'][number]['blurredPhoto'];

const OPAQUE_REFERENCE = /^v1\.lb\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16}$/u;
const MEDIA_PATH =
  /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/blurred-preview-v1\.webp$/u;

export type TelegramLockedLikedByCard = Readonly<{
  label: LocalizedIntent;
  /** For a future authenticated byte relay; never hand this URL to Telegram's fetcher. */
  blurredPhoto: BlurredGrant;
  unlock: Readonly<{ label: LocalizedIntent; callbackData: string }>;
}>;

export type TelegramLockedLikedByScreen = Readonly<{
  title: LocalizedIntent;
  emptyState?: LocalizedIntent;
  cards: readonly TelegramLockedLikedByCard[];
  nextPage?: Readonly<{ label: LocalizedIntent; callbackData: string }>;
}>;

function intent(key: string, variables: LocalizedIntent['variables'] = {}): LocalizedIntent {
  return { key, variables };
}

export class TelegramLockedLikedByPresenter {
  private readonly mediaOrigin: string;

  public constructor(
    mediaOrigin: string,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(mediaOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    )
      throw new Error('Liked By media origin is invalid.');
    this.mediaOrigin = url.origin;
  }

  private validGrant(grant: BlurredGrant): boolean {
    const expiry = new Date(grant.expiresAt);
    if (
      grant.variantType !== 'blurred_preview' ||
      grant.cachePolicy !== 'no-store' ||
      !Number.isFinite(expiry.getTime()) ||
      expiry.toISOString() !== grant.expiresAt ||
      expiry.getTime() <= this.now() ||
      grant.deliveryUrl.length > 2048
    )
      return false;
    try {
      const url = new URL(grant.deliveryUrl);
      const token = url.searchParams.get('token');
      return (
        url.origin === this.mediaOrigin &&
        url.username === '' &&
        url.password === '' &&
        MEDIA_PATH.test(url.pathname) &&
        url.searchParams.size === 1 &&
        token !== null &&
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  }

  public present(page: LockedPage): TelegramLockedLikedByScreen {
    if (
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < page.cards.length ||
      page.cards.length > 50 ||
      page.cards.some(
        (card) => !OPAQUE_REFERENCE.test(card.actionToken) || !this.validGrant(card.blurredPhoto),
      ) ||
      (page.nextCursor !== undefined && !OPAQUE_REFERENCE.test(page.nextCursor))
    )
      throw new Error('Liked By screen input is invalid.');
    const cards = page.cards.map((card, index) => ({
      label: intent('liked_by.card.locked', { position: index + 1 }),
      blurredPhoto: card.blurredPhoto,
      unlock: {
        label: intent('liked_by.button.unlock'),
        callbackData: card.actionToken,
      },
    }));
    return {
      title: intent('liked_by.title', { count: page.totalCount }),
      ...(cards.length === 0 ? { emptyState: intent('liked_by.empty') } : {}),
      cards,
      ...(page.nextCursor === undefined
        ? {}
        : {
            nextPage: {
              label: intent('liked_by.button.next'),
              callbackData: page.nextCursor,
            },
          }),
    };
  }
}
