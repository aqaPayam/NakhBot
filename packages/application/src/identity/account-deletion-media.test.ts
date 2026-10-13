import { createHash } from 'node:crypto';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { AccountDeletionLease } from './account-deletion.js';
import {
  ExecuteAccountDeletionMedia,
  type AccountDeletionMediaOperation,
  type AccountDeletionMediaObjects,
  type AccountDeletionMediaStore,
} from './account-deletion-media.js';

const id = '10000000-0000-4000-8000-000000000001';
const assetId = '20000000-0000-4000-8000-000000000002';
const evidenceId = '30000000-0000-4000-8000-000000000003';
const lease: AccountDeletionLease = {
  deletionRecordId: id,
  userId: id,
  phase: 'media_objects',
  checkpointVersion: 4,
  leaseOwner: id,
  leaseGeneration: 1,
  leaseExpiresAt: new Date('2030-01-01'),
  attemptCount: 1,
};
const bytes = new Uint8Array([1, 2, 3, 4]);
const digest = createHash('sha256').update(bytes).digest('hex');
const publicKey = `variants/test/${assetId}/thumbnail-v1.webp`;
const privateKey = `evidence/test/${evidenceId}/thumbnail-v1.webp`;
const copy: AccountDeletionMediaOperation = {
  id,
  deletionRecordId: id,
  userId: id,
  assetId,
  kind: 'retain_photo',
  evidenceId,
  sourceSha256: digest,
};
const removal: AccountDeletionMediaOperation = {
  id,
  deletionRecordId: id,
  userId: id,
  assetId,
  kind: 'delete_public',
  key: publicKey,
  deliveryPath: `/media/${assetId}/thumbnail-v1.webp`,
};
function scene(operation: AccountDeletionMediaOperation | undefined = copy): {
  store: AccountDeletionMediaStore;
  execute: ExecuteAccountDeletionMedia;
  objects: Map<string, Uint8Array>;
  complete: Mock<AccountDeletionMediaStore['complete']>;
  current: Mock<AccountDeletionMediaStore['assertCurrent']>;
  get: Mock<AccountDeletionMediaObjects['get']>;
  put: Mock<AccountDeletionMediaObjects['putPrivate']>;
  head: Mock<AccountDeletionMediaObjects['head']>;
  remove: Mock<AccountDeletionMediaObjects['delete']>;
  purge: Mock;
} {
  const objects = new Map<string, Uint8Array>([[publicKey, bytes]]);
  const complete = vi.fn<AccountDeletionMediaStore['complete']>().mockResolvedValue(undefined);
  const current = vi.fn<AccountDeletionMediaStore['assertCurrent']>().mockResolvedValue(undefined);
  const store: AccountDeletionMediaStore = {
    claimNext: vi.fn().mockResolvedValue(operation),
    assertCurrent: current,
    complete,
  };
  const get = vi.fn<AccountDeletionMediaObjects['get']>().mockImplementation(async (key) => {
    await Promise.resolve();
    const value = objects.get(key);
    if (value === undefined) throw Error('fixture_missing');
    return (async function* () {
      yield await Promise.resolve(value);
    })();
  });
  const put = vi
    .fn<AccountDeletionMediaObjects['putPrivate']>()
    .mockImplementation(async (key, source) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of source) chunks.push(chunk);
      const value = Buffer.concat(chunks);
      objects.set(key, value);
      return { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') };
    });
  const head = vi.fn<AccountDeletionMediaObjects['head']>().mockImplementation(async (key) => {
    await Promise.resolve();
    const value = objects.get(key);
    return value === undefined
      ? undefined
      : { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') };
  });
  const remove = vi.fn<AccountDeletionMediaObjects['delete']>().mockImplementation(async (key) => {
    await Promise.resolve();
    objects.delete(key);
  });
  const purge = vi.fn().mockResolvedValue(undefined);
  const execute = new ExecuteAccountDeletionMedia(
    store,
    {
      get,
      putPrivate: put,
      head,
      delete: remove,
      list: (prefix, limit) =>
        Promise.resolve(
          [...objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit),
        ),
    },
    { purge },
    'test',
  );
  return { store, execute, objects, complete, current, get, put, head, remove, purge };
}
describe('M8 media provider operations', () => {
  it('drains unrecorded variants before attesting an empty public namespace', async () => {
    const s = scene({ id, deletionRecordId: id, userId: id, assetId, kind: 'verify_public_scope' });
    const orphan = `variants/test/${assetId}/blurred-preview-v2.webp`;
    s.objects.set(orphan, bytes);
    await s.execute.executeNext(lease);
    expect(s.complete).not.toHaveBeenCalled();
    await s.execute.executeNext(lease);
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.objects.size).toBe(0);
    expect(s.purge).toHaveBeenCalledWith([`/media/${assetId}/blurred-preview-v2.webp`]);
    await s.execute.executeNext(lease);
    expect(s.complete).toHaveBeenCalledWith(lease, id, { bytes: null, sha256: null });
  });
  it('copies exact report bytes into private storage, verifies them and preserves the public source until separate deletion', async () => {
    const s = scene();
    expect(await s.execute.executeNext(lease)).toEqual({ worked: true });
    expect(Array.from(s.objects.get(privateKey)!)).toEqual(Array.from(bytes));
    expect(s.objects.get(publicKey)).toEqual(bytes);
    expect(s.complete).toHaveBeenCalledWith(lease, id, { bytes: bytes.length, sha256: digest });
    expect(s.remove).not.toHaveBeenCalled();
  });
  it('replays a previously verified private copy without requiring the removed public source', async () => {
    const s = scene();
    s.objects.set(privateKey, bytes);
    s.objects.delete(publicKey);
    expect(await s.execute.executeNext(lease)).toEqual({ worked: true });
    expect(s.get).not.toHaveBeenCalled();
    expect(s.put).not.toHaveBeenCalled();
  });
  it('denies incorrect or conflicting private bytes without authorizing public deletion', async () => {
    const s = scene();
    s.objects.set(privateKey, new Uint8Array([9]));
    await expect(s.execute.executeNext(lease)).rejects.toMatchObject({ status: 409 });
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.remove).not.toHaveBeenCalled();
  });
  it('verifies source bytes before writing a private evidence destination', async () => {
    const s = scene();
    s.objects.set(publicKey, new Uint8Array([9]));
    await expect(s.execute.executeNext(lease)).rejects.toMatchObject({ status: 409 });
    expect(s.put).not.toHaveBeenCalled();
    expect(s.objects.has(privateKey)).toBe(false);
    expect(s.complete).not.toHaveBeenCalled();
  });
  it('requires actual public absence and CDN acknowledgement before recording completion', async () => {
    const s = scene(removal);
    expect(await s.execute.executeNext(lease)).toEqual({ worked: true });
    expect(s.objects.has(publicKey)).toBe(false);
    expect(s.purge).toHaveBeenCalledWith([removal.deliveryPath]);
    expect(s.complete).toHaveBeenCalledWith(lease, id, { bytes: null, sha256: null });
  });
  it('does not trust a successful delete response if the object is still present', async () => {
    const s = scene(removal);
    s.remove.mockResolvedValue(undefined);
    await expect(s.execute.executeNext(lease)).rejects.toMatchObject({ status: 409 });
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.purge).not.toHaveBeenCalled();
  });
  it('does not complete when cache purge fails or authority expires after provider success', async () => {
    const cache = scene(removal);
    cache.purge.mockRejectedValue(Error('fixture_provider_unavailable'));
    await expect(cache.execute.executeNext(lease)).rejects.toThrow('fixture_provider_unavailable');
    expect(cache.complete).not.toHaveBeenCalled();
    const expiry = scene(removal);
    expiry.current.mockResolvedValueOnce(undefined).mockRejectedValue(Error('fixture_expired'));
    await expect(expiry.execute.executeNext(lease)).rejects.toThrow('fixture_expired');
    expect(expiry.complete).not.toHaveBeenCalled();
  });
  it('rejects borrowed scope, other-asset keys and inconsistent public paths before provider writes', async () => {
    for (const operation of [
      { ...removal, userId: evidenceId },
      { ...removal, key: `variants/test/${evidenceId}/thumbnail-v1.webp` },
      { ...removal, deliveryPath: `/media/${evidenceId}/thumbnail-v1.webp` },
    ]) {
      const s = scene(operation);
      await expect(s.execute.executeNext(lease)).rejects.toMatchObject({ status: 409 });
      expect(s.remove).not.toHaveBeenCalled();
      expect(s.put).not.toHaveBeenCalled();
    }
  });
  it('treats an empty claim as no operation rather than a completion receipt', async () => {
    const s = scene(undefined);
    vi.spyOn(s.store, 'claimNext').mockResolvedValue(undefined);
    expect(await s.execute.executeNext(lease)).toEqual({ worked: false });
    expect(s.complete).not.toHaveBeenCalled();
  });
});
