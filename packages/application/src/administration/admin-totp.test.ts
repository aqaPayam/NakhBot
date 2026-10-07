import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adminTotpCode,
  adminTotpStep,
  createAdminTotpEnrollment,
  matchAdminTotpCode,
  verifyProtectedAdminTotp,
} from './admin-totp.js';

const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
describe('authenticator-app MFA primitives', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 SHA1 vector at %i seconds', (seconds, expected) => {
    expect(adminTotpCode(rfcSecret, new Date(seconds * 1000), 8)).toBe(expected);
  });
  it('bounds clock tolerance, preserves leading zeroes and rejects malformed codes', () => {
    const at = new Date(1111111109000);
    expect(adminTotpCode(rfcSecret, at)).toBe('081804');
    const step = adminTotpStep(at);
    for (const delta of [-1, 0, 1]) {
      const code = adminTotpCode(rfcSecret, new Date((step + delta) * 30000));
      expect(matchAdminTotpCode(rfcSecret, code, at)).toBe(step + delta);
    }
    for (const delta of [-2, 2]) {
      const code = adminTotpCode(rfcSecret, new Date((step + delta) * 30000));
      expect(matchAdminTotpCode(rfcSecret, code, at)).toBeUndefined();
    }
    for (const code of ['81804', '081804 ', ' 081804', '０８１８０４', '07081804', '08180a'])
      expect(matchAdminTotpCode(rfcSecret, code, at)).toBeUndefined();
    expect(adminTotpStep(new Date(29999))).toBe(0);
    expect(adminTotpStep(new Date(30000))).toBe(1);
    for (const date of [new Date(NaN), new Date(-1)])
      expect(() => adminTotpCode(rfcSecret, date)).toThrow('Invalid MFA time.');
    expect(() => adminTotpCode(new Uint8Array(19), at)).toThrow('Invalid MFA parameters.');
  });
  it('roundtrips a random enrollment and binds ciphertext to actor, credential and key version', () => {
    const key = randomBytes(32);
    const subject = { actorUserId: randomUUID(), credentialId: randomUUID() };
    const encryption = { keyId: 'mfa-test-key', keyVersion: 1, key };
    const enrollment = createAdminTotpEnrollment(subject, encryption);
    const second = createAdminTotpEnrollment(subject, encryption);
    expect(second.secret.ciphertext).not.toEqual(enrollment.secret.ciphertext);
    expect(second.secret.nonce).not.toEqual(enrollment.secret.nonce);
    const uri = new URL(enrollment.enrollmentUri);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.searchParams.get('issuer')).toBe('NakhBot');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
    const encoded = uri.searchParams.get('secret')!;
    expect(encoded).toMatch(/^[A-Z2-7]{32}$/u);
    const binary = [...encoded]
      .map((character) =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character).toString(2).padStart(5, '0'),
      )
      .join('');
    const seed = Buffer.from(binary.match(/.{8}/gu)!.map((byte) => parseInt(byte, 2)));
    const at = new Date(1234567890000);
    const code = adminTotpCode(seed, at);
    const resolved: Uint8Array[] = [];
    const resolver = {
      resolve: (keyId: string, version: number) => {
        if (keyId !== encryption.keyId || version !== 1) return undefined;
        const copy = Buffer.from(key);
        resolved.push(copy);
        return copy;
      },
    };
    expect(verifyProtectedAdminTotp(subject, enrollment.secret, resolver, code, at)).toBe(
      adminTotpStep(at),
    );
    for (const changed of [
      { ...subject, actorUserId: randomUUID() },
      { ...subject, credentialId: randomUUID() },
    ])
      expect(() =>
        verifyProtectedAdminTotp(changed, enrollment.secret, resolver, code, at),
      ).toThrow('MFA secret is unavailable.');
    const damaged = Buffer.from(enrollment.secret.ciphertext);
    damaged[35] = damaged[35]! ^ 1;
    for (const secret of [
      { ...enrollment.secret, ciphertext: damaged },
      { ...enrollment.secret, nonce: randomBytes(12) },
      { ...enrollment.secret, keyVersion: 2 },
      { ...enrollment.secret, keyId: 'another-key' },
    ])
      expect(() => verifyProtectedAdminTotp(subject, secret, resolver, code, at)).toThrow(
        'MFA secret is unavailable.',
      );
    expect(resolved.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
    expect(key.some((byte) => byte !== 0)).toBe(true);
    seed.fill(0);
  });
});
