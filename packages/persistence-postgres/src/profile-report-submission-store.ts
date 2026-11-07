import { sql } from 'kysely';
import {
  EvaluateModerationThresholdHandler,
  SubmitProfileReportHandler,
  reportUnavailable,
  type ProfileReportSnapshotProtector,
  type ProtectedProfileReportSnapshot,
  type ProtectedChatReportSnapshot,
  type ProtectedUnmatchedReportSnapshot,
  type ProtectedPhotoReportSnapshot,
  type ProfileReportRequest,
  type ProfileReportWrite,
  type ProfileReportSubmissionStore,
  type ReportTokens,
  type UserSessionActor,
  type ReportSource,
} from '@nakh/application';
import type { ReportSubmissionResult } from '@nakh/contracts';
import { ApplicationError, canSubmitUserReport, CHAT_VISIBLE_MESSAGE_LIMIT } from '@nakh/domain';
import type { NakhDatabase } from './database.js';
import { SystemIdGenerator } from './foundation-store.js';
import { resolveProfileReportSource } from './profile-report-source-store.js';
import { applyModerationThreshold } from './moderation-threshold-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { requireCurrentUserSession } from './user-session-store.js';
import { lockUserPair, lockUserPairAccounts } from './pair-lock.js';
import { captureExploreCardSource, requireDeliveredExploreSource } from './explore-card-source.js';

export type DeliveredReportScope = Readonly<{ actor: UserSessionActor; deliveryId: string }>;
export type ConversationReportScope = Readonly<{
  actor: UserSessionActor;
  conversation: Readonly<{
    matchId: string;
    chatSessionId: string;
    source: Readonly<{ kind: 'match' | 'message' | 'unmatched'; referenceId: string }>;
  }>;
}>;
export type ReceivedLikeReportScope = Readonly<{ actor: UserSessionActor; receivedLikeId: string }>;
export type ReceivedNakhReportScope = Readonly<{ actor: UserSessionActor; receivedNakhId: string }>;
export type UserReportScope =
  | DeliveredReportScope
  | ConversationReportScope
  | ReceivedLikeReportScope
  | ReceivedNakhReportScope;
const REPORT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Metadata-only, keyset-paged entry to native post-Unmatch reporting. Anchors
 * neither reopen chat history nor extend the immutable reporting deadline. */
