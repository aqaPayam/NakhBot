import type { UserProductLife } from './user-session.js';

export interface OpaqueTokenStore {
  putIfAbsent(id: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
}
export interface UserOpaqueTokenStores {
  forLife(life: UserProductLife): OpaqueTokenStore;
}

/** Global legacy-cache cutover. Hashes describe only namespace and scan progress;
 * neither cache values nor inferred user ownership may enter the audit. */
export interface LegacyOpaqueRetirementAudit {
  prepare(
    input: Readonly<{ namespaceHash: string; cursorHash: string; limit: number }>,
  ): Promise<string>;
  observe(
    authorizationId: string,
    observation: Readonly<{ removed: number; nextCursorHash: string; hasMore: boolean }>,
  ): Promise<void>;
}
