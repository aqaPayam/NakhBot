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
  NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
};

describe('configuration', () => {
  it('keeps administrator media closed until administration and real cache purge are configured', () => {
    expect(parseConfig(validEnvironment).administration.mediaEnabled).toBe(false);
    const media = { ...validEnvironment, NAKH_ADMIN_MEDIA_ENABLED: 'true' };
    expect(() => parseConfig(media)).toThrow('administrator media');
    expect(() => parseConfig({ ...media, NAKH_ADMINISTRATION_ENABLED: 'true' })).toThrow(
      'administrator media',
    );
    const enabled = {
      ...media,
      NAKH_ADMINISTRATION_ENABLED: 'true',
      NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
      NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
      NAKH_ADMIN_EVIDENCE_R2_ACCESS_KEY_REF: 'EVIDENCE_READ_ACCESS',
      NAKH_ADMIN_EVIDENCE_R2_SECRET_KEY_REF: 'EVIDENCE_READ_SECRET',
    };
    expect(parseConfig(enabled).administration).toMatchObject({
      mediaEnabled: true,
      evidenceAccessKeyRef: 'EVIDENCE_READ_ACCESS',
      evidenceSecretKeyRef: 'EVIDENCE_READ_SECRET',
    });
    expect(() =>
      parseConfig({ ...enabled, NAKH_ADMIN_EVIDENCE_R2_SECRET_KEY_REF: 'raw-private-secret' }),
    ).toThrow('Invalid configuration');
  });
  it('keeps administration disabled and requires an exact HTTPS origin when enabled', () => {
    expect(parseConfig(validEnvironment).administration.enabled).toBe(false);
    const enabled = {
      ...validEnvironment,
      NAKH_ADMINISTRATION_ENABLED: 'true',
      NAKH_ADMIN_PUBLIC_ORIGIN: 'https://admin.example.com',
    };
    expect(parseConfig(enabled).administration.publicOrigin).toBe('https://admin.example.com');
    for (const NAKH_ADMIN_PUBLIC_ORIGIN of [
      'http://admin.example.com',
      'https://admin.example.com/',
      'https://admin.example.com/path',
      'https://admin.example.com?secret=private',
      'https://user:private@admin.example.com',
      'javascript:private',
    ])
      expect(() => parseConfig({ ...enabled, NAKH_ADMIN_PUBLIC_ORIGIN })).toThrow(
        'administrator origin',
      );
    expect(
      parseConfig({ ...enabled, NAKH_ADMIN_PUBLIC_ORIGIN: 'http://127.0.0.1:4321' }).administration
        .enabled,
    ).toBe(true);
    expect(() =>
      parseConfig({
        ...enabled,
        NAKH_ENV: 'production',
        NAKH_ADMIN_PUBLIC_ORIGIN: 'http://127.0.0.1:4321',
      }),
    ).toThrow('administrator origin');
    expect(() => parseConfig({ ...enabled, NAKH_ADMINISTRATION_ENABLED: 'yes' })).toThrow();
  });
  it('keeps public reports independent of product admission and selects an explicit snapshot write version', () => {
    expect(parseConfig(validEnvironment).telegram.reportsEnabled).toBe(false);
    const config = parseConfig({
      ...validEnvironment,
      NAKH_TELEGRAM_REPORTS_ENABLED: 'true',
      NAKH_REPORT_SNAPSHOT_KEY_ID: 'report-key',
      NAKH_REPORT_SNAPSHOT_KEY_VERSION: '2',
    });
    expect(config.telegram.reportsEnabled).toBe(true);
    expect(config.telegram.signupEnabled).toBe(false);
    expect(config.telegram.reportSnapshotKeyId).toBe('report-key');
    expect(config.telegram.reportSnapshotKeyVersion).toBe(2);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_REPORT_SNAPSHOT_KEY_VERSION: '0' }),
    ).toThrow();
  });
  it('keeps Stars disabled by default and allows receipts while product menus are stopped', () => {
    expect(parseConfig(validEnvironment).telegram.starsEnabled).toBe(false);
    expect(parseConfig(validEnvironment).telegram.starsRefundsEnabled).toBe(false);
    const refunds = parseConfig({
      ...validEnvironment,
      NAKH_TELEGRAM_STARS_REFUNDS_ENABLED: 'true',
    });
    expect(refunds.telegram.starsRefundsEnabled).toBe(true);
    expect(refunds.telegram.starsEnabled).toBe(false);
    expect(refunds.telegram.signupEnabled).toBe(false);
    const config = parseConfig({ ...validEnvironment, NAKH_TELEGRAM_STARS_ENABLED: 'true' });
    expect(config.telegram.starsEnabled).toBe(true);
    expect(config.telegram.signupEnabled).toBe(false);
    expect(config.telegram.starsKeyRingRef).toBe('NAKH_STARS_KEY_RING');
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_STARS_KEY_RING_REF: 'inline-private-key' }),
    ).toThrow();
  });
  it('keeps Explore separate from Guest Preview and requires the signup process', () => {
    expect(parseConfig(validEnvironment).telegram.exploreEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_EXPLORE_ENABLED: 'true' }),
    ).toThrow('Explore requires');
    const config = parseConfig({
      ...validEnvironment,
      NAKH_TELEGRAM_EXPLORE_ENABLED: 'true',
      NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
      NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
      NAKH_MEDIA_INGESTION_ENABLED: 'true',
    });
    expect(config.telegram.exploreEnabled).toBe(true);
    expect(config.telegram.guestPreviewEnabled).toBe(false);
  });
  it('keeps Guest Preview delivery inactive until the signup path is ready', () => {
    expect(parseConfig(validEnvironment).telegram.guestPreviewEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED: 'true' }),
    ).toThrow('Guest Preview requires');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED: 'true',
        NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_MEDIA_INGESTION_ENABLED: 'true',
      }).telegram.guestPreviewEnabled,
    ).toBe(true);
  });
  it('keeps signup off and requires the existing start and photo paths when activated', () => {
    expect(parseConfig(validEnvironment).telegram.signupEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_SIGNUP_ENABLED: 'true' }),
    ).toThrow('signup Telegram requires');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_MEDIA_INGESTION_ENABLED: 'true',
      }).telegram.signupEnabled,
    ).toBe(true);
  });
  it('requires explicit activation of private start delivery', () => {
    expect(parseConfig(validEnvironment).telegram.startDeliveryEnabled).toBe(false);
    expect(
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true' }).telegram
        .startDeliveryEnabled,
    ).toBe(true);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'yes' }),
    ).toThrow('true or false');
  });
  it('keeps deletion polling disabled until explicitly configured with cache revocation and drain evidence', () => {
    expect(parseConfig(validEnvironment).deletion.workerEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_DELETION_WORKER_ENABLED: 'true' }),
    ).toThrow('deletion worker requires');
    expect(() =>
      parseConfig({
        ...validEnvironment,
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
      }),
    ).toThrow('deletion worker requires');
    const config = parseConfig({
      ...validEnvironment,
      NAKH_DELETION_WORKER_ENABLED: 'true',
      NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
      NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
      NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
    });
    expect(config.deletion).toMatchObject({
      workerEnabled: true,
      evidenceKeyRingRef: 'NAKH_DELETION_EVIDENCE_KEYS',
      accessKeyRef: 'NAKH_DELETION_R2_ACCESS_KEY',
      secretKeyRef: 'NAKH_DELETION_R2_SECRET_KEY',
    });
    expect(Object.isFrozen(config.deletion)).toBe(true);
  });
  it('keeps own deletion HTTP off by default and requires configured worker readiness and valid key references', () => {
    expect(parseConfig(validEnvironment).deletion.apiEnabled).toBe(false);
    expect(() => parseConfig({ ...validEnvironment, NAKH_DELETION_API_ENABLED: 'true' })).toThrow(
      'deletion API requires',
    );
    for (const setting of [
      'NAKH_ACCOUNT_CONTROL_KEY_REF',
      'NAKH_DELETION_CONFIRMATION_KEY_REF',
      'NAKH_DELETION_CONFIRMATION_KEY_ID',
    ])
      expect(() => parseConfig({ ...validEnvironment, [setting]: '../invalid' })).toThrow(
        'Invalid configuration',
      );
  });
  it('keeps Return HTTP disabled unless deletion API and worker readiness are configured', () => {
    expect(parseConfig(validEnvironment).deletion.returnApiEnabled).toBe(false);
    expect(() => parseConfig({ ...validEnvironment, NAKH_RETURN_API_ENABLED: 'true' })).toThrow(
      'Return API requires',
    );
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_RETURN_API_ENABLED: 'true',
        NAKH_DELETION_API_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
      }).deletion.returnApiEnabled,
    ).toBe(true);
  });
  it('keeps fresh entry off until Return Telegram readiness is configured', () => {
    expect(parseConfig(validEnvironment).deletion.freshEntryTelegramEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_FRESH_ENTRY_TELEGRAM_ENABLED: 'true' }),
    ).toThrow('fresh entry Telegram requires');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_FRESH_ENTRY_TELEGRAM_ENABLED: 'true',
        NAKH_RETURN_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
      }).deletion.freshEntryTelegramEnabled,
    ).toBe(true);
  });
  it('keeps Return Telegram off unless its limited deletion ingress and worker readiness are configured', () => {
    expect(parseConfig(validEnvironment).deletion.returnTelegramEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_RETURN_TELEGRAM_ENABLED: 'true' }),
    ).toThrow('Return Telegram requires');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_RETURN_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
      }).deletion.returnTelegramEnabled,
    ).toBe(true);
  });
  it('keeps limited Telegram deletion off unless worker readiness is configured', () => {
    expect(parseConfig(validEnvironment).deletion.telegramEnabled).toBe(false);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_DELETION_TELEGRAM_ENABLED: 'true' }),
    ).toThrow('deletion Telegram requires');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_DELETION_TELEGRAM_ENABLED: 'true',
        NAKH_DELETION_WORKER_ENABLED: 'true',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
      }).deletion.telegramEnabled,
    ).toBe(true);
  });
  it('parses, defaults, and freezes configuration', () => {
    const config = parseConfig(validEnvironment);

    expect(config.environment).toBe('test');
    expect(config.http.port).toBe(3000);
    expect(config.telegram.actionTokenKeyRef).toBe('NAKH_TELEGRAM_ACTION_TOKEN_KEY');
    expect(config.telegram.likedByDeliveryEnabled).toBe(false);
    expect(config.telegram.notificationDeliveryEnabled).toBe(false);
    expect(config.telegram.supportAppealEnabled).toBe(false);
    expect(config.media).toMatchObject({
      ingestionEnabled: false,
      cachePurgeEnabled: false,
      cleanupEnabled: false,
      orphanReconciliationEnabled: false,
      orphanGraceMs: 86_400_000,
      cleanupAccessKeyRef: 'fake',
      cleanupSecretKeyRef: 'fake',
      signingKeyId: 'media-v1',
      audienceKeyId: 'audience-v1',
      audienceKeyRef: 'NAKH_MEDIA_AUDIENCE_KEY',
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

  it('enables Telegram Liked By delivery only through an explicit boolean switch', () => {
    expect(
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_SUPPORT_APPEAL_ENABLED: 'true' }).telegram
        .supportAppealEnabled,
    ).toBe(true);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_SUPPORT_APPEAL_ENABLED: 'yes' }),
    ).toThrow('boolean values');
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'true',
      }).telegram.likedByDeliveryEnabled,
    ).toBe(true);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'yes' }),
    ).toThrow('boolean values');
  });

  it('enables Telegram notification delivery only through an explicit boolean switch', () => {
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED: 'true',
      }).telegram.notificationDeliveryEnabled,
    ).toBe(true);
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED: 'yes' }),
    ).toThrow('boolean values');
  });

  it('rejects an invalid scanner endpoint before startup', () => {
    expect(() => parseConfig({ ...validEnvironment, NAKH_CLAMAV_PORT: '0' })).toThrow(
      '/media/clamavPort',
    );
  });

  it('accepts only a reference, not literal audience key material', () => {
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_MEDIA_AUDIENCE_KEY_ID: 'rotated-v2',
        NAKH_MEDIA_AUDIENCE_KEY_REF: 'NAKH_ROTATED_AUDIENCE_KEY',
      }).media,
    ).toMatchObject({
      audienceKeyId: 'rotated-v2',
      audienceKeyRef: 'NAKH_ROTATED_AUDIENCE_KEY',
    });
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_MEDIA_AUDIENCE_KEY_REF: 'literal-secret' }),
    ).toThrow('/media/audienceKeyRef');
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_MEDIA_AUDIENCE_KEY_ID: '../unsafe' }),
    ).toThrow('/media/audienceKeyId');
  });

  it('validates the media signing key identifier independently of its secret reference', () => {
    expect(
      parseConfig({
        ...validEnvironment,
        NAKH_MEDIA_SIGNING_KEY_ID: 'rotated-v2',
        NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_ROTATED_MEDIA_KEY',
      }).media,
    ).toMatchObject({
      signingKeyId: 'rotated-v2',
      signingKeyRef: 'NAKH_ROTATED_MEDIA_KEY',
    });
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_MEDIA_SIGNING_KEY_ID: '../unsafe' }),
    ).toThrow('/media/signingKeyId');
    expect(() =>
      parseConfig({ ...validEnvironment, NAKH_MEDIA_SIGNING_KEY_REF: 'literal-secret' }),
    ).toThrow('/media/signingKeyRef');
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
