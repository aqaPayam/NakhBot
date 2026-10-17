import { parseConfig, type AppConfig } from '@nakh/config';
export function referenceFixtureConfig(): AppConfig {
  return parseConfig({
    NAKH_ENV: 'test',
    NAKH_SERVICE_NAME: 'api',
    NAKH_RELEASE: 'a'.repeat(40),
    NAKH_DATABASE_URL:
      'postgresql://user:PRIVATE_DB_PASSWORD@localhost:55437/nakh?password=PRIVATE_QUERY_PASSWORD',
    NAKH_REDIS_URL:
      'redis://user:PRIVATE_REDIS_PASSWORD@localhost:6379/0?secret=PRIVATE_REDIS_QUERY',
    NAKH_TELEGRAM_BOT_TOKEN_REF: 'TEST_BOT',
    NAKH_TELEGRAM_WEBHOOK_SECRET: 'PRIVATE_WEBHOOK_SECRET_0000000000000000',
    NAKH_R2_ENDPOINT: 'https://r2.invalid',
    NAKH_R2_BUCKET: 'test',
    NAKH_R2_ACCESS_KEY_REF: 'TEST_R2_ACCESS',
    NAKH_R2_SECRET_KEY_REF: 'TEST_R2_SECRET',
    NAKH_MEDIA_CDN_HOST: 'media.invalid',
    NAKH_MEDIA_SIGNING_KEY_REF: 'TEST_SIGNING_KEY',
  });
}
