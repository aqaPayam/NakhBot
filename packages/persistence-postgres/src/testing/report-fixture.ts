import { randomUUID } from 'node:crypto';
import type { NakhDatabase } from '../database.js';
import {
  CreateDirectNakhHandler,
  AesGcmPhotoReportSnapshotProtector,
  type ReportPhotoContent,
} from '@nakh/application';
import { PostgresDirectNakhStore } from '../direct-nakh-store.js';
import { PostgresCreditLedgerStore } from '../credit-ledger-store.js';
import { SystemIdGenerator } from '../foundation-store.js';
import { PostgresCandidateDeliveryStore } from '../candidate-delivery-store.js';
import { PostgresUnmatchStore } from '../unmatch-store.js';
import { seedValidMedia } from '../media-fixtures.js';
import { retainPhotoEvidenceInTransaction } from '../photo-evidence-retention-store.js';

/** Synthetic live text for M7 authorization/retention tests; preserves the M6 allocator. */
export async function createReportMessage(
  database: NakhDatabase,
  chatSessionId: string,
  sender: string,
  text = 'Private message evidence fixture',
): Promise<string> {
  const id = randomUUID();
  await database.transaction().execute(async (tx) => {
    const session = await tx
      .selectFrom('chat.chat_sessions')
      .select(['next_sequence_number', 'version'])
      .where('id', '=', chatSessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('chat.chat_sessions')
      .set({
        next_sequence_number: String(BigInt(session.next_sequence_number) + 1n),
        version: session.version + 1,
      })
      .where('id', '=', chatSessionId)
      .execute();
    await tx
      .insertInto('chat.chat_messages')
      .values({
        id,
        chat_session_id: chatSessionId,
        sender_user_id: sender,
        message_type: 'text',
        text,
        predefined_question_id: null,
        predefined_answer_id: null,
        system_arguments: null,
        sequence_number: session.next_sequence_number,
      })
      .execute();
  });
  return id;
}

/** Synthetic safety evidence fixture. Does not verify or copy real storage objects. */
export async function createRetainedReportPhoto(database: NakhDatabase): Promise<
  Readonly<{
    reporter: string;
    target: string;
    photoId: string;
    reportId: string;
    evidenceId: string;
    key: Buffer;
    content: ReportPhotoContent;
  }>
> {
  const reporter = await createReportUser(database),
    target = await createReportUser(database, true),
    photoId = await createReportPhoto(database, target),
    reportId = randomUUID(),
    evidenceId = randomUUID();
  await createReportLike(database, reporter, target);
  const key = Buffer.alloc(32, 81);
  const content = await database.transaction().execute(async (tx) => {
    const captured = await retainPhotoEvidenceInTransaction(tx, { photoId, evidenceId });
    const reason = await tx
      .selectFrom('moderation.report_reasons')
      .select('id')
      .where('code', '=', 'inappropriate_photo')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('moderation.reports')
      .values({
        id: reportId,
        reporter_user_id: reporter,
        target_user_id: target,
        reason_id: reason.id,
        extra_text: null,
        status: 'submitted',
        command_id: randomUUID(),
        request_id: randomUUID(),
        idempotency_key: randomUUID(),
        request_digest: '8'.repeat(64),
        reviewed_at: null,
        closed_at: null,
      })
      .execute();
    await tx
      .insertInto('moderation.report_evidence')
      .values({
        id: evidenceId,
        report_id: reportId,
        evidence_type: 'photo',
        profile_id: null,
        profile_photo_id: photoId,
        chat_session_id: null,
        chat_message_id: null,
        unmatch_record_id: null,
      })
      .execute();
    const snapshot = new AesGcmPhotoReportSnapshotProtector('photo-fixture', 1, key).protect(
      { reportId, evidenceId },
      captured,
    );
    await tx
      .insertInto('moderation.report_snapshots')
      .values({
        id: randomUUID(),
        report_id: reportId,
        report_evidence_id: evidenceId,
        snapshot_type: 'photo',
        schema_version: 1,
        encryption_key_id: snapshot.keyId,
        encryption_key_version: snapshot.keyVersion,
        nonce: Buffer.from(snapshot.nonce),
        ciphertext: Buffer.from(snapshot.ciphertext),
        content_sha256: snapshot.sha256,
      })
      .execute();
    return captured;
  });
  return { reporter, target, photoId, reportId, evidenceId, key, content };
}

export async function createReportPhoto(
  database: NakhDatabase,
  target: string,
  primary = true,
): Promise<string> {
  const profile = await database
    .selectFrom('profile.profiles')
    .select('id')
    .where('user_id', '=', target)
    .executeTakeFirstOrThrow();
  const assetId = await seedValidMedia(database, target),
    id = randomUUID(),
    now = new Date();
  const count = await database
    .selectFrom('media.profile_photos')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('profile_id', '=', profile.id)
    .executeTakeFirstOrThrow();
  await database
    .insertInto('media.profile_photos')
    .values({
      id,
      profile_id: profile.id,
      asset_id: assetId,
      status: 'visible',
      is_primary: primary,
      display_order: Number(count.count) + 1,
      created_at: now,
      updated_at: now,
      hidden_at: null,
      deleted_at: null,
    })
    .execute();
  return id;
}

export async function createReportUnmatch(
  database: NakhDatabase,
  first: string,
  second: string,
  historicalTime?: Date,
): Promise<Readonly<{ matchId: string; chatSessionId: string }>> {
  const at = historicalTime ?? new Date();
  const chat = await createReportChat(database, first, second, new Date(at.getTime() - 1000));
  const [low, high] = [first, second].sort() as [string, string];
  await database
    .insertInto('interaction.user_pair_states')
    .values({
      user_low_id: low,
      user_high_id: high,
      state: 'matched',
      reason_code: 'match',
      changed_at: new Date(at.getTime() - 1000),
    })
    .execute();
  if (historicalTime === undefined) {
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: second, created_at: at, updated_at: at })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await new PostgresUnmatchStore(database).unmatch({
      matchId: chat.matchId,
      eventId: randomUUID(),
      command: {
        commandType: 'matching.unmatch',
        schemaVersion: 1,
        actor: { kind: 'user', userId: first },
        commandId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: at.toISOString(),
        locale: 'en',
        data: { matchActionToken: 'fixture' },
      },
    });
    return chat;
  }
  // Historical lifecycle fixtures preserve all deferred consistency checks, never mutate records.
  await database.transaction().execute(async (tx) => {
    await tx
      .insertInto('matching.unmatch_records')
      .values({
        match_id: chat.matchId,
        actor_user_id: first,
        reason_code: null,
        command_id: randomUUID(),
        idempotency_key: randomUUID(),
        unmatched_at: at,
        report_window_expires_at: new Date(at.getTime() + 86400000),
      })
      .execute();
    await tx
      .updateTable('matching.matches')
      .set({ status: 'unmatched', closed_at: at, version: 2 })
      .where('id', '=', chat.matchId)
      .execute();
    await tx
      .updateTable('interaction.user_pair_states')
      .set({ state: 'unmatched', reason_code: 'unmatch', changed_at: at, version: 2 })
      .where('user_low_id', '=', low)
      .where('user_high_id', '=', high)
      .execute();
    await tx
      .updateTable('chat.chat_sessions')
      .set({ status: 'closed', closed_reason: 'unmatch', closed_at: at, version: 2 })
      .where('id', '=', chat.chatSessionId)
      .execute();
    await tx
      .updateTable('interaction.likes')
      .set({ status: 'closed_by_unmatch', closed_at: at, version: 2 })
      .where('sender_user_id', 'in', [first, second])
      .where('receiver_user_id', 'in', [first, second])
      .execute();
  });
  return chat;
}

