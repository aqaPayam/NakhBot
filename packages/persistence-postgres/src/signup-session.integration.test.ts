import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfirmSignupHandler,
  type SaveSignupStepWrite,
  type StartSignupWrite,
  type UpdateProfileWrite,
  type UserSessionActor,
} from '@nakh/application';
import { SystemClock } from '@nakh/domain';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { SystemIdGenerator } from './foundation-store.js';
import { PostgresIdentityStore } from './identity-store.js';
import { PostgresSignupStore } from './signup-store.js';
import { PostgresProfileStore } from './profile-store.js';
import { PostgresProfileMediaEligibility } from './media-eligibility.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { seedValidMedia } from './media-fixtures.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
function command(userId: string): {
  commandId: string;
  schemaVersion: 1;
  actor: { kind: 'user'; userId: string };
  requestId: string;
  idempotencyKey: string;
  occurredAt: string;
  locale: string;
} {
  const id = randomUUID();
  return {
    commandId: id,
    schemaVersion: 1,
    actor: { kind: 'user', userId },
    requestId: id,
    idempotencyKey: id,
    occurredAt: new Date().toISOString(),
    locale: 'en',
  };
}
function start(userId: string, expectedAccountVersion = 1): StartSignupWrite {
  return {
    command: {
      ...command(userId),
      commandType: 'identity.start-signup',
      data: { expectedAccountVersion },
    },
    accountHistoryId: randomUUID(),
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: new Date(),
  };
}
function save(
  userId: string,
  expectedDraftVersion = 1,
  value: SaveSignupStepWrite['command']['data']['value'] = {
    step: 'age_confirmation',
    accepted: true,
  },
): SaveSignupStepWrite {
  return {
    command: {
      ...command(userId),
      commandType: 'identity.save-signup-step',
      data: { expectedDraftVersion, value },
    },
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: new Date(),
  };
}
function update(userId: string): UpdateProfileWrite {
  return {
    command: {
      ...command(userId),
      commandType: 'profile.update',
      data: { expectedProfileVersion: 1, patch: { highlight: 'Updated synthetic highlight' } },
    },
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: new Date(),
  };
}

