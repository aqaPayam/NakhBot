import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BanOpaqueReferences, SupportOpaqueReferences } from '@nakh/application';
import type { AppConfig } from '@nakh/config';
import { createDatabase, type NakhDatabase } from '@nakh/persistence-postgres';
import {
  createRedisConnection,
  RedisOwnedOpaqueTokenStore,
  RedisRateLimiter,
} from '@nakh/queue-redis';
import { TelegramBotApiMenuClient } from '@nakh/telegram';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import { createDeletionFixture } from '../../../packages/persistence-postgres/src/testing/deletion-fixture.js';
import {
  runMigrations,
  verifyMigrations,
} from '../../../packages/persistence-postgres/src/migrations.js';
import { createTelegramSupportAppealIngress } from './support-appeal-ingress.js';

const url = process.env.NAKH_TEST_REDIS_URL,
  databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined || databaseUrl === undefined)(
  'M8 actual support/appeal lifetime composition',
  () => {
    const redis = createRedisConnection(url ?? 'redis://invalid');
    const prefix = `m8-contact-${randomUUID()}`,
      key = Buffer.alloc(32, 23);
    afterAll(async () => {
      await redis.quit();
    });
    function subject(
      userId: string,
      productEpoch: number,
    ): Readonly<{
      life: Readonly<{ userId: string; productEpoch: number }>;
      scope: string;
      store: RedisOwnedOpaqueTokenStore;
      values: string;
    }> {
      const life = { userId, productEpoch };
      const scope = `${prefix}:owned-action:{${createHash('sha256').update(userId).digest('hex')}}`;
      return {
        life,
        scope,
        store: new RedisOwnedOpaqueTokenStore(redis, prefix, life),
        values: `${scope}:${productEpoch}:value:`,
      };
    }
    async function drain(store: RedisOwnedOpaqueTokenStore): Promise<void> {
      let cursor = '0';
      for (let batch = 0; batch < 2000; batch++) {
        const result = await store.revokeNext(100, cursor);
        expect(result.removed).toBeLessThanOrEqual(100);
        if (!result.hasMore) return;
        cursor = result.nextCursor;
      }
      throw new Error('Safety reference sweep did not complete.');
    }
    it.each(['support', 'ban'] as const)(
      'binds %s references to real Redis life and rejects delayed old issuers',
      async (kind) => {
        const userId = randomUUID(),
          originalId = randomUUID(),
          commandId = randomUUID();
        const old = subject(userId, 0),
          next = subject(userId, 1);
        const references = kind === 'support' ? SupportOpaqueReferences : BanOpaqueReferences;
        const oldReferences = references.forLife(old.store, key, old.life);
        const token = await oldReferences.issue(userId, originalId, commandId);
        expect(await oldReferences.resolve(token, userId)).toBe(originalId);
        const id = token.split('.')[2]!,
          body = await old.store.get(id);
        expect(body).toBeDefined();
        await drain(old.store);
        // Privileged Redis corruption fixture only, never approved native Return evidence.
        await redis.set(`${old.scope}:life`, 'active:1');
        expect(await next.store.putIfAbsent(id, body!, 86400)).toBe(true);
        const current = references.forLife(next.store, key, next.life);
        expect(await current.resolve(token, userId)).toBeUndefined();
        const currentToken = await current.issue(userId, originalId, commandId);
        const outcomes = await Promise.allSettled(
          Array.from({ length: 20 }, () => oldReferences.issue(userId, originalId, commandId)),
        );
        expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
        expect(await redis.keys(`${old.values}*`)).toEqual([]);
        expect(await current.resolve(currentToken, userId)).toBe(originalId);
        await drain(next.store);
      },
    );
    it('fences actual ingress after a limiter wait and native tombstone without provider delivery', async () => {
      const isolated = await createIsolatedTestDatabase(databaseUrl!, 'm8_contact_runtime');
      let database: NakhDatabase | undefined;
      let outcome: Promise<unknown> | undefined;
      let release!: () => void, observed!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const send = vi
        .spyOn(TelegramBotApiMenuClient.prototype, 'sendMenu')
        .mockResolvedValue(undefined);
      vi.spyOn(RedisRateLimiter.prototype, 'consume').mockImplementationOnce(async () => {
        observed();
        await waiting;
        return { allowed: true, remaining: 9, retryAfterSeconds: 0 };
      });
      try {
        await runMigrations(isolated.url, resolve('migrations'));
        await verifyMigrations(isolated.url, resolve('migrations/verify'));
        database = createDatabase({
          url: isolated.url,
          poolMax: 8,
          statementTimeoutMs: 20000,
          lockTimeoutMs: 15000,
        });
        const ingress = createTelegramSupportAppealIngress({
          database,
          redis,
          config: {
            telegram: { supportAppealEnabled: true, botTokenRef: 'bot', actionTokenKeyRef: 'key' },
            redis: { queuePrefix: prefix },
          } as AppConfig,
          resolveSecret: (reference) =>
            reference === 'bot' ? `12345:${'a'.repeat(24)}` : key.toString('base64url'),
        });
        const { userId } = await createDeletionFixture(database, async (subjectId) => {
          const identity = await database!
            .selectFrom('identity.telegram_identities')
            .select('telegram_user_id')
            .where('user_id', '=', subjectId)
            .executeTakeFirstOrThrow();
          const sender = Number(identity.telegram_user_id);
          outcome = ingress
            .handle({
              update_id: 91,
              message: {
                from: { id: sender, is_bot: false },
                chat: { id: sender, type: 'private' },
                text: '/support Synthetic delayed contact',
              },
            })
            .then(
              (value) => value,
              (error) => error as unknown,
            );
          await Promise.race([
            started,
            outcome.then(() => {
              throw new Error('Ingress finished before the native-life barrier.');
            }),
          ]);
        });
        release();
        expect(await outcome).toMatchObject({ code: 'unauthorized' });
        expect(send).not.toHaveBeenCalled();
        expect(
          await database
            .selectFrom('support.support_threads')
            .select('id')
            .where('user_id', '=', userId)
            .execute(),
        ).toEqual([]);
        expect(await redis.keys(`${subject(userId, 0).values}*`)).toEqual([]);
      } finally {
        release();
        await outcome;
        vi.restoreAllMocks();
        await database?.destroy();
        await isolated.destroy();
      }
    });
  },
);
