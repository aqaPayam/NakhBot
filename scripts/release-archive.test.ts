import { describe, expect, it } from 'vitest';
import { archiveFixture, reportZip } from './testing/release-archive-fixture.js';
import {
  retainArchiveFiles,
  loadArchiveFiles,
  sealArchive,
  restoreArchive,
  archivePrefix,
  archiveSha,
  parseArchive,
  archiveMatchesLatest,
  type ArchiveVerification,
} from './release-archive.js';
import type { ReleaseBlobs } from './staging-release-custody.js';
import { releaseZipReports } from './release-archive-zip.js';
function store(): {
  blobs: Map<string, Buffer>;
  port: ReleaseBlobs;
  fail: { key?: string; lostAck?: boolean };
} {
  const blobs = new Map<string, Buffer>(),
    fail: { key?: string; lostAck?: boolean } = {};
  return {
    blobs,
    fail,
    port: {
      read: (key) => Promise.resolve(blobs.get(key)),
      put: async (key, input) => {
        await Promise.resolve();
        const bytes = Buffer.from(input);
        if (key === fail.key) throw new Error('PRIVATE_STORE_FAILURE');
        if (blobs.has(key)) {
          if (!blobs.get(key)!.equals(bytes)) throw new Error('conflict');
          return 'existing';
        }
        blobs.set(key, bytes);
        if (fail.lostAck) {
          fail.lostAck = false;
          throw new Error('PRIVATE_UNCERTAIN_UPLOAD');
        }
        return 'created';
      },
    },
  };
}
describe('signed durable release archive protocol', () => {
  it('retains every original ZIP and image bundle with independent readback and exact replay', async () => {
    const f = archiveFixture(),
      s = store(),
      m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port);
    expect(m.files).toHaveLength(9);
    expect(s.blobs.size).toBe(new Set(m.files.map((f) => f.sha256)).size);
    expect((await loadArchiveFiles(m, archivePrefix(f.context), s.port)).size).toBe(9);
    await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port);
    expect(s.blobs.size).toBe(new Set(m.files.map((f) => f.sha256)).size);
  });
  it('requires independent signature and image verification before publishing a complete seal', async () => {
    const f = archiveFixture(),
      s = store(),
      m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port),
      calls: string[] = [];
    const bytes = Buffer.from(JSON.stringify(m)),
      bundle = Buffer.from('synthetic-signature');
    const verify: ArchiveVerification = {
      manifest: async (b, sig) => {
        await Promise.resolve();
        expect(archiveSha(b)).toBe(archiveSha(bytes));
        expect(sig.equals(bundle)).toBe(true);
        calls.push('signature');
      },
      images: async () => {
        await Promise.resolve();
        calls.push('images');
      },
      latest: () => Promise.resolve(f.ci),
    };
    await sealArchive(f.context, bytes, bundle, s.port, verify);
    expect(calls).toEqual(['signature', 'images']);
    const old = { ...f.context, controllerSha: 'b'.repeat(40), runId: '999' };
    await restoreArchive(
      old,
      archivePrefix(f.context) + 'manifest.json',
      bytes,
      bundle,
      s.port,
      verify,
    );
    expect(s.blobs.has(archivePrefix(f.context) + 'complete.json')).toBe(true);
  });
  it('does not publish or accept a complete archive when signatures or actual image proof fail', async () => {
    for (const kind of ['signature', 'images'] as const) {
      const f = archiveFixture(),
        s = store(),
        m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port);
      const verify: ArchiveVerification = {
        manifest: () =>
          kind === 'signature' ? Promise.reject(new Error('invalid-signature')) : Promise.resolve(),
        images: () =>
          kind === 'images' ? Promise.reject(new Error('wrong-image')) : Promise.resolve(),
        latest: () => Promise.resolve(f.ci),
      };
      await expect(
        sealArchive(
          f.context,
          Buffer.from(JSON.stringify(m)),
          Buffer.from('not-authority'),
          s.port,
          verify,
        ),
      ).rejects.toThrow();
      expect(s.blobs.has(archivePrefix(f.context) + 'complete.json')).toBe(false);
    }
  });
  it('preserves uncertain uploads and can resume exact bytes without overwriting or inventing completion', async () => {
    const f = archiveFixture(),
      s = store();
    s.fail.lostAck = true;
    await expect(retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port)).rejects.toThrow();
    expect(s.blobs.size).toBe(1);
    const m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port),
      verify: ArchiveVerification = {
        manifest: () => Promise.resolve(),
        images: () => Promise.resolve(),
        latest: () => Promise.resolve(f.ci),
      },
      bytes = Buffer.from(JSON.stringify(m)),
      bundle = Buffer.from('fixture');
    s.fail.key = archivePrefix(f.context) + 'manifest-bundle.jsonl';
    await expect(sealArchive(f.context, bytes, bundle, s.port, verify)).rejects.toThrow();
    await expect(
      restoreArchive(
        f.context,
        archivePrefix(f.context) + 'manifest.json',
        bytes,
        bundle,
        s.port,
        verify,
      ),
    ).rejects.toThrow();
    delete s.fail.key;
    await sealArchive(f.context, bytes, bundle, s.port, verify);
    await sealArchive(f.context, bytes, bundle, s.port, verify);
  });
  it('rejects incomplete or corrupted retained bytes despite a forged complete marker', async () => {
    const f = archiveFixture(),
      s = store(),
      m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port),
      bytes = Buffer.from(JSON.stringify(m)),
      prefix = archivePrefix(f.context);
    s.blobs.set(
      prefix + 'complete.json',
      Buffer.from(JSON.stringify({ manifestSha256: archiveSha(bytes) })),
    );
    s.blobs.set(prefix + 'files/' + m.files[0]!.sha256, Buffer.from('wrong'));
    s.blobs.delete(prefix + 'files/' + m.files[0]!.sha256 + '.bin');
    const verify: ArchiveVerification = {
      manifest: () => Promise.resolve(),
      images: () => Promise.resolve(),
      latest: () => Promise.resolve(f.ci),
    };
    await expect(
      restoreArchive(
        f.context,
        prefix + 'manifest.json',
        bytes,
        Buffer.from('fixture'),
        s.port,
        verify,
      ),
    ).rejects.toThrow();
  });
  it('never uses an older green archive after the newest CI attempt changes or becomes red', async () => {
    const f = archiveFixture(),
      s = store(),
      m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port);
    expect(() => archiveMatchesLatest(m, { ...f.ci, attempt: 2 })).toThrow();
    const verify: ArchiveVerification = {
      manifest: () => Promise.resolve(),
      images: () => Promise.resolve(),
      latest: () => Promise.reject(new Error('newest-is-red')),
    };
    await expect(
      sealArchive(
        f.context,
        Buffer.from(JSON.stringify(m)),
        Buffer.from('fixture'),
        s.port,
        verify,
      ),
    ).rejects.toThrow();
    expect(s.blobs.has(archivePrefix(f.context) + 'complete.json')).toBe(false);
  });
  it('separates current controller identity from the selected image and denies foreign archive scope', async () => {
    const f = archiveFixture(),
      s = store(),
      m = await retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port);
    expect(() => parseArchive({ ...m, controllerSha: 'b'.repeat(40) }, f.context)).toThrow();
    expect(() => parseArchive(m, { ...f.context, accountId: '000000000000' })).toThrow();
    await expect(
      retainArchiveFiles(
        { ...f.context, controllerSha: 'b'.repeat(40) },
        f.ci,
        f.images,
        f.files,
        s.port,
      ),
    ).rejects.toThrow();
  });
  it('preserves all source, zero-skip, performance, independent-index and conversion gates', async () => {
    const mutations: Array<(r: Record<string, unknown>) => void> = [
      (r) => {
        (r['postgres-integration-shards.json'] as Record<string, unknown>).skipped = 1;
      },
      (r) => {
        (r['postgres-integration-shards.json'] as Record<string, unknown>).sources = [];
      },
      (r) => {
        (r['m7-query-plans.json'] as Record<string, unknown>).fixtureScale = 100;
      },
      (r) => {
        (r['m7-query-plans.json'] as Record<string, unknown>).maximumExecutionMs = 2000;
      },
      (r) => {
        const plans = (r['m7-query-plans.json'] as { plans: Record<string, unknown> }).plans;
        (plans.terminalIntegritySnapshot as Record<string, unknown>).indexNames = [];
      },
      (r) => {
        (r['m7-load-smoke.json'] as Record<string, unknown>).replayed = 99;
      },
      (r) => {
        (r['m8-telemetry-conversion.json'] as Record<string, unknown>).privateMarkersAbsent = false;
      },
    ];
    for (const mutate of mutations) {
      const f = archiveFixture(mutate),
        s = store();
      await expect(
        retainArchiveFiles(f.context, f.ci, f.images, f.files, s.port),
      ).rejects.toThrow();
      expect(s.blobs.size).toBe(0);
    }
  });
});
describe('bounded ZIP report reader', () => {
  it('handles the streaming data descriptors used by actual Actions artifacts without extracting paths', () => {
    expect(
      releaseZipReports(reportZip({ 'report.json': { ok: true } }), ['report.json']).get(
        'report.json',
      ),
    ).toEqual({ ok: true });
    expect(() => releaseZipReports(reportZip({ '../report.json': {} }), ['report.json'])).toThrow();
  });
  it('denies damaged, duplicate, encrypted, oversized and foreign entries', () => {
    const good = reportZip({ 'report.json': { ok: true } });
    for (const index of [0, 8, good.length - 22]) {
      const bad = Buffer.from(good);
      bad[index] = 255;
      expect(() => releaseZipReports(bad, ['report.json'])).toThrow();
    }
    expect(() => releaseZipReports(good, ['report.json', 'report.json'])).toThrow();
    expect(() => releaseZipReports(good, ['foreign.json'])).toThrow();
    expect(() =>
      releaseZipReports(reportZip({ 'report.json': { body: 'x'.repeat(4194305) } }), [
        'report.json',
      ]),
    ).toThrow();
  });
});