describe.skipIf(url === undefined)('M9 native signup and profile session boundaries', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm9_signup_sessions');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  beforeEach(async () => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  async function owner(userId: string, productEpoch = 0): Promise<UserSessionActor> {
    const grant = await new PostgresUserSessionStore(database).issue(
      { userId, productEpoch },
      randomUUID(),
    );
    if (grant === undefined) throw Error('Missing native grant');
    return { kind: 'user', userId, productEpoch, sessionGrantId: grant.id };
  }
  async function register(): Promise<UserSessionActor> {
    const userId = randomUUID(),
      id = randomUUID(),
      at = new Date(),
      sender = String(1_000_000_000_000 + Math.floor(Math.random() * 8_000_000_000_000));
    await new PostgresIdentityStore(database).registerTelegramIdentity({
      command: {
        ...command(userId),
        commandType: 'identity.register-telegram-identity',
        actor: { kind: 'system', userId: '00000000-0000-4000-8000-000000000001' },
        channelContext: { channel: 'telegram', channelIdentityId: sender },
        data: { telegramUserId: sender, updateId: id },
      },
      userId,
      accountHistoryId: randomUUID(),
      auditId: randomUUID(),
      registrationEventId: randomUUID(),
      startRouteEventId: randomUUID(),
      processedAt: at,
      guestPreviewLimit: 10,
      defaultLocale: 'en',
    });
    return owner(userId);
  }
  function stores(actor: UserSessionActor): {
    signup: PostgresSignupStore;
    profile: PostgresProfileStore;
  } {
    return {
      signup: new PostgresSignupStore(database, actor),
      profile: new PostgresProfileStore(database, actor),
    };
  }
  it('serializes owned and trusted retries with one transition and one saved step', async () => {
    const actor = await register(),
      { signup } = stores(actor),
      trusted = new PostgresSignupStore(database),
      begin = start(actor.userId);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? signup : trusted).startSignup(begin)),
    );
    expect(results.every((r) => r.currentStep === 'age_confirmation' && r.draftVersion === 1)).toBe(
      true,
    );
    const step = save(actor.userId);
    const saved = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? signup : trusted).saveSignupStep(step)),
    );
    for (const result of saved)
      expect(result).toMatchObject({ currentStep: 'name', draftVersion: 2 });
    expect(
      await database
        .selectFrom('platform.audit_logs')
        .select('event_type')
        .where('actor_user_id', '=', actor.userId)
        .where('event_type', 'in', ['identity.signup-started.v1', 'identity.signup-step-saved.v1'])
        .execute(),
    ).toHaveLength(2);
  });
  it('denies foreign and wrong-life grants before reads, claims or changes', async () => {
    const actor = await register(),
      other = await register();
    for (const invalid of [
      { ...actor, sessionGrantId: other.sessionGrantId },
      { ...actor, productEpoch: 1 },
      other,
    ]) {
      const { signup, profile } = stores(invalid),
        begin = start(actor.userId);
      await expect(signup.startSignup(begin)).rejects.toMatchObject({ status: 401 });
      await expect(signup.getSignupState(actor.userId)).rejects.toMatchObject({ status: 401 });
      await expect(signup.getCatalogSnapshot(actor.userId)).rejects.toMatchObject({ status: 401 });
      await expect(profile.getOwnProfile(actor.userId)).rejects.toMatchObject({ status: 401 });
      await expect(profile.getConfirmationMedia(actor.userId)).rejects.toMatchObject({
        status: 401,
      });
      expect(
        await database
          .selectFrom('platform.idempotency_records')
          .select('id')
          .where('id', '=', begin.command.commandId)
          .execute(),
      ).toHaveLength(0);
    }
  });
  it('checks native revocation before cached signup replies and all scoped reads', async () => {
    const actor = await register(),
      { signup, profile } = stores(actor),
      begin = start(actor.userId),
      step = save(actor.userId);
    await signup.startSignup(begin);
    await signup.saveSignupStep(step);
    await new PostgresUserSessionStore(database).revoke(actor, actor.sessionGrantId, randomUUID());
    for (const action of [
      () => signup.startSignup(begin),
      () => signup.saveSignupStep(step),
      () => signup.getSignupState(actor.userId),
      () => signup.getCatalogSnapshot(actor.userId),
      () => profile.getOwnProfile(actor.userId),
      () => profile.getConfirmationMedia(actor.userId),
    ])
      await expect(action()).rejects.toMatchObject({ status: 401 });
    expect(
      (await new PostgresSignupStore(database).getSignupState(actor.userId))?.draftVersion,
    ).toBe(2);
  });
  it('captures the supplied actor and write before native waits', async () => {
    const actor = await register(),
      other = await register(),
      mutable = { ...actor },
      signup = new PostgresSignupStore(database, mutable),
      begin = start(actor.userId);
    mutable.userId = other.userId;
    mutable.sessionGrantId = other.sessionGrantId;
    const pending = signup.startSignup(begin);
    begin.command.actor.userId = other.userId;
    expect(await pending).toMatchObject({ currentStep: 'age_confirmation', draftVersion: 1 });
    expect(await new PostgresSignupStore(database).getSignupState(other.userId)).toBeUndefined();
  });
  it('completes real owned signup and profile confirmation once, then refuses revoked profile receipts', async () => {
    const actor = await register(),
      { signup, profile } = stores(actor),
      primary = randomUUID(),
      additional = randomUUID(),
      ids = new SystemIdGenerator();
    await signup.startSignup(start(actor.userId));
    const values: Array<SaveSignupStepWrite['command']['data']['value']> = [
      { step: 'age_confirmation', accepted: true },
      { step: 'name', value: 'Synthetic signup' },
      { step: 'birth_year', value: '1995' },
      { step: 'gender', code: 'man' },
      { step: 'relationship_gender_preference', code: 'women' },
      { step: 'interests', codes: ['music', 'books', 'travel', 'coffee', 'art'] },
      { step: 'location', countryCode: 'iran', provinceCode: 'tehran', cityCode: 'tehran' },
      { step: 'relationship_goal', code: 'marriage' },
      { step: 'primary_photo', mediaAssetId: primary },
      { step: 'additional_photos', mediaAssetIds: [additional] },
      { step: 'highlight', value: 'Synthetic owned signup' },
      { step: 'optional_details', value: {} },
    ];
    for (const [i, value] of values.entries())
      await signup.saveSignupStep(save(actor.userId, i + 1, value));
    await seedValidMedia(database, actor.userId, primary);
    await seedValidMedia(database, actor.userId, additional);
    const confirm = new ConfirmSignupHandler(
      profile,
      new PostgresProfileMediaEligibility(database, ids),
      ids,
      new SystemClock(),
    );
    const input = {
      ...command(actor.userId),
      commandType: 'identity.confirm-signup' as const,
      data: { expectedDraftVersion: 13 },
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => confirm.execute(input)));
    expect(new Set(results.map((r) => r.profile.profileId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const edit = update(actor.userId);
    await profile.updateOwnProfile(edit);
    expect((await profile.getOwnProfile(actor.userId))?.highlight).toBe(
      'Updated synthetic highlight',
    );
    await new PostgresUserSessionStore(database).revoke(actor, actor.sessionGrantId, randomUUID());
    await expect(confirm.execute(input)).rejects.toMatchObject({ status: 401 });
    await expect(profile.updateOwnProfile(edit)).rejects.toMatchObject({ status: 401 });
    await expect(profile.getConfirmationReplay(input)).rejects.toMatchObject({ status: 401 });
    await expect(profile.getOwnProfile(actor.userId)).rejects.toMatchObject({ status: 401 });
  });
  it('rechecks the original grant after a real native lock wait', async () => {
    const actor = await register(),
      { signup } = stores(actor);
    await signup.startSignup(start(actor.userId));
    let unlock = (): void => {},
      locked = (): void => {};
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const blocker = database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', actor.userId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      locked();
      await gate;
      // Insert the same native revocation fact while holding its serialization
      // lock, placing it deterministically before the queued signup transaction.
      // The normal revoke method is exercised independently above.
      const id = randomUUID();
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id,
          category: 'security',
          event_type: 'identity.user-session-revoked.v1',
          actor_type: 'user',
          actor_user_id: actor.userId,
          actor_admin_id: null,
          subject_type: 'user_session',
          subject_id: actor.sessionGrantId,
          result_code: 'revoked',
          metadata_schema_version: 1,
          metadata: {},
          request_id: id,
          command_id: id,
          occurred_at: new Date(),
        })
        .execute();
    });
    await entered;
    const pending = expect(signup.saveSignupStep(save(actor.userId))).rejects.toMatchObject({
      status: 401,
    });
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const row = (
          await sql<{
            n: number;
          }>`SELECT count(*)::integer AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`.execute(
            database,
          )
        ).rows[0]!;
        if (row.n > 0) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
    } finally {
      unlock();
      await blocker;
    }
    await pending;
    expect(
      (await new PostgresSignupStore(database).getSignupState(actor.userId))?.draftVersion,
    ).toBe(1);
  });
  it('rejects old-life reads and commands across actual deletion and approved Return, while fresh signup remains possible', async () => {
    let old: UserSessionActor | undefined,
      begin: StartSignupWrite | undefined,
      step: SaveSignupStepWrite | undefined;
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        old = await owner(userId);
        begin = start(userId);
        step = save(userId);
        const { signup } = stores(old);
        await signup.startSignup(begin);
        await signup.saveSignupStep(step);
      },
    });
    if (old === undefined || begin === undefined || step === undefined)
      throw Error('Missing original commands');
    const id = randomUUID();
    await new PostgresAccountReturnStore(database, f.control).return({
      ...command(f.userId),
      commandId: id,
      commandType: 'account.return',
      data: { expectedAccountVersion: f.version },
    });
    const { signup, profile } = stores(old);
    await expect(signup.startSignup(begin)).rejects.toMatchObject({ status: 401 });
    await expect(signup.saveSignupStep(step)).rejects.toMatchObject({ status: 401 });
    await expect(signup.getSignupState(f.userId)).rejects.toMatchObject({ status: 401 });
    await expect(profile.getOwnProfile(f.userId)).rejects.toMatchObject({ status: 401 });
    // This native grant is a store fixture, not evidence of real primary-entry
    // activation, Redis absence, provider acceptance or operator approval.
    const fresh = stores(await owner(f.userId, 1));
    expect(await fresh.signup.startSignup(start(f.userId, f.version + 1))).toMatchObject({
      currentStep: 'age_confirmation',
      draftVersion: 1,
    });
    expect(
      (
        await sql<{
          valid: boolean;
        }>`SELECT identity.account_return_completed(${f.recordId}::uuid) AS valid`.execute(database)
      ).rows[0]?.valid,
    ).toBe(true);
  });
});
