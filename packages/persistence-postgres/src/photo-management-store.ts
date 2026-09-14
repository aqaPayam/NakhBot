import { sql, type Selectable, type Transaction } from 'kysely';

import type {
  ManagedPhoto,
  OwnPhotoAction,
  OwnPhotoCollection,
  PhotoManagementStore,
} from '@nakh/application';
import {
  ApplicationError,
  deleteOwnPhoto,
  moderatePhoto,
  reorderPhotos,
  selectPrimaryPhoto,
  type PhotoState,
} from '@nakh/domain';

import type { DatabaseSchema, NakhDatabase } from './database.js';
import { profilePhotosAreEligible } from './media-eligibility.js';
import type { ProfilePhotoTable } from './media-tables.js';

type Tx = Transaction<DatabaseSchema>;
type PhotoRow = Selectable<ProfilePhotoTable>;

function missingPhoto(): never {
  throw new ApplicationError('photo_not_found', 'error.media.photo_not_found', 404);
}

function state(rows: readonly PhotoRow[]): readonly PhotoState[] {
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    isPrimary: row.is_primary,
    displayOrder: row.display_order,
  }));
}

function managed(rows: readonly PhotoRow[]): readonly ManagedPhoto[] {
  return rows
    .filter((row) => row.status !== 'deleted')
    .sort((a, b) => a.display_order - b.display_order)
    .map((row) => ({
      id: row.id,
      status: row.status,
      isPrimary: row.is_primary,
      displayOrder: row.display_order,
      version: row.version,
    }));
}

async function lockedPhotos(tx: Tx, profileId: string): Promise<readonly PhotoRow[]> {
  return tx
    .selectFrom('media.profile_photos')
    .selectAll()
    .where('profile_id', '=', profileId)
    .orderBy('id')
    .forUpdate()
    .execute();
}

function plan(rows: readonly PhotoRow[], action: OwnPhotoAction): readonly PhotoState[] {
  const current = state(rows);
  if (action.type === 'reorder') return reorderPhotos(current, action.orderedPhotoIds);
  if (action.type === 'select_primary') return selectPrimaryPhoto(current, action.photoId);
  return deleteOwnPhoto(current, action.photoId);
}

function changed(before: PhotoRow, after: PhotoState): boolean {
  return (
    before.status !== after.status ||
    before.is_primary !== after.isPrimary ||
    before.display_order !== after.displayOrder
  );
}

async function applyPlan(
  tx: Tx,
  profileId: string,
  rows: readonly PhotoRow[],
  next: readonly PhotoState[],
  at: Date,
): Promise<void> {
  await tx
    .updateTable('media.profile_photos')
    .set({ is_primary: false })
    .where('profile_id', '=', profileId)
    .where('is_primary', '=', true)
    .execute();
  await tx
    .updateTable('media.profile_photos')
    .set({ display_order: sql<number>`display_order + 1000` })
    .where('profile_id', '=', profileId)
    .where('status', '!=', 'deleted')
    .execute();
  const nextById = new Map(next.map((photo) => [photo.id, photo]));
  for (const before of rows) {
    if (before.status === 'deleted') continue;
    const after = nextById.get(before.id)!;
    const didChange = changed(before, after);
    const updated = await tx
      .updateTable('media.profile_photos')
      .set({
        status: after.status,
        is_primary: after.isPrimary,
        display_order: after.displayOrder,
        version: didChange ? sql<number>`version + 1` : before.version,
        updated_at: didChange ? at : before.updated_at,
        hidden_at:
          after.status === 'hidden' ? (before.status === 'hidden' ? before.hidden_at : at) : null,
        deleted_at: after.status === 'deleted' ? at : null,
      })
      .where('id', '=', before.id)
      .where('version', '=', before.version)
      .returning('id')
      .executeTakeFirst();
    if (updated === undefined)
      throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
  }
}

async function updateProfile(
  tx: Tx,
  profile: Readonly<{
    id: string;
    version: number;
    completion_status: 'incomplete' | 'complete' | 'invalid';
    ever_completed: boolean;
  }>,
  at: Date,
): Promise<{ version: number; completionChanged: boolean; complete: boolean }> {
  const complete = await profilePhotosAreEligible(tx, profile.id);
  const completionStatus = profile.ever_completed
    ? complete
      ? 'complete'
      : 'invalid'
    : 'incomplete';
  const updated = await tx
    .updateTable('profile.profiles')
    .set({
      completion_status: completionStatus,
      version: sql<number>`version + 1`,
      updated_at: at,
    })
    .where('id', '=', profile.id)
    .where('version', '=', profile.version)
    .returning('version')
    .executeTakeFirst();
  if (updated === undefined)
    throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
  return {
    version: updated.version,
    completionChanged: profile.completion_status !== completionStatus,
    complete,
  };
}

