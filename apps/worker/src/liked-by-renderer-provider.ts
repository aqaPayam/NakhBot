import type { IdentityStore, LocalizationStore, LocalizedIntent } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { CatalogRenderer } from '@nakh/localization';

import type { TelegramLikedByRendererProvider } from './liked-by-resumable-sender.js';

type IdentityReader = Pick<IdentityStore, 'getByUserId'>;
type CatalogReader = Pick<LocalizationStore, 'loadActiveCatalog'>;

/** Loads locale and active catalog at delivery time, never when the request is accepted. */
export class WorkerTelegramLikedByRendererProvider implements TelegramLikedByRendererProvider {
  public constructor(
    private readonly identities: IdentityReader,
    private readonly localization: CatalogReader,
  ) {}

  public async rendererFor(viewerUserId: string): Promise<(intent: LocalizedIntent) => string> {
    const identity = await this.identities.getByUserId(viewerUserId);
    if (identity === undefined)
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
    const catalog = await this.localization.loadActiveCatalog(identity.uiLocale);
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    return (intent) => renderer.render(catalog.resolvedLocale, intent);
  }
}
