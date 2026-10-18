import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConfig, type AppConfig } from '@nakh/config';
import { RuntimeDatabases, runtimeDatabaseUrl } from './runtime-database.js';
import { runtimeRoleScramVerifier } from './runtime-role-provisioning.js';

function config(serviceName = 'api', enabled = true): AppConfig {
  return structuredClone(
    parseConfig({
      NAKH_ENV: 'test',
      NAKH_SERVICE_NAME: serviceName,
      NAKH_REDIS_URL: 'redis://localhost:6379',
      NAKH_TELEGRAM_BOT_TOKEN_REF: 'synthetic',
      NAKH_TELEGRAM_WEBHOOK_SECRET: '1'.repeat(32),
      NAKH_R2_ENDPOINT: 'https://r2.invalid',
      NAKH_R2_BUCKET: 'test',
      NAKH_R2_ACCESS_KEY_REF: 'synthetic',
      NAKH_R2_SECRET_KEY_REF: 'synthetic',
      NAKH_MEDIA_CDN_HOST: 'media.invalid',
      NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
      NAKH_DATABASE_URL: 'postgresql://nakh_user:synthetic@localhost:5432/nakh',
      NAKH_DATABASE_ROLE_ISOLATION_ENABLED: String(enabled),
    }),
  );
}
describe('host-owned database purposes', () => {
  it('preserves the legacy single pool and closes admission on verification', async () => {
    const pools = new RuntimeDatabases(config('api', false));
    try {
      expect(pools.get('user')).toBe(pools.get('administration'));
      await pools.verify();
      expect(pools.get('financial')).toBe(pools.get('user'));
    } finally {
      await pools.destroy();
    }
  });
  it('rejects a production owner fallback and insufficient connection budgets', () => {
    expect(
      () => new RuntimeDatabases({ ...config('api', false), environment: 'production' }),
    ).toThrow('Runtime database role unavailable.');
    const input = config('worker');
    input.database.poolMax = 2;
    expect(() => new RuntimeDatabases(input)).toThrow('Runtime database role unavailable.');
  });
  it('rejects secret purpose, login, database, transport and host substitutions', async () => {
    for (const replacement of [
      'postgresql://nakh_admin:x@localhost:5432/nakh',
      'postgresql://nakh_administration:x@other:5432/nakh',
      'postgresql://nakh_administration:x@localhost:5432/other',
      'postgresql://nakh_administration:x@localhost:5432/nakh?sslmode=disable',
      'postgresql://nakh_administration:x@localhost:5432/nakh?user=nakh_admin',
    ]) {
      const pools = new RuntimeDatabases(config(), () => replacement);
      try {
        expect(() => pools.get('administration')).toThrow('Runtime database role unavailable.');
      } finally {
        await pools.destroy();
      }
    }
  });
  it('captures configuration and secret resolution once and limits host purposes', async () => {
    const input = config();
    let reads = 0;
    const pools = new RuntimeDatabases(input, () => {
      reads++;
      return 'postgresql://nakh_administration:x@localhost:5432/nakh';
    });
    input.database.url = 'postgresql://owner:x@evil:5432/other';
    try {
      const first = pools.get('administration');
      expect(pools.get('administration')).toBe(first);
      expect(reads).toBe(1);
      expect(() => pools.get('financial')).toThrow('Runtime database role unavailable.');
    } finally {
      await pools.destroy();
    }
  });
  it.each([
    '?host=evil',
    '?options=-c%20role%3Downer',
    '?password=override',
    '?sslmode=require&sslmode=disable',
  ])('rejects driver override parameters %s', (suffix) => {
    expect(() => runtimeDatabaseUrl('postgresql://nakh_user:x@localhost/nakh' + suffix)).toThrow(
      'Runtime database role unavailable.',
    );
  });
  it('matches the external RFC 7677 SCRAM-SHA-256 server signature', () => {
    const verifier = runtimeRoleScramVerifier(
      'pencil',
      Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'),
    );
    const serverKey = verifier.split('$')[2]!.split(':')[1]!;
    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const message = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    expect(
      createHmac('sha256', Buffer.from(serverKey, 'base64')).update(message).digest('base64'),
    ).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  });
});
