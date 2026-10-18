import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureLaunchCohortCommand } from './launch-cohort-store.js';
const command = {
  requestId: randomUUID(),
  expectedVersion: 0,
  sourceSha: 'a'.repeat(40),
  environment: 'staging',
  telegramBotId: '123456789',
  mode: 'cohort',
  expiresAt: '2030-01-01T00:00:00.000Z',
  reviewDigest: 'b'.repeat(64),
  members: [{ userId: randomUUID(), productEpoch: 0 }],
};
describe('private launch cohort command', () => {
  it('captures before waits and canonicalizes member order without changing life', () => {
    const input = {
      ...command,
      members: [...command.members, { userId: randomUUID(), productEpoch: 2 }],
    };
    const captured = captureLaunchCohortCommand(input);
    input.members[0] = { userId: randomUUID(), productEpoch: 99 };
    expect(captured.members.map((x) => x.productEpoch).sort()).toEqual([0, 2]);
    expect(
      captureLaunchCohortCommand({ ...command, members: [...captured.members].reverse() }).members,
    ).toEqual(captured.members);
  });
  it.each([
    'sourceSha',
    'environment',
    'telegramBotId',
    'requestId',
    'reviewDigest',
    'mode',
    'expectedVersion',
    'expiresAt',
  ] as const)('rejects malformed %s', (key) => {
    expect(() => captureLaunchCohortCommand({ ...command, [key]: 'invalid' })).toThrow(
      'Launch cohort unavailable',
    );
  });
  it('requires a nonempty bounded distinct cohort with exact original lives', () => {
    for (const members of [
      [],
      [command.members[0], command.members[0]],
      Array.from({ length: 101 }, () => ({ userId: randomUUID(), productEpoch: 0 })),
      [{ userId: randomUUID(), productEpoch: -1 }],
      [{ userId: randomUUID(), productEpoch: 0, extra: 'private' }],
    ])
      expect(() => captureLaunchCohortCommand({ ...command, members })).toThrow();
    expect(() => captureLaunchCohortCommand({ ...command, extra: 'private' })).toThrow();
  });
  it('keeps stop independent of cohort or expiry', () => {
    expect(
      captureLaunchCohortCommand({ ...command, mode: 'closed', members: [], expiresAt: null }).mode,
    ).toBe('closed');
    expect(() => captureLaunchCohortCommand({ ...command, mode: 'closed' })).toThrow();
  });
});
