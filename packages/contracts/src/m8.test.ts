import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import * as formatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { AccountContextSchema } from './m1.js';
import {
  AccountDeletionStatusSchema,
  RequestAccountDeletionCommandSchema,
  PrepareAccountDeletionQuerySchema,
} from './m8.js';

const addFormats = formatsModule.default as unknown as (ajv: InstanceType<typeof Ajv>) => void;
const id = '20000000-0000-4000-8000-000000000001';
const at = '2026-10-07T00:00:00Z';
function validator(schema: object): ReturnType<InstanceType<typeof Ajv>['compile']> {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
describe('M8 own-account deletion contracts', () => {
  it('represents absent deleted settings without admitting zero-version live settings or old routes', () => {
    const validate = validator(AccountContextSchema);
    const deleted = {
      userId: id,
      accountState: 'deleted',
      profileCompletion: null,
      visibilityEnabled: false,
      uiLocale: 'en',
      guestPreviewCount: 7,
      guestPreviewLimit: 10,
      entryRoute: 'return_decision',
      accountVersion: 2,
      settingsVersion: 0,
    };
    expect(validate(deleted)).toBe(true);
    for (const patch of [
      { settingsVersion: 1 },
      { visibilityEnabled: true },
      { profileCompletion: 'complete' },
      { entryRoute: 'main' },
      { accountState: 'guest' },
    ])
      expect(validate({ ...deleted, ...patch })).toBe(false);
    expect(
      validate({ ...deleted, accountState: 'guest', settingsVersion: 1, entryRoute: 'guest' }),
    ).toBe(true);
  });
  it('requires user authority, opaque confirmation and an exact account version', () => {
    const validate = validator(RequestAccountDeletionCommandSchema);
    const command = {
      commandId: id,
      commandType: 'account.delete',
      schemaVersion: 1,
      actor: { kind: 'user', userId: id },
      requestId: id,
      idempotencyKey: 'deletion-request',
      occurredAt: at,
      locale: 'en',
      data: { confirmationToken: 'a'.repeat(43), expectedAccountVersion: 1 },
    };
    expect(validate(command)).toBe(true);
    for (const kind of ['admin', 'system'])
      expect(validate({ ...command, actor: { ...command.actor, kind } })).toBe(false);
    for (const data of [
      { confirmed: true },
      { ...command.data, userId: id },
      { ...command.data, confirmationToken: '' },
      { ...command.data, expectedAccountVersion: 0 },
      { ...command.data, retentionDays: 0 },
    ])
      expect(validate({ ...command, data })).toBe(false);
  });
  it('rejects foreign target selectors and private retained content in preparation/status', () => {
    const prepare = validator(PrepareAccountDeletionQuerySchema);
    const query = { actor: { kind: 'user', userId: id }, requestId: id, expectedAccountVersion: 1 };
    expect(prepare(query)).toBe(true);
    expect(prepare({ ...query, targetUserId: id })).toBe(false);
    const status = validator(AccountDeletionStatusSchema);
    const result = {
      phase: 'evidence_capture',
      requestedAt: at,
      completedAt: null,
      returnDecision: 'purge_pending',
    };
    expect(status(result)).toBe(true);
    expect(status({ ...result, returnDecision: 'allowed' })).toBe(false);
    expect(status({ ...result, phase: 'completed' })).toBe(false);
    expect(status({ ...result, completedAt: at })).toBe(false);
    for (const returnDecision of ['allowed', 'reactivation_denied', 'safety_bar'])
      expect(status({ ...result, phase: 'completed', completedAt: at, returnDecision })).toBe(true);
    expect(status({ ...result, phase: 'completed', completedAt: at })).toBe(false);
    for (const extra of [
      { userId: id },
      { reportText: 'private' },
      { objectKey: 'private' },
      { manifest: [{ reason: 'private' }] },
    ])
      expect(status({ ...result, ...extra })).toBe(false);
  });
});
