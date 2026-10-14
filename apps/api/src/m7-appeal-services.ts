import {
  BanOpaqueReferences,
  PrepareAppealHandler,
  SubmitAppealHandler,
  type UserOpaqueTokenStores,
} from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
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
    tokens: UserOpaqueTokenStores;
    key: Uint8Array;
  }>,
): M7AppealApiOptions {
  const store = new PostgresAppealStore(input.database);
  return Object.freeze<M7AppealApiOptions>({
    authenticator: input.authenticator,
    prepare: {
      execute: (userId, commandId, epoch, sessionGrantId) => {
        if (epoch === undefined || sessionGrantId === undefined)
          throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
        const life = { userId, productEpoch: epoch };
        return new PrepareAppealHandler(
          store,
          BanOpaqueReferences.forLife(input.tokens.forLife(life), input.key, life),
        ).execute(userId, commandId, epoch, sessionGrantId);
      },
    },
    submit: {
      execute: (command, epoch, sessionGrantId) => {
        if (epoch === undefined || sessionGrantId === undefined)
          throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
        const life = { userId: command.actor.userId, productEpoch: epoch };
        return new SubmitAppealHandler(
          store,
          BanOpaqueReferences.forLife(input.tokens.forLife(life), input.key, life),
          new SystemIdGenerator(),
        ).execute(command, epoch, sessionGrantId);
      },
    },
  });
}
