import type { LocalizedIntent } from '@nakh/application';

export * from './m1-catalog.js';
export * from './m5-catalog.js';

export type MessageCatalog = Readonly<Record<string, Readonly<Record<string, string>>>>;

export class CatalogRenderer {
  public constructor(
    private readonly catalog: MessageCatalog,
    private readonly defaultLocale = 'en',
  ) {}

  public render(locale: string, intent: LocalizedIntent): string {
    const template =
      this.catalog[locale]?.[intent.key] ??
      this.catalog[this.defaultLocale]?.[intent.key] ??
      (intent.fallbackKey === undefined
        ? undefined
        : this.catalog[this.defaultLocale]?.[intent.fallbackKey]);
    if (template === undefined) throw new Error(`Missing localization key: ${intent.key}`);

    return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (_match, variable: string) => {
      const value = intent.variables[variable];
      if (value === undefined) throw new Error(`Missing localization variable: ${variable}`);
      return String(value);
    });
  }
}
