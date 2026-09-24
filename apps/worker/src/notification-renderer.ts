import type { LocalizationStore, TelegramNotificationProjection } from '@nakh/application';
import { CatalogRenderer } from '@nakh/localization';

type CatalogReader = Pick<LocalizationStore, 'loadActiveCatalog'>;

/** Resolves only catalog-controlled notification copy in the recipient's current locale. */
export class WorkerNotificationRenderer {
  public constructor(private readonly localization: CatalogReader) {}

  public async render(
    projection: TelegramNotificationProjection,
  ): Promise<Readonly<{ title: string; body: string }>> {
    const catalog = await this.localization.loadActiveCatalog(projection.locale);
    const renderer = new CatalogRenderer(
      { [catalog.resolvedLocale]: catalog.messages },
      catalog.resolvedLocale,
    );
    return {
      title: renderer.render(catalog.resolvedLocale, {
        key: projection.titleKey,
        variables: {},
      }),
      body: renderer.render(catalog.resolvedLocale, {
        key: projection.bodyKey,
        variables: {},
      }),
    };
  }
}