export async function listEndedReportConversations(
  database: NakhDatabase,
  input: UserSessionActor,
  after?: string,
): Promise<readonly Readonly<{ matchId: string; chatSessionId: string }>[]> {
  const actor = Object.freeze({ ...input });
  if (after !== undefined && !REPORT_UUID.test(after)) throw reportUnavailable();
  return database.transaction().execute(async (tx) => {
    await requireCurrentUserSession(tx, actor.userId, actor);
    return (
      await sql<{ matchId: string; chatSessionId: string }>`
      SELECT pair.id AS "matchId",chat.id AS "chatSessionId"
      FROM matching.match_reference_anchors pair
      JOIN chat.chat_reference_anchors chat ON chat.match_id=pair.id
      JOIN matching.unmatch_records ended ON ended.match_id=pair.id
      JOIN matching.match_lifecycle_facts fact ON fact.id=pair.id AND fact.status='unmatched'
      WHERE ((pair.user_low_id=${actor.userId}::uuid AND pair.low_product_epoch=${actor.productEpoch})
        OR (pair.user_high_id=${actor.userId}::uuid AND pair.high_product_epoch=${actor.productEpoch}))
        AND ended.unmatched_at<=clock_timestamp() AND ended.report_window_expires_at>clock_timestamp()
        ${after === undefined ? sql`` : sql`AND pair.id>${after}::uuid`}
      ORDER BY pair.id LIMIT 21`.execute(tx)
    ).rows;
  });
}
export function captureUserReportScope(input?: UserReportScope): UserReportScope | undefined {
  if (input !== undefined && 'receivedNakhId' in input) {
    const actor = Object.freeze({ ...input.actor });
    if (
      actor.kind !== 'user' ||
      ![actor.userId, actor.sessionGrantId, input.receivedNakhId].every((id) =>
        REPORT_UUID.test(id),
      ) ||
      !Number.isSafeInteger(actor.productEpoch) ||
      actor.productEpoch < 0
    )
      throw reportUnavailable();
    return Object.freeze({ actor, receivedNakhId: input.receivedNakhId });
  }
  if (input !== undefined && 'receivedLikeId' in input) {
    const actor = Object.freeze({ ...input.actor });
    if (
      actor.kind !== 'user' ||
      ![actor.userId, actor.sessionGrantId, input.receivedLikeId].every((id) =>
        REPORT_UUID.test(id),
      ) ||
      !Number.isSafeInteger(actor.productEpoch) ||
      actor.productEpoch < 0
    )
      throw reportUnavailable();
    return Object.freeze({ actor, receivedLikeId: input.receivedLikeId });
  }
  if (input === undefined || !('conversation' in input)) return captureDeliveredReportScope(input);
  const actor = Object.freeze({ ...input.actor }),
    c = structuredClone(input.conversation);
  if (
    actor.kind !== 'user' ||
    !REPORT_UUID.test(actor.userId) ||
    !REPORT_UUID.test(actor.sessionGrantId) ||
    !Number.isSafeInteger(actor.productEpoch) ||
    actor.productEpoch < 0 ||
    ![c.matchId, c.chatSessionId, c.source.referenceId].every((v) => REPORT_UUID.test(v)) ||
    !['match', 'message', 'unmatched'].includes(c.source.kind) ||
    (c.source.kind !== 'message' && c.source.referenceId !== c.matchId)
  )
    throw reportUnavailable();
  return Object.freeze({
    actor,
    conversation: Object.freeze({ ...c, source: Object.freeze(c.source) }),
  });
}
export function matchesUserReportScope(scope: UserReportScope, source: ReportSource): boolean {
  if ('receivedNakhId' in scope)
    return source.kind === 'received_nakh' && source.referenceId === scope.receivedNakhId;
  if ('receivedLikeId' in scope)
    return source.kind === 'received_like' && source.referenceId === scope.receivedLikeId;
  return 'conversation' in scope
    ? source.kind === scope.conversation.source.kind &&
        source.referenceId === scope.conversation.source.referenceId &&
        source.photoId === undefined
    : source.kind === 'delivered_candidate' && source.referenceId === scope.deliveryId;
}
/** Anchors identify the original incident only. Current grants and the native
 * evidence resolvers independently authorize preparation and new capture. */
