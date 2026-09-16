import { describe, expect, it } from 'vitest';

import type { OwnPhotoAction, OwnPhotoCollection } from '@nakh/application';

import { TelegramPhotoMenuPresenter } from './photo-menu.js';

class RecordingTokens {
  public readonly states: Array<{
    telegramUserId: string;
    expectedProfileVersion: number;
    action: OwnPhotoAction;
  }> = [];

  public issue(state: (typeof this.states)[number]): Promise<string> {
    this.states.push(state);
    return Promise.resolve(
      `v1.pm.token${String(this.states.length).padStart(11, '0')}.signature000000`,
    );
  }
}

const first = '40000000-0000-4000-8000-000000000001';
const second = '40000000-0000-4000-8000-000000000002';
const third = '40000000-0000-4000-8000-000000000003';

const collection: OwnPhotoCollection = {
  profileVersion: 12,
  photos: [
    { id: third, status: 'hidden', isPrimary: false, displayOrder: 3, version: 1 },
    { id: first, status: 'visible', isPrimary: true, displayOrder: 1, version: 2 },
    { id: second, status: 'visible', isPrimary: false, displayOrder: 2, version: 4 },
  ],
};

describe('TelegramPhotoMenuPresenter', () => {
  it('emits localization intents and only opaque callback data', async () => {
    const tokens = new RecordingTokens();
    const menu = await new TelegramPhotoMenuPresenter(tokens).present('123456789', collection);

    expect(menu.title).toEqual({ key: 'media.photos.title', variables: { count: 3 } });
    expect(menu.rows.map((row) => row.label)).toEqual([
      { key: 'media.photos.item.primary', variables: { position: 1 } },
      { key: 'media.photos.item.visible', variables: { position: 2 } },
      { key: 'media.photos.item.hidden', variables: { position: 3 } },
    ]);
    expect(JSON.stringify(menu)).not.toContain(first);
    expect(JSON.stringify(menu)).not.toContain(second);
    expect(JSON.stringify(menu)).not.toContain(third);
    expect(JSON.stringify(menu)).not.toContain('123456789');
    for (const row of menu.rows) {
      for (const button of row.buttons) expect(button.callbackData.length).toBeLessThanOrEqual(64);
    }
    expect(menu.rows[0]?.buttons.map((button) => button.kind)).toEqual(['move_down']);
    expect(menu.rows[1]?.buttons.map((button) => button.kind)).toEqual([
      'select_primary',
      'move_up',
      'move_down',
      'delete',
    ]);
    expect(menu.rows[2]?.buttons.map((button) => button.kind)).toEqual(['move_up', 'delete']);
    expect(tokens.states.every((state) => state.telegramUserId === '123456789')).toBe(true);
    expect(tokens.states.every((state) => state.expectedProfileVersion === 12)).toBe(true);
  });

  it('encodes complete deterministic reorder actions in server-side token state', async () => {
    const tokens = new RecordingTokens();
    await new TelegramPhotoMenuPresenter(tokens).present('123456789', collection);
    expect(
      tokens.states.map((state) => state.action).filter((action) => action.type === 'reorder'),
    ).toEqual([
      { type: 'reorder', orderedPhotoIds: [second, first, third] },
      { type: 'reorder', orderedPhotoIds: [second, first, third] },
      { type: 'reorder', orderedPhotoIds: [first, third, second] },
      { type: 'reorder', orderedPhotoIds: [first, third, second] },
    ]);
  });

  it('returns a localized empty state and never issues actions for deleted photos', async () => {
    const tokens = new RecordingTokens();
    const menu = await new TelegramPhotoMenuPresenter(tokens).present('123456789', {
      profileVersion: 3,
      photos: [{ id: first, status: 'deleted', isPrimary: false, displayOrder: 1, version: 1 }],
    });
    expect(menu).toEqual({
      title: { key: 'media.photos.title', variables: { count: 0 } },
      emptyState: { key: 'media.photos.empty', variables: {} },
      rows: [],
    });
    expect(tokens.states).toEqual([]);
  });
});
