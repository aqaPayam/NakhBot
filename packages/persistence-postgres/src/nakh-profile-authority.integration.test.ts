import type { ViewNakhProfileCommand } from '@nakh/contracts';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ViewNakhProfileHandler,
  AcceptNakhHandler,
  RejectNakhHandler,
  type UserSessionActor,
} from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { SystemIdGenerator } from './foundation-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresDeliveredNakhStore } from './delivered-nakh-store.js';
import { PostgresNakhProfileStore } from './nakh-profile-store.js';
import { PostgresNakhMediaAuthorization } from './nakh-media-authorization.js';
import { createMediaAuthorityFixture } from './testing/media-authority-fixture.js';
import { createReportNakh, createReportUser, createReportPhoto } from './testing/report-fixture.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { lockUserPair } from './pair-lock.js';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ReportTokens,
  AesGcmProfileReportSnapshotProtector,
  AesGcmProfileReportSnapshotReader,
  AesGcmPhotoReportSnapshotProtector,
  AesGcmPhotoReportSnapshotReader,
} from '@nakh/application';
import { createPostgresUserReportServices } from './report-services.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('M9 received Nakh profile authority', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  const ids = new SystemIdGenerator();
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_nakh_profile');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function session(userId: string): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch: 0 },
      randomUUID(),
    );
    if (!grant) throw new Error('Synthetic session unavailable');
    return { kind: 'user', userId, productEpoch: 0, sessionGrantId: grant.id };
  }
  type Fixture = Awaited<ReturnType<typeof createMediaAuthorityFixture>> & {
    receiver: string;
    owner: UserSessionActor;
    nakhId: string;
    store: PostgresDeliveredNakhStore;
    profiles: PostgresNakhProfileStore;
    command: ViewNakhProfileCommand;
  };
  async function fixture(registeredOwner?: string): Promise<Fixture> {
    const source = await createMediaAuthorityFixture(database, 'owner_preview', registeredOwner);
    const receiver = await createReportUser(database, true),
      owner = await session(receiver);
    const now = new Date();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: receiver,
        telegram_user_id: String(700000000000 + Math.floor(Math.random() * 100000000000)),
        username: null,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
    const nakhId = await createReportNakh(database, receiver, source.ownerUserId);
    const store = new PostgresDeliveredNakhStore(database, owner);
    const profiles = new PostgresNakhProfileStore(database, 'test', owner);
    const command = {
      commandType: 'nakh.view-profile' as const,
      schemaVersion: 1 as const,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user' as const, userId: receiver },
      occurredAt: now.toISOString(),
      locale: 'en',
      data: { nakhId, expectedVersion: 1 },
    };
    return { ...source, receiver, owner, nakhId, store, profiles, command };
  }
  async function viewed(): Promise<Fixture> {
    const f = await fixture();
    await new ViewNakhProfileHandler(f.store, ids).execute(f.command);
    return f;
  }
  it('revokes the original Nakh and cached photos on real native owner deletion', async () => {
    let original: Awaited<ReturnType<typeof fixture>> | undefined;
    let detail: Awaited<ReturnType<PostgresNakhProfileStore['detail']>> | undefined;
    await createDeletionFixture(database, async (owner) => {
      original = await fixture(owner);
      await new ViewNakhProfileHandler(original.store, ids).execute(original.command);
      detail = await original.profiles.detail(original.nakhId);
    });
    expect(
      await new PostgresNakhMediaAuthorization(
        database,
        'test',
        original!.owner,
        original!.nakhId,
      ).isCurrent(detail!.photos[0]!.source),
    ).toBe(false);
    await expect(original!.profiles.detail(original!.nakhId)).rejects.toBeDefined();
    await expect(
      original!.store.readDetail(original!.receiver, original!.nakhId),
    ).rejects.toBeDefined();
  });
  it('rechecks the original session after an observed canonical pair-lock wait', async () => {
    const f = await viewed();
    let enter: () => void = () => {},
      release: () => void = () => {};
    const ready = new Promise<void>((r) => {
        enter = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const held = database.transaction().execute(async (tx) => {
      await lockUserPair(tx, f.receiver, f.ownerUserId);
      enter();
      await gate;
    });
    await ready;
    const media = new PostgresNakhMediaAuthorization(database, 'test', f.owner, f.nakhId);
    const pending = media.authorize({
      actor: { kind: 'user', userId: f.receiver },
      photoId: f.photoId,
      purpose: 'profile_detail',
      requestedVariant: 'thumbnail',
    });
    const result = expect(pending).rejects.toBeDefined();
    try {
      let waiting = false;
      for (let n = 0; n < 100 && !waiting; n++) {
        waiting = (
          await sql<{
            waiting: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid() AND query LIKE '%lock_user_pair%') AS waiting`.execute(
            database,
          )
        ).rows[0]!.waiting;
        if (!waiting) await delay(25);
      }
      expect(waiting).toBe(true);
      await new PostgresUserSessionStore(database).revoke(
        f.owner,
        f.owner.sessionGrantId,
        randomUUID(),
      );
    } finally {
      release();
      await held;
    }
    await result;
    expect(
      await database
        .selectFrom('media.delivery_grants')
        .select('id')
        .where('nakh_id', '=', f.nakhId)
        .execute(),
    ).toHaveLength(0);
  });
  it('requires the real view transition, then loads all photos bound to that original source', async () => {
    const f = await fixture();
    await expect(f.profiles.detail(f.nakhId)).rejects.toMatchObject({ status: 403 });
    await new ViewNakhProfileHandler(f.store, ids).execute(f.command);
    const extra = await createReportPhoto(
      database,
      f.ownerUserId,
      false,
      new Uint8Array([4, 5, 6]),
    );
    const detail = await f.profiles.detail(f.nakhId);
    expect(detail.photos.map((p) => p.photoId)).toEqual([f.photoId, extra]);
    expect(detail.bio).toBe('Private report bio');
    expect(await f.profiles.detailIsCurrent(f.nakhId, detail)).toBe(true);
    const receipts = await database
      .selectFrom('media.delivery_grants')
      .select([
        'nakh_id',
        'like_id',
        'candidate_delivery_id',
        'feature_unlock_id',
        'session_grant_id',
      ])
      .where('nakh_id', '=', f.nakhId)
      .execute();
    expect(receipts).toHaveLength(2);
    expect(
      receipts.every(
        (r) =>
          r.nakh_id === f.nakhId &&
          r.session_grant_id === f.owner.sessionGrantId &&
          r.like_id === null &&
          r.candidate_delivery_id === null &&
          r.feature_unlock_id === null,
      ),
    ).toBe(true);
  });
  it('does not borrow another recipient, sender identity, source or photo', async () => {
    const f = await viewed(),
      other = await viewed();
    for (const actor of [other.owner, await session(f.ownerUserId)])
      await expect(
        new PostgresNakhProfileStore(database, 'test', actor).detail(f.nakhId),
      ).rejects.toBeDefined();
    await expect(f.profiles.detail(other.nakhId)).rejects.toBeDefined();
    await expect(
      new PostgresNakhMediaAuthorization(database, 'test', f.owner, f.nakhId).authorize({
        actor: { kind: 'user', userId: f.receiver },
        photoId: other.photoId,
        purpose: 'profile_detail',
        requestedVariant: 'thumbnail',
      }),
    ).rejects.toBeDefined();
  });
  it('allows existing received profiles while either participant hides visibility and receiver needs a profile fix', async () => {
    const f = await viewed();
    await database
      .updateTable('identity.user_settings')
      .set({ visibility_enabled: false })
      .where('user_id', 'in', [f.receiver, f.ownerUserId])
      .execute();
    await database
      .updateTable('profile.profiles')
      .set({ completion_status: 'invalid' })
      .where('user_id', '=', f.receiver)
      .execute();
    expect((await f.profiles.detail(f.nakhId)).photos).toHaveLength(1);
  });
  it('revokes full profiles on source closure while preserving sender and receiver history', async () => {
    const f = await viewed(),
      detail = await f.profiles.detail(f.nakhId);
    await new RejectNakhHandler(f.store, ids).execute({
      ...f.command,
      commandType: 'nakh.reject',
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      data: { nakhId: f.nakhId, expectedVersion: 2 },
    });
    await expect(f.profiles.detail(f.nakhId)).rejects.toBeDefined();
    expect(
      await new PostgresNakhMediaAuthorization(database, 'test', f.owner, f.nakhId).isCurrent(
        detail.photos[0]!.source,
      ),
    ).toBe(false);
    expect((await f.store.readDetail(f.receiver, f.nakhId)).status).toBe('rejected');
    expect(
      (
        await new PostgresDeliveredNakhStore(database, await session(f.ownerUserId)).readDetail(
          f.ownerUserId,
          f.nakhId,
        )
      ).status,
    ).toBe('rejected');
  });
  it('accepts once across twenty concurrent attempts and closes ordinary profile authority', async () => {
    const f = await viewed(),
      detail = await f.profiles.detail(f.nakhId);
    const command = {
      ...f.command,
      commandType: 'nakh.accept' as const,
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      data: { nakhId: f.nakhId, expectedVersion: 2 },
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => new AcceptNakhHandler(f.store, ids).execute(command)),
    );
    expect(new Set(results.map((r) => r.matchId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(
      await new PostgresNakhMediaAuthorization(database, 'test', f.owner, f.nakhId).isCurrent(
        detail.photos[0]!.source,
      ),
    ).toBe(false);
    await expect(f.profiles.detail(f.nakhId)).rejects.toBeDefined();
  });
  it('checks the original session before returning cached view results or history despite a new sign-in', async () => {
    const f = await viewed(),
      detail = await f.profiles.detail(f.nakhId);
    await new PostgresUserSessionStore(database).revoke(
      f.owner,
      f.owner.sessionGrantId,
      randomUUID(),
    );
    const fresh = await session(f.receiver);
    await expect(new ViewNakhProfileHandler(f.store, ids).execute(f.command)).rejects.toBeDefined();
    await expect(f.store.readDetail(f.receiver, f.nakhId)).rejects.toBeDefined();
    await expect(f.store.readPage(f.receiver, 'received', 3)).rejects.toBeDefined();
    expect(
      await new PostgresNakhMediaAuthorization(database, 'test', f.owner, f.nakhId).isCurrent(
        detail.photos[0]!.source,
      ),
    ).toBe(false);
    expect(
      (await new PostgresNakhProfileStore(database, 'test', fresh).detail(f.nakhId)).photos,
    ).toHaveLength(1);
  });
  it('does not admit a target profile that becomes invalid after viewing', async () => {
    const f = await viewed(),
      detail = await f.profiles.detail(f.nakhId);
    await database
      .updateTable('profile.profiles')
      .set({ completion_status: 'invalid' })
      .where('user_id', '=', f.ownerUserId)
      .execute();
    expect(
      await new PostgresNakhMediaAuthorization(database, 'test', f.owner, f.nakhId).isCurrent(
        detail.photos[0]!.source,
      ),
    ).toBe(false);
    await expect(f.profiles.detail(f.nakhId)).rejects.toBeDefined();
  });
  it('rejects a forged native receipt with a borrowed Nakh before it can become a source', async () => {
    const f = await viewed(),
      other = await viewed(),
      detail = await f.profiles.detail(f.nakhId);
    const receipt = await database
      .selectFrom('media.delivery_grants')
      .selectAll()
      .where('id', '=', detail.photos[0]!.source.authorityId)
      .executeTakeFirstOrThrow();
    await expect(
      sql`INSERT INTO media.delivery_grants SELECT (jsonb_populate_record(NULL::media.delivery_grants,${JSON.stringify({ ...receipt, id: randomUUID(), nakh_id: other.nakhId })}::jsonb)).*`.execute(
        database,
      ),
    ).rejects.toBeDefined();
  });
  it.each([false, true])(
    'retains original encrypted safety reporting after rejection without reopening the ordinary profile (photo=%s)',
    async (photo) => {
      const f = await viewed(),
        values = new Map<string, string>(),
        secret = Buffer.alloc(32, 82);
      await new RejectNakhHandler(f.store, ids).execute({
        ...f.command,
        commandType: 'nakh.reject',
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        data: { nakhId: f.nakhId, expectedVersion: 2 },
      });
      await expect(f.profiles.detail(f.nakhId)).rejects.toBeDefined();
      const tokens = ReportTokens.forLife(
        {
          get: (id) => Promise.resolve(values.get(id)),
          putIfAbsent: (id, value) => {
            if (values.has(id)) return Promise.resolve(false);
            values.set(id, value);
            return Promise.resolve(true);
          },
        },
        Buffer.alloc(32, 83),
        f.owner,
      );
      const services = createPostgresUserReportServices(
        database,
        tokens,
        photo
          ? {
              photo: {
                protector: new AesGcmPhotoReportSnapshotProtector('synthetic', 1, secret),
                reader: new AesGcmPhotoReportSnapshotReader({ resolve: () => secret }),
              },
            }
          : {
              profile: {
                protector: new AesGcmProfileReportSnapshotProtector('synthetic', 1, secret),
                reader: new AesGcmProfileReportSnapshotReader({ resolve: () => secret }),
              },
            },
        { actor: f.owner, receivedNakhId: f.nakhId },
      );
      const source = await tokens.issueSource(f.receiver, {
        kind: 'received_nakh',
        referenceId: f.nakhId,
        ...(photo ? { photoId: f.photoId } : {}),
      });
      const prepared = await services.prepare.execute(
        {
          actor: f.owner,
          requestId: randomUUID(),
          sourceActionToken: source.token,
          requestedEvidenceTypes: [photo ? 'photo' : 'profile'],
        },
        f.owner,
        0,
        f.owner.sessionGrantId,
      );
      const id = randomUUID(),
        command = {
          commandType: 'moderation.submit-report' as const,
          schemaVersion: 1 as const,
          commandId: id,
          requestId: id,
          idempotencyKey: id,
          actor: { kind: 'user' as const, userId: f.receiver },
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: { evidenceIntentToken: prepared.evidenceIntentToken, reasonCode: 'harassment' },
        };
      expect(
        (await services.submit.execute(command, f.owner, 0, f.owner.sessionGrantId)).replayed,
      ).toBe(false);
      expect(
        (await services.submit.execute(command, f.owner, 0, f.owner.sessionGrantId)).replayed,
      ).toBe(true);
      expect([...values.values()].join('')).not.toContain('Private report bio');
      expect([...values.values()].join('')).not.toContain('Private Nakh text');
      await new PostgresUserSessionStore(database).revoke(
        f.owner,
        f.owner.sessionGrantId,
        randomUUID(),
      );
      await session(f.receiver);
      await expect(
        services.submit.execute(command, f.owner, 0, f.owner.sessionGrantId),
      ).rejects.toBeDefined();
    },
  );
});
