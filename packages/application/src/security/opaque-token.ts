import type { UserProductLife } from './user-session.js';

export interface OpaqueTokenStore {
  putIfAbsent(id: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
}
export interface UserOpaqueTokenStores {
  forLife(life: UserProductLife): OpaqueTokenStore;
}
