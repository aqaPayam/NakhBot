import { describe, expect, it } from 'vitest';

import { parseConfig, resolveSecretReference } from './index.js';

const validEnvironment: NodeJS.ProcessEnv = {
  NAKH_ENV: 'test',
  NAKH_SERVICE_NAME: 'test',
  NAKH_DATABASE_URL: 'postgresql://test',
  NAKH_REDIS_URL: 'redis://test',
  NAKH_TELEGRAM_BOT_TOKEN_REF: 'fake',
  NAKH_TELEGRAM_WEBHOOK_SECRET: '12345678901234567890123456789012',
  NAKH_R2_ENDPOINT: 'https://r2.invalid',
  NAKH_R2_BUCKET: 'test',
  NAKH_R2_ACCESS_KEY_REF: 'fake',
  NAKH_R2_SECRET_KEY_REF: 'fake',
  NAKH_MEDIA_CDN_HOST: 'media.invalid',
  NAKH_MEDIA_SIGNING_KEY_REF: 'fake',
};

describe('configuration', () => {
  it('parses, defaults, and freezes configuration', () => {
    const config = parseConfig(validEnvironment);

    expect(config.environment).toBe('test');
    expect(config.http.port).toBe(3000);
    expect(config.media).toMatchObject({
      ingestionEnabled: false,
      cachePurgeEnabled: false,
      transportKeyId: 'active-v1',
      transportKeyRef: 'NAKH_MEDIA_TRANSPORT_KEY',
      clamavHost: 'clamav',
      clamavPort: 3310,
      clamavTimeoutMs: 60_000,
    });
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('requires an exact Cloudflare zone ID only when cache purge is enabled', () => {
    expect(() =>
      parseConfig({
        ...validEnvironment,
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'disabled',
      }),
    ).toThrow('/media/cloudflareZoneId');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
      }).media.cachePurgeEnabled,
    ).toBe(true);
  });

  it('rejects an invalid scanner endpoint before startup', () => {
    expect(() => parseConfig({ ...validEnvironment, NAKH_CLAMAV_PORT: '0' })).toThrow(
      '/media/clamavPort',
    );
  });

  it('fails startup when a secret-shaped required value is absent', () => {
    const environment = { ...validEnvironment };
    delete environment.NAKH_TELEGRAM_WEBHOOK_SECRET;

    expect(() => parseConfig(environment)).toThrow('NAKH_TELEGRAM_WEBHOOK_SECRET');
  });

  it('resolves secret references without accepting literal values', () => {
    expect(resolveSecretReference('NAKH_SECRET', { NAKH_SECRET: 'value' })).toBe('value');
    expect(() => resolveSecretReference('literal-secret', {})).toThrow('Invalid secret reference');
    expect(() => resolveSecretReference('NAKH_MISSING', {})).toThrow(
      'Required secret is unavailable',
    );
  });
});
