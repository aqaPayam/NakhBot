import type { OpaqueTokenStore } from '@nakh/application';
import { TelegramAdminSafetyMutationVault } from './admin-safety-mutation-vault.js';
export type { TelegramConfirmedSupportMutation } from './admin-safety-mutation-vault.js';
/** Purpose-specific wrapper preserves support-only runtime validation and callback state. */
export class TelegramAdminSupportMutationVault extends TelegramAdminSafetyMutationVault<'support'> {
  public constructor(
    store: OpaqueTokenStore,
    encryptionKey: Uint8Array,
    referenceKey: Uint8Array,
    now: () => number = Date.now,
  ) {
    super('support', store, encryptionKey, referenceKey, now);
  }
}
