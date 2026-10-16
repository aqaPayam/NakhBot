import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  RequestProtectedProfileChangeWrite,
  ResolveProtectedProfileChangeWrite,
} from '@nakh/application';
import type { NakhDatabase } from '../database.js';
import { PostgresProfileChangeStore } from '../profile-change-store.js';
import { PostgresUserSessionStore } from '../user-session-store.js';
import { createReportFixtureAdmin, createReportUser } from './report-fixture.js';

/** Trusted native grant fixture, never proof of deployed primary ingress. */
export async function protectedChangeOwnerStore(
  database: NakhDatabase,
  userId: string,
  productEpoch: number,
): Promise<PostgresProfileChangeStore> {
  const grant = await new PostgresUserSessionStore(database).issue(
    { userId, productEpoch },
    randomUUID(),
  );
  if (grant === undefined) throw new Error('Native protected change owner grant unavailable');
  return new PostgresProfileChangeStore(database, {
    kind: 'user',
    userId,
    productEpoch,
    sessionGrantId: grant.id,
  });
}

/** Privileged Profile/activity fixture. It does not exercise signup, Photo
 * moderation, deployed first-factor/MFA or provider acceptance. */
export async function createProtectedChangeProfile(
  database: NakhDatabase,
  registeredUser?: string,
): Promise<{ userId: string; profileId: string }> {
  const userId = registeredUser ?? (await createReportUser(database));
  const at = new Date(),
    profileId = randomUUID();
  await database
    .updateTable('identity.accounts')
    .set({ state: 'active', version: sql`version+1` })
    .where('user_id', '=', userId)
    .where('state', '!=', 'active')
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values({
      user_id: userId,
      visibility_enabled: true,
      ui_locale_code: 'en',
      version: 1,
      created_at: at,
      updated_at: at,
    })
    .onConflict((conflict) => conflict.column('user_id').doNothing())
    .execute();
  await database
    .insertInto('profile.profiles')
    .values({
      id: profileId,
      user_id: userId,
      name: 'Synthetic lifecycle subject',
      birth_year: 1995,
      gender_option_id: '20000000-0000-4000-8000-000000000001',
      gender_preference_id: '20000000-0000-4000-8000-000000000013',
      relationship_goal_id: '20000000-0000-4000-8000-000000000021',
      country_id: '20000000-0000-4000-8000-000000000101',
      province_id: '20000000-0000-4000-8000-000000000111',
      city_id: '20000000-0000-4000-8000-000000000121',
      highlight: 'Synthetic lifecycle fixture',
      bio: null,
      completion_status: 'complete',
      ever_completed: true,
      completed_at: at,
      version: 1,
      created_at: at,
      updated_at: at,
    })
    .execute();
  return { userId, profileId };
}
export function protectedChangeWrite(
  userId: string,
  requestedValue = 1994,
): RequestProtectedProfileChangeWrite {
  const id = randomUUID(),
    at = new Date();
  return {
    command: {
      commandId: id,
      commandType: 'profile.request-protected-change',
      schemaVersion: 1,
      actor: { kind: 'user', userId },
      requestId: randomUUID(),
      idempotencyKey: id,
      occurredAt: at.toISOString(),
      locale: 'en',
      data: {
        field: 'birth_year',
        requestedValue,
        reason: 'Private synthetic lifecycle correction',
        expectedProfileVersion: 1,
      },
    },
    normalized: {
      field: 'birth_year',
      requestedValue,
      reason: 'Private synthetic lifecycle correction',
    },
    profileChangeRequestId: randomUUID(),
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: at,
  };
}
export function protectedGenderChangeWrite(userId: string): RequestProtectedProfileChangeWrite {
  const base = protectedChangeWrite(userId);
  return {
    ...base,
    command: {
      ...base.command,
      data: { ...base.command.data, field: 'gender', requestedValue: 'woman' },
    },
    normalized: { field: 'gender', requestedValue: 'woman', reason: base.normalized.reason },
  };
}
/** Existing M1 authorization fixture; never evidence of deployed operator MFA. */
export async function protectedReviewWrite(
  database: NakhDatabase,
  requestId: string,
): Promise<ResolveProtectedProfileChangeWrite> {
  const adminUserId = await createReportFixtureAdmin(database);
  const admin = await database
    .selectFrom('administration.admin_users')
    .select('user_id')
    .where('id', '=', adminUserId)
    .executeTakeFirstOrThrow();
  const id = randomUUID(),
    at = new Date();
  return {
    command: {
      commandId: id,
      commandType: 'profile.resolve-protected-change',
      schemaVersion: 1,
      actor: { kind: 'admin', userId: admin.user_id },
      requestId: randomUUID(),
      idempotencyKey: id,
      occurredAt: at.toISOString(),
      locale: 'en',
      data: {
        profileChangeRequestId: requestId,
        decision: 'approved',
        note: 'Synthetic authorized review',
      },
    },
    authorization: { adminUserId, reviewerUserId: admin.user_id },
    normalizedNote: 'Synthetic authorized review',
    auditId: randomUUID(),
    eventId: randomUUID(),
    processedAt: at,
  };
}
