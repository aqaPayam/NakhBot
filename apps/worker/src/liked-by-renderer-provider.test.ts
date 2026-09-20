import { describe, expect, it, vi } from 'vitest';

import { WorkerTelegramLikedByRendererProvider } from './liked-by-renderer-provider.js';

const identity = {
  userId: '10000000-0000-4000-8000-000000000000',
  accountState: 'active' as const,
  profileCompletion: 'complete' as const,
  visibilityEnabled: true,
  uiLocale: 'fa',
  guestPreviewCount: 0,
  guestPreviewLimit: 5,
  entryRoute: 'main_menu' as const,
  accountVersion: 1,
  settingsVersion: 1,
};

describe('worker Telegram Liked By renderer provider', () => {
  it('loads the current locale and catalog only when delivery begins', async () => {
    const identities = { getByUserId: vi.fn().mockResolvedValue(identity) };
    const localization = {
      loadActiveCatalog: vi.fn().mockResolvedValue({
        requestedLocale: 'fa',
        resolvedLocale: 'en',
        messages: { 'liked_by.title': 'People: {count}' },
      }),
    };
    const provider = new WorkerTelegramLikedByRendererProvider(identities, localization);
    expect(identities.getByUserId).not.toHaveBeenCalled();
    const render = await provider.rendererFor(identity.userId);
    expect(identities.getByUserId).toHaveBeenCalledWith(identity.userId);
    expect(localization.loadActiveCatalog).toHaveBeenCalledWith('fa');
    expect(render({ key: 'liked_by.title', variables: { count: 3 } })).toBe('People: 3');
  });

  it('fails closed when the delivery identity no longer exists', async () => {
    const localization = { loadActiveCatalog: vi.fn() };
    const provider = new WorkerTelegramLikedByRendererProvider(
      { getByUserId: vi.fn().mockResolvedValue(undefined) },
      localization,
    );
    await expect(provider.rendererFor(identity.userId)).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(localization.loadActiveCatalog).not.toHaveBeenCalled();
  });

  it('fails closed when a required localization key or variable is missing', async () => {
    const provider = new WorkerTelegramLikedByRendererProvider(
      { getByUserId: vi.fn().mockResolvedValue(identity) },
      {
        loadActiveCatalog: vi.fn().mockResolvedValue({
          requestedLocale: 'fa',
          resolvedLocale: 'fa',
          messages: { 'liked_by.title': 'افراد: {count}' },
        }),
      },
    );
    const render = await provider.rendererFor(identity.userId);
    expect(() => render({ key: 'liked_by.empty', variables: {} })).toThrow(
      'Missing localization key',
    );
    expect(() => render({ key: 'liked_by.title', variables: {} })).toThrow(
      'Missing localization variable',
    );
  });
});
