import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SendLikeCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase, type LikeReferenceAnchorTable } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { PostgresInteractionStore } from './interaction-store.js';
import { assertDeletionCatalogCoverage, readDeletionCatalog } from './deletion-registry.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { createReportLike, createReportMatch, createReportUser } from './testing/report-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
function command(sender: string, receiver: string): SendLikeCommand {
  const id = randomUUID();
  return {
    commandId: id,
    commandType: 'interaction.send-like',
    schemaVersion: 1,
    actor: { kind: 'user', userId: sender },
    requestId: randomUUID(),
    idempotencyKey: `m8-like:${id}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { targetUserId: receiver },
  };
}
function generated(): Parameters<PostgresInteractionStore['sendLike']>[1] {
  return {
    likeId: randomUUID(),
    matchId: randomUUID(),
    chatSessionId: randomUUID(),
    auditId: randomUUID(),
    likeEventId: randomUUID(),
    likeClosedEventId: randomUUID(),
    matchEventId: randomUUID(),
    consumptionEventId: randomUUID(),
    occurredAt: new Date(),
  };
}
describe.skipIf(url === undefined)(
  'M8 original Like lives and minimal referenced identities',
  () => {
    let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
    let owner: string, survivor: string, matchId: string, unrelatedLike: string;
    let originalLikes: Record<string, unknown>[], originalMatch: unknown;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_like_reference');
      const directory = await mkdtemp(join(tmpdir(), 'm8-like103-'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 10000,
      });
      try {
        for (const file of await readdir(resolve('migrations')))
          if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 103)
            await copyFile(join(resolve('migrations'), file), join(directory, file));
        await runMigrations(isolated.url, directory);
        survivor = await createReportUser(database);
        const third = await createReportUser(database);
        ({ userId: owner } = await createDeletionFixture(database, async (userId) => {
          matchId = await createReportMatch(database, userId, survivor);
          unrelatedLike = await createReportLike(database, userId, third);
        }));
        originalLikes = await database
          .selectFrom('interaction.likes')
          .selectAll()
          .orderBy('id')
          .execute();
        originalMatch = await database
          .selectFrom('matching.matches')
          .selectAll()
          .where('id', '=', matchId)
          .executeTakeFirstOrThrow();
        const upgraded = await Promise.all(
          Array.from({ length: 20 }, () => runMigrations(isolated.url, resolve('migrations'))),
        );
        expect(upgraded.flatMap((result) => result.applied)).toEqual([
          '000104_m8_like_original_lives.sql',
          '000105_m8_nakh_original_lives.sql',
        ]);
        const verified = await verifyMigrations(isolated.url, resolve('migrations/verify'));
        expect(verified).toContain('000104_m8_like_original_lives.sql');
        expect(verified).toContain('000105_m8_nakh_original_lives.sql');
        expect((await runMigrations(isolated.url, resolve('migrations'))).applied).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    afterAll(async () => {
      await database?.destroy();
      await isolated?.destroy();
    });
    async function user(): Promise<string> {
      const id = await createReportUser(database, true),
        at = new Date();
      await database
        .insertInto('identity.user_settings')
        .values({ user_id: id, created_at: at, updated_at: at })
        .execute();
      return id;
    }
    async function anchor(id: string): Promise<LikeReferenceAnchorTable | undefined> {
      return database
        .selectFrom('interaction.like_reference_anchors')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
    }
    it('preserves every original field and deleted owner through twenty migration retries, retaining only referenced scopes', async () => {
      for (const source of originalLikes) {
        expect(
          await database
            .selectFrom('interaction.likes')
            .selectAll()
            .where('id', '=', source.id as string)
            .executeTakeFirstOrThrow(),
        ).toEqual({ ...source, sender_product_epoch: 0, receiver_product_epoch: 0 });
        if (source.id === unrelatedLike) expect(await anchor(unrelatedLike)).toBeUndefined();
        else
          expect(await anchor(source.id as string)).toEqual({
            id: source.id,
            sender_user_id: source.sender_user_id,
            receiver_user_id: source.receiver_user_id,
            sender_product_epoch: 0,
            receiver_product_epoch: 0,
          });
      }
      expect(
        await database
          .selectFrom('matching.matches')
          .selectAll()
          .where('id', '=', matchId)
          .executeTakeFirstOrThrow(),
      ).toEqual(originalMatch);
      expect(
        (
          await database
            .selectFrom('identity.accounts')
            .select('state')
            .where('user_id', '=', owner)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('deleted');
      assertDeletionCatalogCoverage(await readDeletionCatalog(database));
    });
    it('twenty actual application retries create one unretained Like; the reverse command creates one Match and exactly two original references', async () => {
      const first = await user(),
        second = await user(),
        store = new PostgresInteractionStore(database);
      const request = command(first, second);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.sendLike(request, generated())),
      );
      expect(
        results.every(
          (result) =>
            result.outcome === 'liked' && result.interactionId === results[0]!.interactionId,
        ),
      ).toBe(true);
      expect(results.filter((result) => result.replayed)).toHaveLength(19);
      const id = results[0]!.interactionId;
      expect(await anchor(id)).toBeUndefined();
      const reverse = command(second, first),
        made = generated();
      const matched = await store.sendLike(reverse, made);
      expect(matched.outcome).toBe('matched');
      const replay = await store.sendLike(reverse, generated());
      expect(replay).toMatchObject({
        outcome: 'matched',
        matchId: matched.matchId,
        replayed: true,
      });
      const references = await database
        .selectFrom('interaction.like_reference_anchors')
        .selectAll()
        .where('sender_user_id', 'in', [first, second])
        .orderBy('id')
        .execute();
      expect(references).toEqual(
        [
          {
            id,
            sender_user_id: first,
            receiver_user_id: second,
            sender_product_epoch: 0,
            receiver_product_epoch: 0,
          },
          {
            id: made.likeId,
            sender_user_id: second,
            receiver_user_id: first,
            sender_product_epoch: 0,
            receiver_product_epoch: 0,
          },
        ].sort((left, right) => left.id.localeCompare(right.id)),
      );
      expect(
        await database
          .selectFrom('matching.matches')
          .select('id')
          .where('id', '=', matched.matchId!)
          .execute(),
      ).toHaveLength(1);
    });
    it('rejects orphan, unreferenced, retargeted and changed-life references without changing original safety or product rows', async () => {
      const source = originalLikes.find((row) => row.id !== unrelatedLike)!;
      const before = await anchor(source.id as string);
      await expect(
        database
          .insertInto('interaction.like_reference_anchors')
          .values({
            id: randomUUID(),
            sender_user_id: owner,
            receiver_user_id: survivor,
            sender_product_epoch: 0,
            receiver_product_epoch: 0,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
      const unreferenced = originalLikes.find((row) => row.id === unrelatedLike)!;
      await expect(
        database
          .insertInto('interaction.like_reference_anchors')
          .values({
            id: unrelatedLike,
            sender_user_id: unreferenced.sender_user_id as string,
            receiver_user_id: unreferenced.receiver_user_id as string,
            sender_product_epoch: 0,
            receiver_product_epoch: 0,
          })
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        database
          .updateTable('interaction.like_reference_anchors')
          .set({ sender_product_epoch: 1 })
          .where('id', '=', source.id as string)
          .execute(),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        database
          .deleteFrom('interaction.like_reference_anchors')
          .where('id', '=', source.id as string)
          .execute(),
      ).rejects.toMatchObject({ code: '55000' });
      await expect(
        database
          .updateTable('interaction.likes')
          .set({ sender_product_epoch: 1 })
          .where('id', '=', source.id as string)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
      // The original source FKs still prevent purging referenced product rows.
      await expect(
        database
          .deleteFrom('interaction.likes')
          .where('id', '=', source.id as string)
          .execute(),
      ).rejects.toMatchObject({ code: '23503' });
      expect(await anchor(source.id as string)).toEqual(before);
    });
    it('rejects reusing a retired referenced identity and restores the deliberate missing-source corruption', async () => {
      const first = await user(),
        second = await user();
      const id = await createReportMatch(database, first, second);
      const match = await database
        .selectFrom('matching.matches')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      const source = await database
        .selectFrom('interaction.likes')
        .selectAll()
        .where('id', '=', match.source_like_a_id!)
        .executeTakeFirstOrThrow();
      const reference = await anchor(source.id);
      // Negative missing-source corruption in the owned database only. It is
      // restored byte-for-byte and never counted as successful archival/return.
      async function corrupt(remove: boolean): Promise<void> {
        await database.connection().execute(async (connection) => {
          await sql`SET session_replication_role=replica`.execute(connection);
          try {
            if (remove)
              await connection
                .deleteFrom('interaction.likes')
                .where('id', '=', source.id)
                .execute();
            else await connection.insertInto('interaction.likes').values(source).execute();
          } finally {
            await sql`SET session_replication_role=origin`.execute(connection);
          }
        });
      }
      await corrupt(true);
      try {
        await expect(
          database.insertInto('interaction.likes').values(source).execute(),
        ).rejects.toMatchObject({ code: '23514' });
        expect(await anchor(source.id)).toEqual(reference);
      } finally {
        await corrupt(false);
      }
      expect(
        await database
          .selectFrom('interaction.likes')
          .selectAll()
          .where('id', '=', source.id)
          .executeTakeFirstOrThrow(),
      ).toEqual(source);
      expect(
        await database
          .selectFrom('matching.matches')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      ).toEqual(match);
    });
    it.each(['sender', 'receiver'] as const)(
      'denies a tombstoned %s or forged epoch before creating product or retained rows',
      async (direction) => {
        const peer = await user(),
          id = randomUUID();
        const sender = direction === 'sender' ? owner : peer,
          receiver = direction === 'receiver' ? owner : peer;
        await expect(
          database
            .insertInto('interaction.likes')
            .values({
              id,
              sender_user_id: sender,
              receiver_user_id: receiver,
              status: 'active',
              created_at: new Date(),
              closed_at: null,
            })
            .execute(),
        ).rejects.toMatchObject({ code: '40001' });
        const other = await user();
        await expect(
          database
            .insertInto('interaction.likes')
            .values({
              id,
              sender_user_id: peer,
              receiver_user_id: other,
              sender_product_epoch: direction === 'sender' ? 1 : 0,
              receiver_product_epoch: direction === 'receiver' ? 1 : 0,
              status: 'active',
              created_at: new Date(),
              closed_at: null,
            })
            .execute(),
        ).rejects.toMatchObject({ code: '40001' });
        expect(
          await database
            .selectFrom('interaction.likes')
            .select('id')
            .where('id', '=', id)
            .execute(),
        ).toEqual([]);
        expect(await anchor(id)).toBeUndefined();
      },
    );
    it('missing required reference rolls back the actual reciprocal command, then the same command succeeds once after repair', async () => {
      const first = await user(),
        second = await user(),
        store = new PostgresInteractionStore(database);
      await store.sendLike(command(first, second), generated());
      const request = command(second, first),
        made = generated();
      // Suppress a required write only in this test-owned database, for a negative rollback probe.
      await sql`CREATE FUNCTION public.m8_like_suppress_reference() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER aaaa_m8_like_suppress_reference BEFORE INSERT ON interaction.like_reference_anchors FOR EACH ROW EXECUTE FUNCTION public.m8_like_suppress_reference()`.execute(
        database,
      );
      try {
        await expect(store.sendLike(request, made)).rejects.toMatchObject({ code: '23514' });
        expect(
          await database
            .selectFrom('matching.matches')
            .select('id')
            .where('id', '=', made.matchId)
            .execute(),
        ).toEqual([]);
        expect(
          await database
            .selectFrom('interaction.likes')
            .select('id')
            .where('id', '=', made.likeId)
            .execute(),
        ).toEqual([]);
        expect(
          await database
            .selectFrom('platform.outbox_events')
            .select('id')
            .where('causation_id', '=', request.commandId)
            .execute(),
        ).toEqual([]);
        expect(
          await database
            .selectFrom('platform.idempotency_records')
            .select('id')
            .where('id', '=', request.commandId)
            .execute(),
        ).toEqual([]);
      } finally {
        await sql`DROP TRIGGER aaaa_m8_like_suppress_reference ON interaction.like_reference_anchors`.execute(
          database,
        );
        await sql`DROP FUNCTION public.m8_like_suppress_reference()`.execute(database);
      }
      expect(await store.sendLike(request, made)).toMatchObject({
        outcome: 'matched',
        matchId: made.matchId,
        replayed: false,
      });
      expect(await store.sendLike(request, generated())).toMatchObject({
        outcome: 'matched',
        matchId: made.matchId,
        replayed: true,
      });
      expect(await anchor(made.likeId)).toBeDefined();
    });
    it('waits behind a real committing tombstone and rechecks both source lives before insert', async () => {
      const peer = await user(),
        id = randomUUID();
      await sql`CREATE FUNCTION public.m8_like_pause_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state='deleted' AND OLD.state<>'deleted' THEN PERFORM pg_sleep(1.5); END IF; RETURN NEW; END $$`.execute(
        database,
      );
      await sql`CREATE TRIGGER m8_like_pause_tombstone AFTER UPDATE ON identity.accounts FOR EACH ROW EXECUTE FUNCTION public.m8_like_pause_tombstone()`.execute(
        database,
      );
      let target = '';
      const deletion = createDeletionFixture(database, (userId) => {
        target = userId;
        return Promise.resolve();
      });
      try {
        let sleeping = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          sleeping = (
            await sql<{
              sleeping: boolean;
            }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep') AS sleeping`.execute(
              database,
            )
          ).rows[0]!.sleeping;
          if (sleeping) break;
          await delay(20);
        }
        expect(sleeping).toBe(true);
        const insertion = database
          .insertInto('interaction.likes')
          .values({
            id,
            sender_user_id: peer,
            receiver_user_id: target,
            status: 'active',
            created_at: new Date(),
            closed_at: null,
          })
          .execute();
        const denied = expect(insertion).rejects.toMatchObject({ code: '40001' });
        await deletion;
        await denied;
        expect(
          await database
            .selectFrom('interaction.likes')
            .select('id')
            .where('id', '=', id)
            .execute(),
        ).toEqual([]);
        expect(await anchor(id)).toBeUndefined();
      } finally {
        await deletion;
        await sql`DROP TRIGGER m8_like_pause_tombstone ON identity.accounts`.execute(database);
        await sql`DROP FUNCTION public.m8_like_pause_tombstone()`.execute(database);
      }
    });
  },
);
