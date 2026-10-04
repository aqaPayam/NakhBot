import {
  OpenSupportThreadHandler,
  SendSupportMessageHandler,
  SupportOpaqueReferences,
  type OpaqueTokenStore,
} from '@nakh/application';
import {
  PostgresSupportStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type { M7ApiAuthenticator } from './m7-api-boundary.js';
import type { M7SupportApiOptions } from './m7-support-api.js';

export function createM7SupportApiOptions(
  input: Readonly<{
    database: NakhDatabase;
    authenticator: M7ApiAuthenticator;
    tokens: OpaqueTokenStore;
    key: Uint8Array;
  }>,
): M7SupportApiOptions {
  const store = new PostgresSupportStore(input.database),
    refs = new SupportOpaqueReferences(input.tokens, input.key),
    ids = new SystemIdGenerator();
  return Object.freeze({
    authenticator: input.authenticator,
    open: new OpenSupportThreadHandler(store, refs, ids),
    send: new SendSupportMessageHandler(store, refs, ids),
  });
}
