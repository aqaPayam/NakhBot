import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ReportStatus } from '@nakh/contracts';
import type { OpaqueTokenStore } from '../security/opaque-token.js';

export type ReportMetadataKeyset = Readonly<{
  priority: 'normal' | 'threshold';
  submittedAt: string;
  reportId: string;
}>;
export type ReportMetadataViewer = Readonly<{ adminUserId: string; actorUserId: string }>;
const TOKEN = /^(v1\.m7\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
function validKeyset(value: unknown): value is ReportMetadataKeyset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 3 &&
    (row.priority === 'normal' || row.priority === 'threshold') &&
    typeof row.submittedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.submittedAt) &&
    Number.isFinite(Date.parse(row.submittedAt)) &&
    typeof row.reportId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(row.reportId)
  );
}
function binding(viewer: ReportMetadataViewer, status: ReportStatus): string {
  return createHash('sha256')
    .update(JSON.stringify([viewer.adminUserId, viewer.actorUserId, status]))
    .digest('hex');
}
/** Server-held cursor state preserves PostgreSQL microseconds without revealing its sort keys. */
export class ReportMetadataCursors {
  private readonly key: Buffer;
  public constructor(
    private readonly tokens: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength < 32) throw new Error('Report cursor key is invalid.');
    this.key = Buffer.from(key);
  }
  private signature(value: string): string {
    return createHmac('sha256', this.key)
      .update(`report-metadata:${value}`)
      .digest()
      .subarray(0, 12)
      .toString('base64url');
  }
  public async issue(
    viewer: ReportMetadataViewer,
    status: ReportStatus,
    after: ReportMetadataKeyset,
  ): Promise<string> {
    if (!validKeyset(after)) throw new Error('Report cursor position is invalid.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomBytes(12).toString('base64url');
      const state = {
        version: 1,
        purpose: 'report_metadata',
        binding: binding(viewer, status),
        after,
        expiresAt: this.now() + 300000,
      };
      if (await this.tokens.putIfAbsent(id, JSON.stringify(state), 300)) {
        const unsigned = `v1.m7.${id}`;
        return `${unsigned}.${this.signature(unsigned)}`;
      }
    }
    throw new Error('Report cursor allocation failed.');
  }
  public async resolve(
    token: string,
    viewer: ReportMetadataViewer,
    status: ReportStatus,
  ): Promise<ReportMetadataKeyset | undefined> {
    const match = TOKEN.exec(token);
    if (match === null) return undefined;
    const supplied = Buffer.from(match[3]!, 'base64url'),
      expected = Buffer.from(this.signature(match[1]!), 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return undefined;
    const raw = await this.tokens.get(match[2]!);
    if (raw === undefined) return undefined;
    let state: unknown;
    try {
      state = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    if (state === null || typeof state !== 'object' || Array.isArray(state)) return undefined;
    const row = state as Record<string, unknown>;
    if (
      Object.keys(row).length !== 5 ||
      row.version !== 1 ||
      row.purpose !== 'report_metadata' ||
      row.binding !== binding(viewer, status) ||
      typeof row.expiresAt !== 'number' ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt <= this.now() ||
      !validKeyset(row.after)
    )
      return undefined;
    return row.after;
  }
}