export async function createReportChat(
  database: NakhDatabase,
  first: string,
  second: string,
  now = new Date(),
): Promise<Readonly<{ matchId: string; chatSessionId: string }>> {
  const matchId = await createReportMatch(database, first, second, now),
    chatSessionId = randomUUID();
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('chat.chat_sessions')
      .values({
        id: chatSessionId,
        match_id: matchId,
        status: 'active',
        created_at: now,
        closed_at: null,
        closed_reason: null,
      })
      .execute();
    await transaction
      .insertInto('chat.chat_participants')
      .values(
        [first, second].map((userId) => ({
          chat_session_id: chatSessionId,
          user_id: userId,
          last_read_at: null,
          last_read_sequence_number: null,
          muted_at: null,
          unlock_safety_warning_shown_at: null,
        })),
      )
      .execute();
  });
  return { matchId, chatSessionId };
}

export async function createReportMatch(
  database: NakhDatabase,
  first: string,
  second: string,
  now = new Date(),
): Promise<string> {
  const id = randomUUID();
  const [low, high] = [first, second].sort() as [string, string];
  const a = await createReportLike(database, first, second, now),
    b = await createReportLike(database, second, first, now);
  await database.transaction().execute(async (transaction) => {
    await transaction
      .insertInto('matching.matches')
      .values({
        id,
        user_low_id: low,
        user_high_id: high,
        source: 'mutual_like',
        source_like_a_id: a,
        source_like_b_id: b,
        source_nakh_id: null,
        status: 'active',
        created_at: now,
        closed_at: null,
      })
      .execute();
    await transaction
      .insertInto('matching.match_participants')
      .values([
        { match_id: id, user_id: low, joined_at: now },
        { match_id: id, user_id: high, joined_at: now },
      ])
      .execute();
  });
  return id;
}

