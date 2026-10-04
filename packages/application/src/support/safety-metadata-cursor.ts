import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OpaqueTokenStore } from '../security/opaque-token.js';
export type SafetyMetadataViewer = Readonly<{ adminUserId: string; actorUserId: string }>;
export type SafetyMetadataPosition = Readonly<{ at: string; id: string }>;
function validPosition(value: unknown): value is SafetyMetadataPosition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 2 &&
    typeof row.at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.at) &&
    Number.isFinite(Date.parse(row.at)) &&
    typeof row.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(row.id)
  );
}
const tokenPattern = /^(v1\.sq\.([A-Za-z0-9_-]{16}))\.([A-Za-z0-9_-]{16})$/u;
function binding(
  viewer: SafetyMetadataViewer,
  queue: 'support' | 'appeals',
  status: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([viewer.adminUserId, viewer.actorUserId, queue, status]))
    .digest('hex');
}
/** Preserves database timestamp precision without exposing queue sort keys in the cursor. */
export class SafetyMetadataCursors {
  private readonly key: Buffer;
  public constructor(
    private readonly tokens: OpaqueTokenStore,
    key: Uint8Array,
    private readonly now: () => number = Date.now,
  ) {
    if (key.byteLength < 32) throw new Error('Safety cursor key is invalid.');
    this.key = Buffer.from(key);
  }
  private signature(unsigned: string): Buffer {
    return createHmac('sha256', this.key)
      .update(`safety-metadata:${unsigned}`)
      .digest()
      .subarray(0, 12);
  }
  public async issue(
    viewer: SafetyMetadataViewer,
    queue: 'support' | 'appeals',
    status: string,
    after: SafetyMetadataPosition,
  ): Promise<string> {
    if (!validPosition(after)) throw new Error('Safety cursor position is invalid.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomBytes(12).toString('base64url'),
        unsigned = `v1.sq.${id}`;
      if (
        await this.tokens.putIfAbsent(
          id,
          JSON.stringify({
            version: 1,
            purpose: 'safety_metadata',
            binding: binding(viewer, queue, status),
            after,
            expiresAt: this.now() + 300000,
          }),
          300,
        )
      )
        return `${unsigned}.${this.signature(unsigned).toString('base64url')}`;
    }
    throw new Error('Safety cursor allocation failed.');
  }
  public async resolve(
    token: string,
    viewer: SafetyMetadataViewer,
    queue: 'support' | 'appeals',
    status: string,
  ): Promise<SafetyMetadataPosition | undefined> {
    const match = tokenPattern.exec(token);
    if (match === null) return undefined;
    const supplied = Buffer.from(match[3]!, 'base64url'),
      expected = this.signature(match[1]!);
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
      row.purpose !== 'safety_metadata' ||
      row.binding !== binding(viewer, queue, status) ||
      typeof row.expiresAt !== 'number' ||
      !Number.isSafeInteger(row.expiresAt) ||
      row.expiresAt <= this.now() ||
      !validPosition(row.after)
    )
      return undefined;
    return row.after;
  }
}
