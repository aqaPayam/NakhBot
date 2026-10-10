import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { BanOpaqueReferences, SupportOpaqueReferences } from '@nakh/application';
import { createRedisConnection, RedisOpaqueTokenStore } from '@nakh/queue-redis';
import {
  TelegramAdminSafetyReadVault,
  TelegramAdminSupportMutationVault,
  TelegramReportSelections,
  type TelegramConfirmedSafetyRead,
  type TelegramConfirmedSupportMutation,
} from '@nakh/telegram';

const url = process.env.NAKH_TEST_REDIS_URL;
describe.skipIf(url === undefined)(
  'M8 actual Redis opaque reference and administrator UI composition',
  () => {
    const prefix = `m8-opaque-runtime-${randomUUID()}`;
    const redis = createRedisConnection(url ?? 'redis://invalid');
    const store = new RedisOpaqueTokenStore(redis, prefix);
    const key = new Uint8Array(32).fill(1),
      referenceKey = new Uint8Array(32).fill(2);
    const actor = { kind: 'admin' as const, userId: randomUUID() };
    const short = 'abcdefghijklmnop',
      reference = 'abcdefghijklmnopqrstuv';
    function physical(logical: string): string {
      return logical.length === 16
        ? `${prefix}:action:${logical}`
        : `${prefix}:action:internal:${createHash('sha256').update(logical).digest('hex')}`;
    }
    async function ownKeys(): Promise<string[]> {
      let cursor = '0';
      const keys: string[] = [];
      do {
        const page = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 100);
        cursor = page[0];
        keys.push(...page[1]);
      } while (cursor !== '0');
      return keys;
    }
    afterAll(async () => {
      try {
        const keys = await ownKeys();
        for (let index = 0; index < keys.length; index += 100)
          await redis.unlink(...keys.slice(index, index + 100));
      } finally {
        redis.disconnect();
      }
    });
    function command(): Extract<TelegramConfirmedSupportMutation, { command: unknown }> {
      return {
        binding: 'a'.repeat(43),
        command: {
          commandId: randomUUID(),
          commandType: 'support.reply-thread',
          schemaVersion: 1,
          actor,
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: {
            adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
            confirmationToken: `v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`,
            expectedTargetVersion: 1,
            reason: 'private review reason',
            text: 'پ'.repeat(2000),
          },
        },
      };
    }
    it('issues twenty-way user-bound support and exact-ban references with their existing one-day TTL', async () => {
      const user = randomUUID(),
        other = randomUUID(),
        thread = randomUUID(),
        ban = randomUUID(),
        operation = randomUUID();
      const support = new SupportOpaqueReferences(store, key),
        appeals = new BanOpaqueReferences(store, key);
      for (const [producer, source] of [
        [support, thread],
        [appeals, ban],
      ] as const) {
        const tokens = await Promise.all(
          Array.from({ length: 20 }, () => producer.issue(user, source, operation)),
        );
        expect(new Set(tokens).size).toBe(1);
        const token = tokens[0]!;
        expect(token).not.toContain(user);
        expect(token).not.toContain(source);
        await expect(producer.resolve(token, user)).resolves.toBe(source);
        await expect(producer.resolve(token, other)).resolves.toBeUndefined();
        await expect(producer.resolve(token.slice(0, -1) + '!', user)).resolves.toBeUndefined();
        const ttl = await redis.ttl(physical(token.split('.')[2]!));
        expect(ttl).toBeGreaterThan(86340);
        expect(ttl).toBeLessThanOrEqual(86400);
      }
    });
    it('stores and withdraws the actual encrypted administrator read without extending its five-minute authority', async () => {
      const selected: Extract<TelegramConfirmedSafetyRead, { kind: 'support' }> = {
        kind: 'support',
        command: {
          commandId: randomUUID(),
          commandType: 'support.reveal-thread',
          schemaVersion: 1,
          actor,
          requestId: randomUUID(),
          idempotencyKey: randomUUID(),
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: {
            adminActionToken: `v1.ad.${'a'.repeat(16)}.${'b'.repeat(16)}`,
            confirmationToken: `v1.cf.${'c'.repeat(16)}.${'d'.repeat(16)}`,
            expectedTargetVersion: 1,
            reason: 'private read reason',
          },
        },
      };
      const vault = new TelegramAdminSafetyReadVault(store, key, referenceKey);
      const refs = await Promise.all(
        Array.from({ length: 20 }, () => vault.issue(actor, selected, 'read-operation')),
      );
      expect(new Set(refs).size).toBe(1);
      const ref = refs[0]!,
        physicalKey = physical(`telegram-admin-safety-read:${ref}`);
      await expect(vault.resolve(actor, ref)).resolves.toEqual(selected);
      await expect(
        vault.resolve({ kind: 'admin', userId: randomUUID() }, ref),
      ).resolves.toBeUndefined();
      const encoded = await redis.get(physicalKey);
      for (const privateValue of [
        actor.userId,
        selected.command.commandId,
        selected.command.data.reason,
        selected.command.data.adminActionToken,
      ])
        expect(encoded).not.toContain(privateValue);
      expect(physicalKey).not.toContain(ref);
      expect(await redis.ttl(physicalKey)).toBeLessThanOrEqual(300);
      await expect(vault.withdraw(actor, ref)).resolves.toBe(true);
      await expect(vault.resolve(actor, ref)).resolves.toBeUndefined();
    });
    it('preserves a valid maximum-length encrypted Unicode reply and one winning concurrent Confirm/Cancel decision', async () => {
      const selected = command(),
        vault = new TelegramAdminSupportMutationVault(store, key, referenceKey);
      const refs = await Promise.all(
        Array.from({ length: 20 }, () => vault.issue(actor, selected, 'reply-operation')),
      );
      expect(new Set(refs).size).toBe(1);
      const ref = refs[0]!,
        logical = `telegram-admin-support-mutation:${ref}`;
      const encoded = await redis.get(physical(logical));
      expect(encoded).not.toBeNull();
      expect(Buffer.byteLength(encoded!)).toBeGreaterThan(4096);
      expect(encoded).not.toContain('پ');
      expect(encoded).not.toContain(actor.userId);
      await expect(vault.resolve(actor, ref)).resolves.toEqual(selected);
      await expect(
        vault.resolve({ kind: 'admin', userId: randomUUID() }, ref),
      ).resolves.toBeUndefined();
      const choices = await Promise.all(
        Array.from({ length: 20 }, async (_, index) => {
          const choice = index % 2 === 0 ? ('confirm' as const) : ('cancel' as const);
          return { choice, won: await vault.decide(actor, ref, choice) };
        }),
      );
      const winners = new Set(choices.filter((item) => item.won).map((item) => item.choice));
      expect(winners.size).toBe(1);
      await expect(vault.pending(actor, ref)).resolves.toBeUndefined();
      expect(await vault.confirmed(actor, ref)).toEqual(
        winners.has('confirm') ? selected : undefined,
      );
      expect(await redis.ttl(physical(logical))).toBeLessThanOrEqual(300);
      await redis.set(physical(logical), '{}', 'EX', 300);
      await expect(vault.resolve(actor, ref)).resolves.toBeUndefined();
    });
    it('keeps the actual report-selection UI receipt user-bound at one day without changing the underlying intent', async () => {
      const selections = new TelegramReportSelections(store, key),
        user = randomUUID();
      const intent = `v1.ri.${'e'.repeat(16)}.${'f'.repeat(16)}`;
      const ref = await selections.put(
        user,
        {
          evidenceIntentToken: intent,
          evidenceTypes: ['profile'],
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
        randomUUID(),
      );
      await expect(selections.get(user, ref)).resolves.toBe(intent);
      await expect(selections.get(randomUUID(), ref)).resolves.toBeUndefined();
      const ttl = await redis.ttl(physical(`telegram-report:${ref}`));
      expect(ttl).toBeGreaterThan(86340);
      expect(ttl).toBeLessThanOrEqual(86400);
    });
    it('accepts every existing server-owned namespace and keeps colliding public/internal references separate', async () => {
      const purposes = [
        'support',
        'appeal-review',
        'appeal-unban',
        'report-assignment',
        'report-decision',
        'report-account',
        'report-photo',
        'report-evidence',
        'report-block',
      ];
      const logicalKeys = [
        `telegram-report:${reference}`,
        `telegram-admin-safety-read:${reference}`,
        `telegram-admin-safety-read-withdrawn:${reference}`,
        `telegram-admin-target-selection:${'a'.repeat(43)}`,
        `telegram-admin-rejection:pending:${'b'.repeat(43)}`,
        `telegram-admin-rejection:delivered:${'b'.repeat(43)}`,
        ...['choice', 'page', 'prompt'].map(
          (purpose) => `telegram-admin-queue:${purpose}:${reference}`,
        ),
        ...[
          'choice',
          'page',
          'prompt',
          'evidence',
          'photo-prompt',
          'evidence-prompt',
          'block-prompt',
        ].map((purpose) => `telegram-admin-report-queue:${purpose}:${reference}`),
        ...purposes.flatMap((purpose) => [
          `telegram-admin-${purpose}-mutation:${reference}`,
          `telegram-admin-${purpose}-mutation-decision:${reference}`,
        ]),
      ];
      for (const logical of logicalKeys) {
        await expect(store.putIfAbsent(logical, 'first', 30)).resolves.toBe(true);
        await expect(store.putIfAbsent(logical, 'second', 300)).resolves.toBe(false);
        await expect(store.get(logical)).resolves.toBe('first');
        expect(await redis.ttl(physical(logical))).toBeLessThanOrEqual(30);
      }
      await expect(store.putIfAbsent(short, 'public', 30)).resolves.toBe(true);
      await expect(store.get(short)).resolves.toBe('public');
      await expect(store.get(`telegram-report:${reference}`)).resolves.toBe('first');
    });
    it('rejects unknown/injected keys, UTF-8 byte overflow and longer administrator grants without writing Redis state', async () => {
      const before = (await ownKeys()).sort();
      for (const logical of [
        'invalid',
        `unknown:${reference}`,
        `telegram-admin-queue:other:${reference}`,
        `telegram-report:${reference}:extra`,
        `telegram-report:${reference}\n`,
        `telegram-report:{${reference}}`,
        `telegram-admin-target-selection:${'a'.repeat(10000)}`,
      ]) {
        await expect(store.putIfAbsent(logical, '{}', 30)).rejects.toThrow(
          'Opaque token state is invalid.',
        );
        await expect(store.get(logical)).resolves.toBeUndefined();
      }
      for (const [logical, value, ttl, message] of [
        [short, 'پ'.repeat(2049), 30, 'state'],
        [short, '{}', 86401, 'lifetime'],
        [`telegram-admin-safety-read:${reference}`, '{}', 301, 'lifetime'],
        [`telegram-admin-support-mutation:${reference}`, 'a'.repeat(32769), 300, 'state'],
        [short, '{}', 29, 'lifetime'],
        [short, '{}', NaN, 'lifetime'],
        [short, '', 30, 'state'],
      ] as const)
        await expect(store.putIfAbsent(logical, value, ttl)).rejects.toThrow(
          `Opaque token ${message} is invalid.`,
        );
      expect((await ownKeys()).sort()).toEqual(before);
    });
    it('fails closed on physical expiry and oversized external cache state without renewing a replay', async () => {
      const user = randomUUID(),
        source = randomUUID(),
        producer = new SupportOpaqueReferences(store, key);
      const token = await producer.issue(user, source, randomUUID()),
        physicalKey = physical(token.split('.')[2]!);
      await redis.pexpire(physicalKey, 30);
      await expect
        .poll(() => producer.resolve(token, user), { timeout: 2000, interval: 20 })
        .toBeUndefined();
      const logical = `telegram-admin-support-mutation:${reference}`;
      await redis.set(physical(logical), 'a'.repeat(32769), 'EX', 300);
      await expect(store.get(logical)).resolves.toBeUndefined();
    });
  },
);
