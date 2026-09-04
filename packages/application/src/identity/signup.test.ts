import { describe, expect, it } from 'vitest';

import type { SaveSignupStepCommand, StartSignupCommand } from '@nakh/contracts';

import {
  GetSignupStateHandler,
  SaveSignupStepHandler,
  StartSignupHandler,
  type SaveSignupStepWrite,
  type SignupStore,
  type StartSignupWrite,
} from './signup.js';

const actor = { kind: 'user' as const, userId: '10000000-0000-4000-8000-000000000001' };

function startCommand(kind: 'user' | 'system' = 'user'): StartSignupCommand {
  return {
    commandId: '20000000-0000-4000-8000-000000000001',
    commandType: 'identity.start-signup',
    schemaVersion: 1,
    actor: { ...actor, kind },
    requestId: '30000000-0000-4000-8000-000000000001',
    idempotencyKey: 'start-signup-command',
    occurredAt: '2026-09-04T00:00:00.000Z',
    locale: 'en',
    data: { expectedAccountVersion: 1 },
  };
}

function saveCommand(): SaveSignupStepCommand {
  return {
    ...startCommand(),
    commandType: 'identity.save-signup-step',
    idempotencyKey: 'save-signup-command',
    data: { expectedDraftVersion: 1, value: { step: 'age_confirmation', accepted: true } },
  };
}

describe('signup handlers', () => {
  it('adds transaction IDs to start and save writes', async () => {
    let started: StartSignupWrite | undefined;
    let saved: SaveSignupStepWrite | undefined;
    const store: SignupStore = {
      startSignup: (write) => {
        started = write;
        return Promise.resolve({
          currentStep: 'age_confirmation',
          draftVersion: 1,
          updatedAt: write.processedAt.toISOString(),
        });
      },
      saveSignupStep: (write) => {
        saved = write;
        return Promise.resolve({
          currentStep: 'name',
          draftVersion: 2,
          updatedAt: write.processedAt.toISOString(),
        });
      },
      getSignupState: () => Promise.resolve(undefined),
    };
    const generated = ['a', 'b', 'c', 'd', 'e'];
    const ids = { uuid: () => generated.shift() ?? 'unexpected' };
    const clock = { now: () => new Date('2026-09-04T00:00:01.000Z') };

    await new StartSignupHandler(store, ids, clock).execute(startCommand());
    await new SaveSignupStepHandler(store, ids, clock).execute(saveCommand());
    expect(started).toMatchObject({ accountHistoryId: 'a', auditId: 'b', eventId: 'c' });
    expect(saved).toMatchObject({ auditId: 'd', eventId: 'e' });
  });

  it('rejects non-user actors before persistence', async () => {
    const store: SignupStore = {
      startSignup: () => Promise.reject(new Error('must not execute')),
      saveSignupStep: () => Promise.reject(new Error('must not execute')),
      getSignupState: () => Promise.resolve(undefined),
    };
    const handler = new StartSignupHandler(
      store,
      { uuid: () => 'unused' },
      { now: () => new Date() },
    );
    await expect(handler.execute(startCommand('system'))).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'error.identity.user_context_invalid',
    });
  });

  it('derives the signup query User only from the authenticated actor', async () => {
    let requestedUserId: string | undefined;
    const store: SignupStore = {
      startSignup: () => Promise.reject(new Error('must not execute')),
      saveSignupStep: () => Promise.reject(new Error('must not execute')),
      getSignupState: (userId) => {
        requestedUserId = userId;
        return Promise.resolve(undefined);
      },
    };
    await new GetSignupStateHandler(store).execute(actor);
    expect(requestedUserId).toBe(actor.userId);
  });
});