export async function lockUserReportScope(
  database: NakhDatabase,
  scope: UserReportScope,
): Promise<string> {
  if ('receivedNakhId' in scope) {
    const original = (
      await sql<{ target: string; receiver: string; senderEpoch: number; receiverEpoch: number }>`
      SELECT sender_user_id AS target,receiver_user_id AS receiver,sender_product_epoch AS "senderEpoch",
       receiver_product_epoch AS "receiverEpoch" FROM nakh.nakh_reference_anchors WHERE id=${scope.receivedNakhId}::uuid`.execute(
        database,
      )
    ).rows[0];
    if (
      !original ||
      original.receiver !== scope.actor.userId ||
      original.receiverEpoch !== scope.actor.productEpoch
    )
      throw reportUnavailable();
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${original.target}::text,0))`.execute(
      database,
    );
    const pair = await lockUserPair(database, scope.actor.userId, original.target);
    if ((await lockUserPairAccounts(database, pair)).length !== 2) throw reportUnavailable();
    await requireCurrentUserSession(database, scope.actor.userId, scope.actor);
    const target = await database
      .selectFrom('identity.accounts')
      .select('product_epoch')
      .where('user_id', '=', original.target)
      .executeTakeFirst();
    if (target?.product_epoch !== original.senderEpoch) throw reportUnavailable();
    return original.target;
  }
  if ('receivedLikeId' in scope) {
    const original = (
      await sql<{ target: string; receiver: string; senderEpoch: number; receiverEpoch: number }>`
      SELECT sender_user_id AS target,receiver_user_id AS receiver,sender_product_epoch AS "senderEpoch",
        receiver_product_epoch AS "receiverEpoch" FROM interaction.like_reference_anchors WHERE id=${scope.receivedLikeId}::uuid`.execute(
        database,
      )
    ).rows[0];
    if (
      !original ||
      original.receiver !== scope.actor.userId ||
      original.receiverEpoch !== scope.actor.productEpoch
    )
      throw reportUnavailable();
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${original.target}::text,0))`.execute(
      database,
    );
    const pair = await lockUserPair(database, scope.actor.userId, original.target);
    if ((await lockUserPairAccounts(database, pair)).length !== 2) throw reportUnavailable();
    await requireCurrentUserSession(database, scope.actor.userId, scope.actor);
    const target = await database
      .selectFrom('identity.accounts')
      .select('product_epoch')
      .where('user_id', '=', original.target)
      .executeTakeFirst();
    if (target?.product_epoch !== original.senderEpoch) throw reportUnavailable();
    // A historical closed Like can authorize safety capture; it cannot select
    // a returned account's new profile or reopen ordinary customer access.
    return original.target;
  }
  if (!('conversation' in scope)) return lockDeliveredReportScope(database, scope);
  const c = scope.conversation;
  const original = (
    await sql<{
      user_low_id: string;
      user_high_id: string;
      low_product_epoch: number;
      high_product_epoch: number;
    }>`
    SELECT pair.user_low_id,pair.user_high_id,pair.low_product_epoch,pair.high_product_epoch
    FROM matching.match_reference_anchors pair JOIN chat.chat_reference_anchors chat ON chat.match_id=pair.id
    WHERE pair.id=${c.matchId}::uuid AND chat.id=${c.chatSessionId}::uuid`.execute(database)
  ).rows[0];
  if (original === undefined) throw reportUnavailable();
  const low = original.user_low_id === scope.actor.userId;
  if (
    (!low && original.user_high_id !== scope.actor.userId) ||
    (low ? original.low_product_epoch : original.high_product_epoch) !== scope.actor.productEpoch
  )
    throw reportUnavailable();
  const target = low ? original.user_high_id : original.user_low_id;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${target}::text, 0))`.execute(
    database,
  );
  const pair = await lockUserPair(database, scope.actor.userId, target);
  if ((await lockUserPairAccounts(database, pair)).length !== 2) throw reportUnavailable();
  await requireCurrentUserSession(database, scope.actor.userId, scope.actor);
  return target;
}
/** New message evidence must still be selectable in this exact conversation.
 * Cached receipts retain their existing native replay rules after capture. */
export async function requireUserReportSelection(
  database: NakhDatabase,
  scope: UserReportScope,
): Promise<void> {
  if (!('conversation' in scope) || scope.conversation.source.kind !== 'message') return;
  const c = scope.conversation;
  const visible = database
    .selectFrom('chat.chat_messages')
    .select('id')
    .where('chat_session_id', '=', c.chatSessionId)
    .orderBy('sequence_number', 'desc')
    .limit(CHAT_VISIBLE_MESSAGE_LIMIT);
  const message = await database
    .selectFrom('chat.chat_messages')
    .select('id')
    .where('id', '=', c.source.referenceId)
    .where('chat_session_id', '=', c.chatSessionId)
    .where('sender_user_id', 'is not', null)
    .where('sender_user_id', '!=', scope.actor.userId)
    .where('id', 'in', visible)
    .executeTakeFirst();
  if (message === undefined) throw reportUnavailable();
}
export function captureDeliveredReportScope(
  input?: DeliveredReportScope,
): DeliveredReportScope | undefined {
  if (input === undefined) return undefined;
  const actor = Object.freeze({ ...input.actor });
  const deliveryId = captureExploreCardSource(input.deliveryId, actor);
  if (deliveryId === undefined) throw reportUnavailable();
  return Object.freeze({ actor, deliveryId });
}
/** Public card authority is checked inside the business transaction, including
 * cached receipts. The existing threshold lock precedes the shared pair and
 * sorted User/Account locks, matching trusted report writers. */
export async function lockDeliveredReportScope(
  database: NakhDatabase,
  scope: DeliveredReportScope,
): Promise<string> {
  const delivery = await database
    .selectFrom('discovery.candidate_deliveries')
    .select('target_user_id')
    .where('id', '=', scope.deliveryId)
    .where('viewer_user_id', '=', scope.actor.userId)
    .executeTakeFirst();
  if (delivery === undefined || delivery.target_user_id === scope.actor.userId)
    throw reportUnavailable();
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${delivery.target_user_id}::text, 0))`.execute(
    database,
  );
  const pair = await lockUserPair(database, scope.actor.userId, delivery.target_user_id);
  const accounts = await lockUserPairAccounts(database, pair);
  if (accounts.length !== 2) throw reportUnavailable();
  await requireCurrentUserSession(database, scope.actor.userId, scope.actor);
  await requireDeliveredExploreSource(
    database,
    scope.deliveryId,
    scope.actor.userId,
    delivery.target_user_id,
  );
  return delivery.target_user_id;
}