async function event(
  tx: Tx,
  input: Readonly<{
    id: string;
    aggregateType: 'profile' | 'profile_photo';
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
  }>,
): Promise<void> {
  await tx
    .insertInto('platform.outbox_events')
    .values({
      id: input.id,
      aggregate_type: input.aggregateType,
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      schema_version: 1,
      payload: input.payload,
      occurred_at: input.occurredAt,
      available_at: input.occurredAt,
      published_at: null,
      last_error_code: null,
      lease_owner: null,
      lease_expires_at: null,
      correlation_id: input.id,
      causation_id: input.id,
    })
    .execute();
}

async function tombstoneDeletedPhotoAsset(tx: Tx, photoId: string, at: Date): Promise<void> {
  const photo = await tx
    .selectFrom('media.profile_photos')
    .select(['asset_id', 'status'])
    .where('id', '=', photoId)
    .executeTakeFirstOrThrow();
  if (photo.status !== 'deleted')
    throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
  const asset = await tx
    .updateTable('media.media_assets')
    .set({ deleted_at: at, version: sql<number>`version + 1`, updated_at: at })
    .where('id', '=', photo.asset_id)
    .where('deleted_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (asset === undefined)
    throw new ApplicationError('media_invalid_state', 'error.media.state', 409);
  await tx
    .updateTable('media.photo_variants')
    .set({ deleted_at: at })
    .where('asset_id', '=', photo.asset_id)
    .where('deleted_at', 'is', null)
    .execute();
}

export class PostgresPhotoManagementStore implements PhotoManagementStore {
  public constructor(private readonly database: NakhDatabase) {}

  public async listOwn(userId: string): Promise<OwnPhotoCollection> {
    const profile = await this.database
      .selectFrom('profile.profiles')
      .select(['id', 'version'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (profile === undefined) missingPhoto();
    const rows = await this.database
      .selectFrom('media.profile_photos')
      .selectAll()
      .where('profile_id', '=', profile.id)
      .where('status', '!=', 'deleted')
      .orderBy('display_order')
      .execute();
    return { profileVersion: profile.version, photos: managed(rows) };
  }

  public async mutateOwn(
    input: Readonly<{
      userId: string;
      expectedProfileVersion: number;
      action: OwnPhotoAction;
      auditId: string;
      eventId: string;
      profileEventId: string;
      occurredAt: Date;
    }>,
  ): Promise<OwnPhotoCollection> {
    if (!Number.isSafeInteger(input.expectedProfileVersion) || input.expectedProfileVersion < 1)
      throw new ApplicationError('invalid_request', 'error.command.version_invalid', 400);
    return this.database.transaction().execute(async (tx) => {
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', input.userId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const profile = await tx
        .selectFrom('profile.profiles')
        .select(['id', 'version', 'completion_status', 'ever_completed'])
        .where('user_id', '=', input.userId)
        .forUpdate()
        .executeTakeFirst();
      if (profile === undefined) missingPhoto();
      if (profile.version !== input.expectedProfileVersion)
        throw new ApplicationError('version_conflict', 'error.command.version_conflict', 409);
      const rows = await lockedPhotos(tx, profile.id);
      const next = plan(rows, input.action);
      await applyPlan(tx, profile.id, rows, next, input.occurredAt);
      if (input.action.type === 'delete')
        await tombstoneDeletedPhotoAsset(tx, input.action.photoId, input.occurredAt);
      const profileResult = await updateProfile(tx, profile, input.occurredAt);
      const eventType =
        input.action.type === 'reorder'
          ? 'media.photos-reordered.v1'
          : input.action.type === 'select_primary'
            ? 'media.photo-primary-selected.v1'
            : 'media.photo-deleted.v1';
      const photoId = input.action.type === 'reorder' ? undefined : input.action.photoId;
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: input.auditId,
          category: 'product',
          event_type: eventType,
          actor_type: 'user',
          actor_user_id: input.userId,
          actor_admin_id: null,
          subject_type: photoId === undefined ? 'profile' : 'profile_photo',
          subject_id: photoId ?? profile.id,
          result_code: 'succeeded',
          metadata_schema_version: 1,
          metadata: photoId === undefined ? {} : { photoId },
          request_id: input.eventId,
          command_id: input.eventId,
          occurred_at: input.occurredAt,
        })
        .execute();
      await event(tx, {
        id: input.eventId,
        aggregateType: photoId === undefined ? 'profile' : 'profile_photo',
        aggregateId: photoId ?? profile.id,
        eventType,
        payload: { profileId: profile.id, ...(photoId === undefined ? {} : { photoId }) },
        occurredAt: input.occurredAt,
      });
      if (profileResult.completionChanged)
        await event(tx, {
          id: input.profileEventId,
          aggregateType: 'profile',
          aggregateId: profile.id,
          eventType: profileResult.complete
            ? 'profile.profile-completed.v1'
            : 'profile.profile-invalidated.v1',
          payload: { profileId: profile.id },
          occurredAt: input.occurredAt,
        });
      const latest = await tx
        .selectFrom('media.profile_photos')
        .selectAll()
        .where('profile_id', '=', profile.id)
        .where('status', '!=', 'deleted')
        .orderBy('display_order')
        .execute();
      return { profileVersion: profileResult.version, photos: managed(latest) };
    });
  }

  public async moderate(
    input: Readonly<{
      adminUserId: string;
      photoId: string;
      action: 'hide' | 'restore' | 'delete';
      reasonCode: string;
      moderationId: string;
      auditId: string;
      eventId: string;
      profileEventId: string;
      occurredAt: Date;
    }>,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      const admin = await tx
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', input.adminUserId)
        .where('is_active', '=', true)
        .forUpdate()
        .executeTakeFirst();
      if (admin === undefined)
        throw new ApplicationError(
          'reviewer_unauthorized',
          'error.admin.reviewer_unauthorized',
          403,
        );
      const target = await tx
        .selectFrom('media.profile_photos as photo')
        .innerJoin('profile.profiles as profile', 'profile.id', 'photo.profile_id')
        .select(['photo.profile_id', 'profile.user_id'])
        .where('photo.id', '=', input.photoId)
        .executeTakeFirst();
      if (target === undefined) missingPhoto();
      await tx
        .selectFrom('identity.users')
        .select('id')
        .where('id', '=', target.user_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const profile = await tx
        .selectFrom('profile.profiles')
        .select(['id', 'version', 'completion_status', 'ever_completed'])
        .where('id', '=', target.profile_id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const rows = await lockedPhotos(tx, profile.id);
      const next = moderatePhoto(state(rows), input.photoId, input.action);
      await applyPlan(tx, profile.id, rows, next, input.occurredAt);
      if (input.action === 'delete')
        await tombstoneDeletedPhotoAsset(tx, input.photoId, input.occurredAt);
      const profileResult = await updateProfile(tx, profile, input.occurredAt);
      const eventType =
        input.action === 'hide'
          ? 'media.photo-hidden.v1'
          : input.action === 'restore'
            ? 'media.photo-visible.v1'
            : 'media.photo-deleted.v1';
      await tx
        .insertInto('media.photo_moderation_records')
        .values({
          id: input.moderationId,
          photo_id: input.photoId,
          admin_user_id: admin.id,
          action: input.action,
          reason_code: input.reasonCode,
          report_id: null,
          occurred_at: input.occurredAt,
        })
        .execute();
      await tx
        .insertInto('platform.audit_logs')
        .values({
          id: input.auditId,
          category: 'admin',
          event_type: eventType,
          actor_type: 'admin',
          actor_user_id: null,
          actor_admin_id: admin.id,
          subject_type: 'profile_photo',
          subject_id: input.photoId,
          result_code: 'succeeded',
          metadata_schema_version: 1,
          metadata: { action: input.action, reasonCode: input.reasonCode },
          request_id: input.eventId,
          command_id: input.eventId,
          occurred_at: input.occurredAt,
        })
        .execute();
      await event(tx, {
        id: input.eventId,
        aggregateType: 'profile_photo',
        aggregateId: input.photoId,
        eventType,
        payload: { profileId: profile.id, photoId: input.photoId },
        occurredAt: input.occurredAt,
      });
      if (profileResult.completionChanged)
        await event(tx, {
          id: input.profileEventId,
          aggregateType: 'profile',
          aggregateId: profile.id,
          eventType: profileResult.complete
            ? 'profile.profile-completed.v1'
            : 'profile.profile-invalidated.v1',
          payload: { profileId: profile.id },
          occurredAt: input.occurredAt,
        });
    });
  }
}
