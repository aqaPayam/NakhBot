import { describe, expect, it } from 'vitest';
import { referenceFixtureConfig } from './testing/release-reference-config.js';
import {
  canonicalReference,
  referenceDigest,
  releaseConfig,
  compareReleaseReference,
  type ReleaseReference,
} from './release-reference.js';

function fixture(): ReleaseReference {
  const config = referenceFixtureConfig();
  return {
    format: 1,
    environment: config.environment,
    service: config.serviceName,
    sourceSha: config.release,
    config: releaseConfig(config),
    pricingRules: { credits: '9007199254740993' },
    native: { catalog: [{ code: 'en', value: 'Hello' }] },
  };
}
describe('M9 exact release reference comparison', () => {
  it('canonicalizes object property order while preserving array order, types and exact integers', () => {
    expect(referenceDigest({ b: [1, '2'], a: true })).toBe(
      referenceDigest({ a: true, b: [1, '2'] }),
    );
    expect(referenceDigest(['1', '2'])).not.toBe(referenceDigest(['2', '1']));
    expect(referenceDigest('9007199254740993')).not.toBe(referenceDigest('9007199254740992'));
    for (const value of [undefined, NaN, Infinity, 1n, new Date()])
      expect(() => canonicalReference(value)).toThrow();
  });
  it('projects every runtime leaf without secret material or connection query credentials', () => {
    const projected = releaseConfig(referenceFixtureConfig()),
      serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('PRIVATE_');
    expect(projected['database.url']).toEqual({
      protocol: 'postgresql:',
      hostname: 'localhost',
      port: '55437',
      pathname: '/nakh',
    });
    expect(projected['telegram.botTokenRef']).toBe('TEST_BOT');
    expect(projected['telegram.guestPreviewEnabled']).toBe(false);
    expect(projected['telegram.exploreEnabled']).toBe(false);
    const config = referenceFixtureConfig();
    expect(
      releaseConfig({ ...config, telegram: { ...config.telegram, exploreEnabled: true } }),
    ).not.toEqual(projected);
    expect(projected).not.toHaveProperty('telegram.webhookSecret');
  });
  it('fails closed on new config leaves, invalid source identities or inline secret references', () => {
    const config = referenceFixtureConfig();
    expect(() =>
      releaseConfig({ ...config, unknown: 'PRIVATE_NEW_SETTING' } as typeof config),
    ).toThrow();
    expect(() => releaseConfig({ ...config, release: 'dev' })).toThrow();
    expect(() =>
      releaseConfig({
        ...config,
        telegram: { ...config.telegram, botTokenRef: '123:PRIVATE_INLINE_TOKEN' },
      }),
    ).toThrow();
  });
  it('does not treat secret rotation as public config drift', () => {
    const a = referenceFixtureConfig(),
      b = {
        ...a,
        telegram: { ...a.telegram, webhookSecret: 'ROTATED_PRIVATE_VALUE' },
        database: {
          ...a.database,
          url: 'postgresql://other:ROTATED@localhost:55437/nakh?different=ROTATED',
        },
      };
    expect(releaseConfig(a)).toEqual(releaseConfig(b));
    expect(releaseConfig({ ...a, redis: { ...a.redis, queuePrefix: 'other' } })).not.toEqual(
      releaseConfig(a),
    );
  });
  it('requires the exact full reference, including environment, service, source, config, prices and native rows', () => {
    const original = fixture();
    expect(compareReleaseReference(original, structuredClone(original)).matches).toBe(true);
    for (const key of Object.keys(original) as Array<keyof ReleaseReference>) {
      const changed = structuredClone(original) as unknown as Record<string, unknown>;
      delete changed[key];
      expect(compareReleaseReference(original, changed).matches).toBe(false);
    }
    expect(compareReleaseReference(original, { ...original, extraApproval: true }).matches).toBe(
      false,
    );
    expect(
      compareReleaseReference(original, { ...original, sourceSha: 'b'.repeat(40) }).matches,
    ).toBe(false);
    expect(
      compareReleaseReference(original, { ...original, pricingRules: { credits: '4' } }).matches,
    ).toBe(false);
  });
});
