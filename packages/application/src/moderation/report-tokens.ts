import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ReportEvidenceType } from '@nakh/contracts';
import type { OpaqueTokenStore } from '../security/opaque-token.js';

export type ReportSource = Readonly<{
  kind: 'received_like' | 'received_nakh' | 'delivered_candidate' | 'match' | 'unmatched';
  referenceId: string;
}>;
export type ReportEvidenceReference = Readonly<{
  evidenceType: ReportEvidenceType;
  referenceId: string;
}>;
export type ReportEvidenceIntent = Readonly<{
  source: ReportSource;
  targetUserId: string;
  evidence: readonly ReportEvidenceReference[];
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN = /^(v1\.(rs|ri)\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function source(value: unknown): value is ReportSource {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    ['received_like', 'received_nakh', 'delivered_candidate', 'match', 'unmatched'].includes(
      String(value.kind),
    ) &&
    uuid(value.referenceId)
  );
}
function intent(value: unknown): value is ReportEvidenceIntent {
  return (
    record(value) &&
    Object.keys(value).length === 3 &&
    source(value.source) &&
    uuid(value.targetUserId) &&
    Array.isArray(value.evidence) &&
    value.evidence.length >= 1 &&
    value.evidence.length <= 5 &&
    value.evidence.every(
      (item: unknown) =>
        record(item) &&
        Object.keys(item).length === 2 &&
        uuid(item.referenceId) &&
        ['profile', 'photo', 'chat', 'message', 'unmatched_user'].includes(
          String(item.evidenceType),
        ),
    ) &&
    new Set(value.evidence.map((item: ReportEvidenceReference) => item.evidenceType)).size ===
      value.evidence.length
  );
}

/** References establish context, never replace commit-time relationship authorization. */
export class ReportTokens {
  private readonly key: Buffer;
  public constructor(
    private readonly store: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength < 32) throw new Error('Report token key is invalid.');
    this.key = Buffer.from(key);
  }
  private signature(unsigned: string): Buffer {
    return createHmac('sha256', this.key)
      .update(`report-context:${unsigned}`)
      .digest()
      .subarray(0, 12);
  }
  private async issue(
    purpose: 'rs' | 'ri',
    actorUserId: string,
    value: ReportSource | ReportEvidenceIntent,
  ): Promise<Readonly<{ token: string; expiresAt: string }>> {
    if (
      !uuid(actorUserId) ||
      !(purpose === 'rs' ? source(value) : intent(value)) ||
      (purpose === 'ri' && (value as ReportEvidenceIntent).targetUserId === actorUserId)
    )
      throw new Error('Report token context is invalid.');
    const expiresAt = this.now() + 300000;
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomBytes(12).toString('base64url');
      if (
        await this.store.putIfAbsent(
          id,
          JSON.stringify({ version: 1, purpose, actorUserId, value, expiresAt }),
          300,
        )
      ) {
        const unsigned = `v1.${purpose}.${id}`;
        return {
          token: `${unsigned}.${this.signature(unsigned).toString('base64url')}`,
          expiresAt: new Date(expiresAt).toISOString(),
        };
      }
    }
    throw new Error('Report token allocation failed.');
  }
  private async resolve(
    token: string,
    purpose: 'rs' | 'ri',
    actorUserId: string,
  ): Promise<unknown> {
    const match = TOKEN.exec(token);
    if (match === null || match[2] !== purpose || !uuid(actorUserId)) return undefined;
    const signature = Buffer.from(match[4]!, 'base64url');
    if (!timingSafeEqual(signature, this.signature(match[1]!))) return undefined;
    const raw = await this.store.get(match[3]!);
    if (raw === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
    if (
      !record(value) ||
      Object.keys(value).length !== 5 ||
      value.version !== 1 ||
      value.purpose !== purpose ||
      value.actorUserId !== actorUserId ||
      typeof value.expiresAt !== 'number' ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= this.now()
    )
      return undefined;
    return value.value;
  }
  public issueSource(
    actorUserId: string,
    value: ReportSource,
  ): Promise<Readonly<{ token: string; expiresAt: string }>> {
    return this.issue('rs', actorUserId, value);
  }
  public issueIntent(
    actorUserId: string,
    value: ReportEvidenceIntent,
  ): Promise<Readonly<{ token: string; expiresAt: string }>> {
    return this.issue('ri', actorUserId, value);
  }
  public async resolveSource(
    token: string,
    actorUserId: string,
  ): Promise<ReportSource | undefined> {
    const value = await this.resolve(token, 'rs', actorUserId);
    return source(value) ? value : undefined;
  }
  public async resolveIntent(
    token: string,
    actorUserId: string,
  ): Promise<ReportEvidenceIntent | undefined> {
    const value = await this.resolve(token, 'ri', actorUserId);
    return intent(value) && value.targetUserId !== actorUserId ? value : undefined;
  }
}
