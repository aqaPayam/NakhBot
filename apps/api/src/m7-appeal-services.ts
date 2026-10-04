import {
  BanOpaqueReferences,
  PrepareAppealHandler,
  SubmitAppealHandler,
  type OpaqueTokenStore,
} from '@nakh/application';
import {
  PostgresAppealStore,
  SystemIdGenerator,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import type { M7ApiAuthenticator } from './m7-api-boundary.js';
import type { M7AppealApiOptions } from './m7-appeal-api.js';
export function createM7AppealApiOptions(
  input: Readonly<{
    database: NakhDatabase;
    authenticator: M7ApiAuthenticator;
    tokens: OpaqueTokenStore;
    key: Uint8Array;
  }>,
): M7AppealApiOptions {
  const store = new PostgresAppealStore(input.database),
    references = new BanOpaqueReferences(input.tokens, input.key);
  return Object.freeze({
    authenticator: input.authenticator,
    prepare: new PrepareAppealHandler(store, references),
    submit: new SubmitAppealHandler(store, references, new SystemIdGenerator()),
  });
}