async function assertReportLife(
  database: NakhDatabase,
  request: ProfileReportRequest,
): Promise<void> {
  const account = await database
    .selectFrom('identity.accounts')
    .select(['product_epoch', 'state'])
    .where('user_id', '=', request.actorUserId)
    .executeTakeFirst();
  if (
    account === undefined ||
    !canSubmitUserReport(account.state) ||
    account.product_epoch !== (request.productEpoch ?? 0)
  )
    throw reportUnavailable();
  if (
    request.sessionGrantId !== undefined &&
    (request.productEpoch === undefined ||
      (await new PostgresUserSessionStore(database).current(
        { userId: request.actorUserId, productEpoch: request.productEpoch },
        request.sessionGrantId,
      )) === undefined)
  )
    throw reportUnavailable();
}

async function replay(
  database: NakhDatabase,
  request: ProfileReportRequest,
): Promise<ReportSubmissionResult | undefined> {
  await assertReportLife(database, request);
  const rows = await database
    .selectFrom('moderation.reports')
    .select(['id', 'reporter_user_id', 'request_digest', 'submitted_at'])
    .where((eb) =>
      eb.or([
        eb('command_id', '=', request.commandId),
        eb.and([
          eb('reporter_user_id', '=', request.actorUserId),
          eb('idempotency_key', '=', request.idempotencyKey),
        ]),
      ]),
    )
    .execute();
  if (rows.length === 0) return undefined;
  const row = rows[0]!;
  if (
    rows.length !== 1 ||
    row.reporter_user_id !== request.actorUserId ||
    row.request_digest !== request.requestDigest
  )
    throw new ApplicationError('idempotency_conflict', 'error.command.idempotency_conflict', 409);
  // Replay the submission receipt, never expose a later confidential review outcome.
  return {
    reportId: row.id,
    status: 'pending_review',
    submittedAt: row.submitted_at.toISOString(),
    replayed: true,
  };
}
export interface SingleReportEvidenceCapture {
  capture(
    transaction: NakhDatabase,
    write: ProfileReportWrite,
  ): Promise<
    Readonly<{
      targetUserId: string;
      referenceId: string;
      snapshot:
        | ProtectedProfileReportSnapshot
        | ProtectedChatReportSnapshot
        | ProtectedPhotoReportSnapshot
        | ProtectedUnmatchedReportSnapshot
        | Readonly<{
            snapshotType: 'message';
            capture: (transaction: NakhDatabase) => Promise<void>;
          }>;
    }>
  >;
}

