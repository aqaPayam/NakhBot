export interface OpaqueTokenStore {
  putIfAbsent(id: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(id: string): Promise<string | undefined>;
}
