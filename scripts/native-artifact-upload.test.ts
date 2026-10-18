import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { requireNativeArtifactUpload } from './native-artifact-upload.js';

describe('mandatory native receipt upload after bounded transport retry', () => {
  it('requires a real successful attempt across all supported outcome combinations', () => {
    for (const primary of ['success', 'failure', 'cancelled', 'skipped'])
      for (const retry of ['success', 'failure', 'cancelled', 'skipped']) {
        const check = (): void => requireNativeArtifactUpload(primary, retry);
        if (primary === 'success' || retry === 'success') expect(check).not.toThrow();
        else expect(check).toThrow('Native source receipt upload incomplete.');
      }
  });
  it('rejects missing or malformed contexts even when the other outcome claims success', () => {
    for (const invalid of [undefined, null, '', true, {}, 'SUCCESS', 'success\nfailure']) {
      expect(() => requireNativeArtifactUpload(invalid, 'success')).toThrow();
      expect(() => requireNativeArtifactUpload('success', invalid)).toThrow();
    }
  });
  it('retries only transport after a passing native shard and keeps both the receipt and coverage gates mandatory', async () => {
    const workflow = (await readFile('.github/workflows/ci.yml', 'utf8')).replaceAll('\r\n', '\n');
    const sections = workflow.split(/(?= {6}- name: )/u);
    const primary = sections.find((section) => section.includes('id: native_receipt_upload\n'))!;
    const retry = sections.find((section) =>
      section.includes('id: native_receipt_upload_retry\n'),
    )!;
    const guard = sections.find((section) =>
      section.includes('name: Require successful source-bound shard coverage upload'),
    )!;
    expect(primary).toContain('continue-on-error: true');
    expect(retry).not.toContain('continue-on-error');
    for (const upload of [primary, retry]) {
      expect(upload).toContain('timeout-minutes: 1');
      expect(upload).toContain('uses: actions/upload-artifact@v6');
      expect(upload).toContain('if-no-files-found: error');
      expect(upload).toContain('retention-days: 14');
    }
    for (const field of ['name', 'path']) {
      const value = (section: string): string | undefined =>
        new RegExp(`          ${field}: (.+)`, 'u').exec(section)?.[1];
      expect(value(primary)).toBeDefined();
      expect(value(retry)).toBe(value(primary));
    }
    expect(retry).toContain("steps.native_shard_run.outcome == 'success'");
    expect(retry).toContain("steps.native_receipt_upload.outcome != 'success'");
    expect(retry).toContain('overwrite: true');
    expect(guard).toContain("steps.native_shard_run.outcome == 'success'");
    expect(guard).toContain(
      'NAKH_PRIMARY_UPLOAD_OUTCOME: ${{ steps.native_receipt_upload.outcome }}',
    );
    expect(guard).toContain(
      'NAKH_RETRY_UPLOAD_OUTCOME: ${{ steps.native_receipt_upload_retry.outcome }}',
    );
    expect(guard).toContain('run: pnpm exec tsx scripts/verify-native-artifact-upload.ts');
    expect(guard).not.toContain('continue-on-error');
    expect(workflow.match(/timeout-minutes: 20/gu)).toHaveLength(3);
    expect(workflow).toContain('run: pnpm test:integration:ci');
    expect(workflow).toContain('--verify artifacts/native-shards');
  });
});