export async function createReportDelivery(
  database: NakhDatabase,
  reporter: string,
  target: string,
  state: 'reserved' | 'delivered' | 'failed' = 'delivered',
): Promise<string> {
  const id = randomUUID(),
    now = new Date();
  await database
    .insertInto('discovery.candidate_deliveries')
    .values({
      id,
      viewer_user_id: reporter,
      target_user_id: target,
      mode: 'explore',
      filter_version: 1,
      state: 'reserved',
      expires_at: new Date(now.getTime() + 300000),
      provider_message_id: null,
      reserved_at: now,
      delivered_at: null,
      failed_at: null,
      updated_at: now,
    })
    .execute();
  const store = new PostgresCandidateDeliveryStore(database);
  if (state === 'delivered')
    await store.recordDelivered(
      { deliveryId: id, providerMessageId: '123' },
      {
        auditId: randomUUID(),
        deliveryEventId: randomUUID(),
        consumptionEventId: randomUUID(),
        processedAt: new Date(),
      },
    );
  if (state === 'failed')
    await store.recordDefinitiveFailure(
      { deliveryId: id, reasonCode: 'provider_rejected' },
      { auditId: randomUUID(), eventId: randomUUID(), processedAt: new Date() },
    );
  return id;
}

export async function createReportUser(
  database: NakhDatabase,
  withProfile = false,
): Promise<string> {
  const id = randomUUID(),
    now = new Date();
  await database
    .insertInto('identity.users')
    .values({ id, last_activity_at: now, created_at: now, updated_at: now })
    .execute();
  await database
    .insertInto('identity.accounts')
    .values({ user_id: id, state: 'active', state_reason: null, state_changed_at: now })
    .execute();
  if (withProfile)
    await database
      .insertInto('profile.profiles')
      .values({
        id: randomUUID(),
        user_id: id,
        name: 'Private report fixture',
        birth_year: 1995,
        gender_option_id: '20000000-0000-4000-8000-000000000001',
        gender_preference_id: '20000000-0000-4000-8000-000000000013',
        relationship_goal_id: '20000000-0000-4000-8000-000000000021',
        country_id: '20000000-0000-4000-8000-000000000101',
        province_id: '20000000-0000-4000-8000-000000000111',
        city_id: '20000000-0000-4000-8000-000000000121',
        highlight: 'Private highlight',
        bio: 'Private report bio',
        completion_status: 'complete',
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  return id;
}
export async function createReportLike(
  database: NakhDatabase,
  reporter: string,
  target: string,
  now = new Date(),
): Promise<string> {
  const id = randomUUID();
  await database
    .insertInto('interaction.likes')
    .values({
      id,
      sender_user_id: target,
      receiver_user_id: reporter,
      status: 'active',
      created_at: now,
      closed_at: null,
    })
    .execute();
  return id;
}

export async function createReportFixtureAdmin(database: NakhDatabase): Promise<string> {
  const userId = await createReportUser(database),
    id = randomUUID(),
    now = new Date();
  const telegramUserId = String(2_000_000_000 + Math.floor(Math.random() * 7_000_000_000));
  await database
    .insertInto('identity.telegram_identities')
    .values({
      user_id: userId,
      telegram_user_id: telegramUserId,
      username: null,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
  await database
    .insertInto('administration.admin_users')
    .values({
      id,
      user_id: userId,
      telegram_user_id: telegramUserId,
      is_active: true,
      disabled_at: null,
      identity_verified_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

export async function createReportNakh(
  database: NakhDatabase,
  reporter: string,
  target: string,
): Promise<string> {
  const now = new Date();
  for (const userId of [reporter, target]) {
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: now, updated_at: now })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
  }
  await new PostgresCreditLedgerStore(database).append({
    transactionId: randomUUID(),
    userId: target,
    transactionType: 'admin_adjustment',
    amount: 2n,
    idempotencyKey: randomUUID(),
    correlationId: randomUUID(),
  });
  const result = await new CreateDirectNakhHandler(
    new PostgresDirectNakhStore(database),
    new SystemIdGenerator(),
  ).execute({
    commandType: 'nakh.create-direct',
    schemaVersion: 1,
    commandId: randomUUID(),
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
    actor: { kind: 'user', userId: target },
    occurredAt: now.toISOString(),
    locale: 'en',
    data: { targetUserId: reporter, text: 'Private Nakh text is not report evidence' },
  });
  return result.nakhId;
}
