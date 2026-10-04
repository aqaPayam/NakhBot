import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GetOwnAdminCommandReceiptHandler,
  type OwnAdminCommandReceiptStore,
} from './own-command-receipt.js';
describe('owned content-free command outcome recovery', () => {
  it('derives the owner from verified identity and rejects actor substitution before reading receipts', async () => {
    const actor = { kind: 'admin' as const, userId: randomUUID() },
      adminUserId = randomUUID();
    const receipt = {
      logId: randomUUID(),
      result: 'succeeded' as const,
      safeCode: 'completed',
      recordedAt: new Date(),
    };
    const get = vi.fn<OwnAdminCommandReceiptStore['get']>(() => Promise.resolve(receipt));
    const handler = new GetOwnAdminCommandReceiptHandler(
      { get: () => Promise.resolve({ adminUserId, telegramUserId: '123456789' }) },
      { get },
    );
    const query = { actor, requestId: randomUUID(), commandId: randomUUID() };
    await expect(handler.execute(query, { ...actor, userId: randomUUID() })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(get).not.toHaveBeenCalled();
    expect(await handler.execute(query, actor)).toEqual({
      ...receipt,
      replayed: true,
      value: undefined,
    });
    expect(get).toHaveBeenCalledWith(adminUserId, query.commandId);
    get.mockResolvedValueOnce(undefined);
    await expect(handler.execute(query, actor)).rejects.toMatchObject({ code: 'not_found' });
  });
});
