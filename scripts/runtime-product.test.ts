import { describe, expect, it } from 'vitest';
import { parseConfig, resolveSecretReference } from '@nakh/config';
import manifest from '../deploy/runtime-product.json' with { type: 'json' };
import { productScannerTaskHealthy, verifyProductScannerDefinition } from './runtime-product.js';

const base: NodeJS.ProcessEnv = {
  NAKH_ENV: 'staging',
  NAKH_SERVICE_NAME: 'api',
  NAKH_RELEASE: 'a'.repeat(40),
  NAKH_DATABASE_URL: 'postgresql://synthetic',
  NAKH_REDIS_URL: 'redis://synthetic',
  NAKH_TELEGRAM_BOT_TOKEN_REF: 'NAKH_TELEGRAM_BOT_TOKEN',
  NAKH_TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32),
  NAKH_R2_ENDPOINT: 'https://' + 'a'.repeat(32) + '.r2.cloudflarestorage.com',
  NAKH_R2_BUCKET: 'nakh-synthetic',
  NAKH_R2_ACCESS_KEY_REF: 'NAKH_R2_ACCESS_KEY',
  NAKH_R2_SECRET_KEY_REF: 'NAKH_R2_SECRET_KEY',
  NAKH_R2_CLEANUP_ACCESS_KEY_REF: 'NAKH_R2_CLEANUP_ACCESS_KEY',
  NAKH_R2_CLEANUP_SECRET_KEY_REF: 'NAKH_R2_CLEANUP_SECRET_KEY',
  NAKH_MEDIA_CDN_HOST: 'media.example.com',
  NAKH_MEDIA_SIGNING_KEY_REF: 'NAKH_MEDIA_SIGNING_KEY',
  NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
  NAKH_ADMIN_PUBLIC_ORIGIN: 'https://staging.example.com',
  NAKH_DELETION_CUTOVER_EVIDENCE_HASH: 'b'.repeat(64),
};
function definition(): Record<string, unknown>[] {
  return [
    {
      name: 'worker',
      startTimeout: 120,
      environment: [{ name: 'NAKH_MEDIA_INGESTION_ENABLED', value: 'true' }],
      dependsOn: [
        { containerName: 'otel-collector', condition: 'START' },
        { containerName: 'clamav', condition: 'HEALTHY' },
      ],
    },
    { name: 'otel-collector' },
    {
      name: 'clamav',
      image: manifest.scanner.image,
      user: manifest.scanner.user,
      entryPoint: [...manifest.scanner.entryPoint],
      essential: true,
      readonlyRootFilesystem: false,
      environment: [{ name: 'CLAMAV_NO_MILTERD', value: 'true' }],
      healthCheck: {
        command: [...manifest.scanner.healthCommand],
        interval: 30,
        timeout: 10,
        retries: 10,
        startPeriod: 300,
      },
      linuxParameters: { initProcessEnabled: true, capabilities: { drop: ['ALL'] } },
    },
  ];
}
describe('fixed product deployment composition', () => {
  it('keeps every declared feature off in the existing runtime defaults', () => {
    const config = parseConfig(base);
    expect(config.telegram.signupEnabled).toBe(false);
    expect(config.telegram.chatEnabled).toBe(false);
    expect(config.administration.enabled).toBe(false);
    expect(config.deletion.workerEnabled).toBe(false);
    expect(config.media.ingestionEnabled).toBe(false);
    expect(Object.keys(manifest.secrets).sort()).toEqual([
      'api',
      'scheduler',
      'telegram-gateway',
      'worker',
    ]);
  });
  it.each(['api', 'telegram-gateway', 'worker', 'scheduler'] as const)(
    'validates the fully composed %s profile through the actual configuration parser',
    (service) => {
      const flags = Object.fromEntries(
        Object.keys(manifest.features).map((name) => [name, 'true']),
      );
      const injected = Object.fromEntries(
        manifest.secrets[service].map((name) => [name, 'synthetic-' + name]),
      );
      const env = { ...base, ...flags, ...injected, NAKH_SERVICE_NAME: service };
      const config = parseConfig(env);
      expect(config.telegram.chatEnabled).toBe(true);
      expect(config.telegram.reportsEnabled).toBe(true);
      expect(config.deletion.freshEntryTelegramEnabled).toBe(true);
      expect(config.administration.enabled).toBe(true);
      for (const name of manifest.secrets[service])
        expect(resolveSecretReference(name, env)).toBe('synthetic-' + name);
      if (service === 'api' || service === 'telegram-gateway')
        for (const reference of [
          config.administration.totpKeyRingRef,
          config.administration.reviewNoteKeyRingRef,
          config.administration.actionKeyRef,
          config.deletion.evidenceKeyRingRef,
          config.deletion.confirmationKeyRef,
          config.deletion.controlKeyRef,
        ])
          expect(resolveSecretReference(reference, env)).toBeDefined();
      if (service === 'worker')
        expect(resolveSecretReference(config.media.transportKeyRef, env)).toBeDefined();
      if (service === 'scheduler') {
        expect(resolveSecretReference(config.media.cleanupAccessKeyRef, env)).toBeDefined();
        expect(() => resolveSecretReference(config.administration.totpKeyRingRef, env)).toThrow();
      }
    },
  );
  it('accepts the source-pinned scanner only with its required worker dependency', () => {
    expect(verifyProductScannerDefinition('worker', definition())).toBe(true);
    expect(
      verifyProductScannerDefinition('worker', [
        { name: 'worker', environment: [] },
        { name: 'otel-collector' },
      ]),
    ).toBe(false);
    expect(() =>
      verifyProductScannerDefinition('api', [
        { name: 'api', environment: [] },
        ...definition().slice(1),
      ]),
    ).toThrow();
  });
  it('rejects substituted, privileged, secret-bearing or unhealthchecked scanner definitions', () => {
    for (const changed of [
      { image: 'untrusted:latest' },
      { user: '0' },
      { privileged: true },
      { entryPoint: ['/init'] },
      { secrets: [{ name: 'PRIVATE', valueFrom: 'secret' }] },
      { healthCheck: { command: ['CMD', 'true'] } },
      { environment: [] },
    ]) {
      const rows = definition();
      rows[2] = { ...rows[2], ...changed };
      expect(() => verifyProductScannerDefinition('worker', rows)).toThrow();
    }
    const rows = definition();
    rows[0] = { ...rows[0], dependsOn: [] };
    expect(() => verifyProductScannerDefinition('worker', rows)).toThrow();
  });
  it('requires the actual running scanner digest and healthy state before release acceptance', () => {
    const scanner = {
      name: 'clamav',
      lastStatus: 'RUNNING',
      healthStatus: 'HEALTHY',
      image: manifest.scanner.image,
      imageDigest: manifest.scanner.image.split('@')[1],
    };
    const task = { healthStatus: 'HEALTHY', containers: [scanner] };
    expect(productScannerTaskHealthy(task)).toBe(true);
    for (const changed of [
      { lastStatus: 'STOPPED' },
      { healthStatus: 'UNKNOWN' },
      { imageDigest: 'sha256:' + '0'.repeat(64) },
    ])
      expect(productScannerTaskHealthy({ ...task, containers: [{ ...scanner, ...changed }] })).toBe(
        false,
      );
    expect(productScannerTaskHealthy({ ...task, healthStatus: 'UNKNOWN' })).toBe(false);
    expect(productScannerTaskHealthy({ ...task, containers: [] })).toBe(false);
  });
});