export class PostgresSingleEvidenceReportSubmissionStore implements ProfileReportSubmissionStore {
  private readonly scope: UserReportScope | undefined;
  public constructor(
    private readonly database: NakhDatabase,
    private readonly capture: SingleReportEvidenceCapture,
    scope?: UserReportScope,
  ) {
    this.scope = captureUserReportScope(scope);
  }
  private assertOwner(request: ProfileReportRequest): void {
    if (
      this.scope !== undefined &&
      (request.actorUserId !== this.scope.actor.userId ||
        request.productEpoch !== this.scope.actor.productEpoch ||
        request.sessionGrantId !== this.scope.actor.sessionGrantId)
    )
      throw new ApplicationError('unauthorized', 'error.identity.user_context_invalid', 401);
  }
  public async replay(input: ProfileReportRequest): Promise<ReportSubmissionResult | undefined> {
    const request = structuredClone(input);
    this.assertOwner(request);
    const scope = this.scope;
    if (scope === undefined) return replay(this.database, request);
    return this.database.transaction().execute(async (transaction) => {
      await lockUserReportScope(transaction, scope);
      return replay(transaction, request);
    });
  }
  public async submit(input: ProfileReportWrite): Promise<ReportSubmissionResult> {
    const write = structuredClone(input);
    this.assertOwner(write);
    const scope = this.scope;
    if (scope !== undefined && !matchesUserReportScope(scope, write.intent.source))
      throw reportUnavailable();
    return this.database
      .transaction()
      .execute<ReportSubmissionResult>(async (transaction) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('report-command:' || ${write.commandId}::text, 0))`.execute(
          transaction,
        );
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-report:' || ${write.actorUserId}::text, 0))`.execute(
          transaction,
        );
        if (
          scope !== undefined &&
          (await lockUserReportScope(transaction, scope)) !== write.intent.targetUserId
        )
          throw reportUnavailable();
        const previous = await replay(transaction, write);
        if (previous !== undefined) return previous;
        if (scope !== undefined) await requireUserReportSelection(transaction, scope);
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('moderation-threshold:' || ${write.intent.targetUserId}::text, 0))`.execute(
          transaction,
        );
        // Lock both accounts in canonical order so reciprocal reports cannot deadlock.
        const accounts = await transaction
          .selectFrom('identity.accounts')
          .select(['user_id', 'state', 'product_epoch'])
          .where('user_id', 'in', [write.actorUserId, write.intent.targetUserId])
          .orderBy('user_id')
          .forUpdate()
          .execute();
        const reporter = accounts.find((row) => row.user_id === write.actorUserId);
        if (accounts.length !== 2 || reporter === undefined || !canSubmitUserReport(reporter.state))
          throw reportUnavailable();
        await assertReportLife(transaction, write);
        const count = await transaction
          .selectFrom('moderation.reports')
          .select((eb) => eb.fn.countAll<string>().as('count'))
          .where('reporter_user_id', '=', write.actorUserId)
          .where('submitted_at', '>', sql<Date>`transaction_timestamp() - interval '24 hours'`)
          .executeTakeFirstOrThrow();
        if (Number(count.count) >= 10)
          throw new ApplicationError('report_limit_reached', 'error.m7.rate_limited', 429);
        const captured = await this.capture.capture(transaction, write);
        if (
          captured.targetUserId !== write.intent.targetUserId ||
          write.intent.evidence.length !== 1 ||
          captured.snapshot.snapshotType !== write.intent.evidence[0]?.evidenceType ||
          captured.referenceId !== write.intent.evidence[0].referenceId
        )
          throw reportUnavailable();
        const snapshot = captured.snapshot;
        const reason = await transaction
          .selectFrom(
            sql<{
              id: string;
            }>`moderation.lock_runtime_report_reason(${write.reasonCode}::text)`.as('reason'),
          )
          .select('id')
          .executeTakeFirst();
        if (reason === undefined) throw reportUnavailable();
        const report = await transaction
          .insertInto('moderation.reports')
          .values({
            id: write.reportId,
            reporter_user_id: write.actorUserId,
            target_user_id: captured.targetUserId,
            reason_id: reason.id,
            extra_text: write.normalizedText ?? null,
            status: 'pending_review',
            command_id: write.commandId,
            request_id: write.requestId,
            idempotency_key: write.idempotencyKey,
            request_digest: write.requestDigest,
          })
          .returning('submitted_at')
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('moderation.report_evidence')
          .values({
            id: write.evidenceId,
            report_id: write.reportId,
            evidence_type: snapshot.snapshotType,
            profile_id: snapshot.snapshotType === 'profile' ? captured.referenceId : null,
            profile_photo_id: snapshot.snapshotType === 'photo' ? captured.referenceId : null,
            chat_session_id: snapshot.snapshotType === 'chat' ? captured.referenceId : null,
            chat_message_id: snapshot.snapshotType === 'message' ? captured.referenceId : null,
            unmatch_record_id:
              snapshot.snapshotType === 'unmatched_user' ? captured.referenceId : null,
          })
          .execute();
        if (snapshot.snapshotType === 'message') {
          await snapshot.capture(transaction);
        } else
          await transaction
            .insertInto('moderation.report_snapshots')
            .values({
              id: write.snapshotId,
              report_id: write.reportId,
              report_evidence_id: write.evidenceId,
              snapshot_type: snapshot.snapshotType,
              schema_version: snapshot.schemaVersion,
              encryption_key_id: snapshot.keyId,
              encryption_key_version: snapshot.keyVersion,
              nonce: Buffer.from(snapshot.nonce),
              ciphertext: Buffer.from(snapshot.ciphertext),
              content_sha256: snapshot.sha256,
            })
            .execute();
        await transaction
          .insertInto('moderation.moderation_reviews')
          .values({
            id: write.reviewId,
            report_id: write.reportId,
            created_at: sql<Date>`transaction_timestamp()`,
            updated_at: sql<Date>`transaction_timestamp()`,
          })
          .execute();
        await transaction
          .insertInto('platform.outbox_events')
          .values({
            id: write.eventId,
            aggregate_type: 'report',
            aggregate_id: write.reportId,
            event_type: 'moderation.report-submitted.v1',
            schema_version: 1,
            payload: {
              reportId: write.reportId,
              evidenceTypes: [snapshot.snapshotType],
              status: 'pending_review',
            },
            occurred_at: report.submitted_at,
            available_at: report.submitted_at,
            published_at: null,
            last_error_code: null,
            lease_owner: null,
            lease_expires_at: null,
            correlation_id: write.requestId,
            causation_id: write.commandId,
          })
          .execute();
        await new EvaluateModerationThresholdHandler(
          { evaluate: (threshold) => applyModerationThreshold(transaction, threshold) },
          new SystemIdGenerator(),
        ).execute({
          sourceReportId: write.reportId,
          requestId: write.requestId,
          commandId: write.commandId,
        });
        return {
          reportId: write.reportId,
          status: 'pending_review',
          submittedAt: report.submitted_at.toISOString(),
          replayed: false,
        };
      })
      .catch((error: unknown) => {
        if (
          error !== null &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '23514' &&
          'constraint' in error &&
          error.constraint === 'report_unmatch_deadline_valid'
        )
          throw reportUnavailable();
        throw error;
      });
  }
}

export async function captureProfileReportEvidence(
  transaction: NakhDatabase,
  write: ProfileReportWrite,
  snapshots: ProfileReportSnapshotProtector,
): ReturnType<SingleReportEvidenceCapture['capture']> {
  const authorized = await resolveProfileReportSource(
    transaction,
    write.actorUserId,
    write.intent.source,
    true,
  );
  if (
    authorized === undefined ||
    authorized.targetUserId !== write.intent.targetUserId ||
    write.intent.evidence.length !== 1 ||
    write.intent.evidence[0]?.evidenceType !== 'profile' ||
    authorized.evidence[0]?.referenceId !== write.intent.evidence[0].referenceId
  )
    throw reportUnavailable();
  const profile = await transaction
    .selectFrom('profile.profiles')
    .select(['name', 'birth_year', 'bio'])
    .where('id', '=', authorized.evidence[0].referenceId)
    .forShare()
    .executeTakeFirstOrThrow();
  return {
    targetUserId: authorized.targetUserId,
    referenceId: authorized.evidence[0].referenceId,
    snapshot: snapshots.protect(
      { reportId: write.reportId, evidenceId: write.evidenceId },
      {
        evidenceType: 'profile',
        displayName: profile.name,
        birthYear: profile.birth_year,
        ...(profile.bio === null ? {} : { bio: profile.bio }),
      },
    ),
  };
}
export class PostgresProfileReportSubmissionStore extends PostgresSingleEvidenceReportSubmissionStore {
  public constructor(database: NakhDatabase, snapshots: ProfileReportSnapshotProtector) {
    super(database, {
      capture: (transaction, write) => captureProfileReportEvidence(transaction, write, snapshots),
    });
  }
}
export class PostgresSubmitProfileReportHandler extends SubmitProfileReportHandler {
  public constructor(
    database: NakhDatabase,
    tokens: ReportTokens,
    snapshots: ProfileReportSnapshotProtector,
  ) {
    super(
      tokens,
      new PostgresProfileReportSubmissionStore(database, snapshots),
      new SystemIdGenerator(),
    );
  }
}
