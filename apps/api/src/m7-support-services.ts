import {
  OpenSupportThreadHandler,
  SendSupportMessageHandler,
  SupportOpaqueReferences,
  type UserOpaqueTokenStores,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
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
    tokens: UserOpaqueTokenStores;
    key: Uint8Array;
  }>,
): M7SupportApiOptions {
  const store = new PostgresSupportStore(input.database),
    ids = new SystemIdGenerator();
  return Object.freeze<M7SupportApiOptions>({
    authenticator: input.authenticator,
    open: {
      execute: (command, epoch, sessionGrantId) => {
        if (epoch === undefined || sessionGrantId === undefined)
          throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
        const life = { userId: command.actor.userId, productEpoch: epoch };
        return new OpenSupportThreadHandler(
          store,
          SupportOpaqueReferences.forLife(input.tokens.forLife(life), input.key, life),
          ids,
        ).execute(command, epoch, sessionGrantId);
      },
    },
    send: {
      execute: (command, epoch, sessionGrantId) => {
        if (epoch === undefined || sessionGrantId === undefined)
          throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
        const life = { userId: command.actor.userId, productEpoch: epoch };
        return new SendSupportMessageHandler(
          store,
          SupportOpaqueReferences.forLife(input.tokens.forLife(life), input.key, life),
          ids,
        ).execute(command, epoch, sessionGrantId);
      },
    },
  });
}
