import { describe, expect, it } from 'vitest';

import { CatalogRenderer } from './index.js';

describe('CatalogRenderer', () => {
  it('falls back to English and renders typed variables', () => {
    const renderer = new CatalogRenderer({ en: { greeting: 'Hello {name}' } });

    expect(renderer.render('fa', { key: 'greeting', variables: { name: 'Nakh' } })).toBe(
      'Hello Nakh',
    );
  });
});
