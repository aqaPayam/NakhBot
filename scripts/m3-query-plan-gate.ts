import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzeM3QueryTables,
  createDatabase,
  explainCandidatePool,
  explainLikedByQueries,
  PostgresLikedByStore,
  runMigrations,
  type NakhDatabase,
} from '@nakh/persistence-postgres';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for the M3 query-plan gate.');

const configuredVolume = Number(process.env.NAKH_M3_PLAN_VOLUME ?? '5000');
if (
  !Number.isSafeInteger(configuredVolume) ||
  configuredVolume < 1_000 ||
  configuredVolume > 50_000
)
  throw new Error('NAKH_M3_PLAN_VOLUME must be an integer between 1000 and 50000.');

const manGenderId = '20000000-0000-4000-8000-000000000001';
const womanGenderId = '20000000-0000-4000-8000-000000000002';
const menPreferenceId = '20000000-0000-4000-8000-000000000011';
const womenPreferenceId = '20000000-0000-4000-8000-000000000012';
const relationshipGoalId = '20000000-0000-4000-8000-000000000021';
const countryId = '20000000-0000-4000-8000-000000000101';
const provinceId = '20000000-0000-4000-8000-000000000111';
const cityId = '20000000-0000-4000-8000-000000000121';
const batchSize = 250;

const likedByMatrixCases = [
  'actionable',
  'account_guest',
  'account_incomplete',
  'account_restricted',
  'account_banned',
  'account_deleted',
  'profile_incomplete',
  'profile_invalid',
  'like_closed_by_match',
  'like_closed_by_not_interested',
  'like_closed_by_unmatch',
  'like_cancelled_by_system',
  'pair_matched',
  'pair_unmatched',
  'pair_blocked',
  'receiver_rejected_liker',
  'photo_hidden',
  'photo_deleted',
  'photo_missing',
  'asset_deleted',
  'asset_storage_deleted',
  'thumbnail_deleted',
  'thumbnail_storage_deleted',
  'thumbnail_missing',
] as const;

type LikedByMatrixCase = (typeof likedByMatrixCases)[number];

type CandidateFixture = Readonly<{
  userId: string;
  profileId: string;
  assetId: string;
  photoId: string;
  variantId: string;
  likeId: string;
  likeReceiverId: string;
  likedByMatrixCase?: LikedByMatrixCase;
}>;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Actual Total Time'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Sort Method'?: string;
  Plans?: PlanNode[];
}

interface PlanDocument {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}

type PlanNodeSummary = Readonly<{
  nodeType: string;
  relation?: string;
  index?: string;
  planRows?: number;
  actualRows?: number;
  actualLoops?: number;
  actualTotalTimeMs?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  sortMethod?: string;
}>;

type PlanSummary = Readonly<{
  name: string;
  planningTimeMs: number;
  executionTimeMs: number;
  nodes: readonly PlanNodeSummary[];
}>;

function chunks<T>(values: readonly T[]): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += batchSize)
    result.push(values.slice(index, index + batchSize));
  return result;
}

function planDocument(value: unknown): PlanDocument {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('Invalid PostgreSQL plan.');
  const document: unknown = parsed[0];
  if (
    typeof document !== 'object' ||
    document === null ||
    !('Plan' in document) ||
    !('Planning Time' in document) ||
    !('Execution Time' in document)
  )
    throw new Error('Incomplete PostgreSQL plan.');
  return document as PlanDocument;
}

function summarizePlan(name: string, value: unknown): PlanSummary {
  const document = planDocument(value);
  const nodes: PlanNodeSummary[] = [];
  const visit = (node: PlanNode): void => {
    nodes.push({
      nodeType: node['Node Type'],
      ...(node['Relation Name'] === undefined ? {} : { relation: node['Relation Name'] }),
      ...(node['Index Name'] === undefined ? {} : { index: node['Index Name'] }),
      ...(node['Plan Rows'] === undefined ? {} : { planRows: node['Plan Rows'] }),
      ...(node['Actual Rows'] === undefined ? {} : { actualRows: node['Actual Rows'] }),
      ...(node['Actual Loops'] === undefined ? {} : { actualLoops: node['Actual Loops'] }),
      ...(node['Actual Total Time'] === undefined
        ? {}
        : { actualTotalTimeMs: node['Actual Total Time'] }),
      ...(node['Shared Hit Blocks'] === undefined
        ? {}
        : { sharedHitBlocks: node['Shared Hit Blocks'] }),
      ...(node['Shared Read Blocks'] === undefined
        ? {}
        : { sharedReadBlocks: node['Shared Read Blocks'] }),
      ...(node['Sort Method'] === undefined ? {} : { sortMethod: node['Sort Method'] }),
    });
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(document.Plan);
  return {
    name,
    planningTimeMs: document['Planning Time'],
    executionTimeMs: document['Execution Time'],
    nodes,
  };
}

function requirePlan(
  plan: PlanSummary,
  input: Readonly<{
    maximumExecutionMs: number;
    maximumRootBlocks: number;
    maximumRootRows: number;
    requiredIndexes: readonly string[];
    forbidSort?: boolean;
  }>,
): void {
  const root = plan.nodes[0];
  const rootBlocks = (root?.sharedHitBlocks ?? 0) + (root?.sharedReadBlocks ?? 0);
  if (plan.executionTimeMs > input.maximumExecutionMs)
    throw new Error(
      `${plan.name} exceeded ${input.maximumExecutionMs}ms: ${plan.executionTimeMs}ms.`,
    );
  if (rootBlocks > input.maximumRootBlocks)
    throw new Error(
      `${plan.name} exceeded ${input.maximumRootBlocks} shared blocks: ${rootBlocks}.`,
    );
  if ((root?.actualRows ?? Number.POSITIVE_INFINITY) > input.maximumRootRows)
    throw new Error(
      `${plan.name} exceeded ${input.maximumRootRows} result rows: ${root?.actualRows ?? 'unknown'}.`,
    );
  if (
    !plan.nodes.some(
      (node) => node.index !== undefined && input.requiredIndexes.includes(node.index),
    )
  )
    throw new Error(
      `${plan.name} did not use an approved index: ${input.requiredIndexes.join(', ')}.`,
    );
  if (input.forbidSort && plan.nodes.some((node) => node.nodeType === 'Sort'))
    throw new Error(`${plan.name} introduced an unbounded Sort node.`);
  if (plan.nodes.some((node) => node.nodeType === 'Function Scan'))
    throw new Error(`${plan.name} introduced a function scan.`);
}

function fixturesInCase(
  fixtures: readonly CandidateFixture[],
  matrixCase: LikedByMatrixCase,
): readonly CandidateFixture[] {
  return fixtures.filter((fixture) => fixture.likedByMatrixCase === matrixCase);
}

function accountState(
  matrixCase: LikedByMatrixCase | undefined,
): 'guest' | 'incomplete' | 'active' | 'restricted' | 'banned' | 'deleted' {
  switch (matrixCase) {
    case 'account_guest':
      return 'guest' as const;
    case 'account_incomplete':
      return 'incomplete' as const;
    case 'account_restricted':
      return 'restricted' as const;
    case 'account_banned':
      return 'banned' as const;
    case 'account_deleted':
      return 'deleted' as const;
    default:
      return 'active' as const;
  }
}

function normalizedPair(left: string, right: string): readonly [string, string] {
  return left < right ? [left, right] : [right, left];
}

async function applyLikedByMatrix(
  database: NakhDatabase,
  receiverUserId: string,
  fixtures: readonly CandidateFixture[],
  now: Date,
): Promise<void> {
  for (const [matrixCase, status] of [
    ['like_closed_by_match', 'closed_by_match'],
    ['like_closed_by_not_interested', 'closed_by_not_interested'],
    ['like_closed_by_unmatch', 'closed_by_unmatch'],
    ['like_cancelled_by_system', 'cancelled_by_system'],
  ] as const) {
    const ids = fixturesInCase(fixtures, matrixCase).map(({ likeId }) => likeId);
    if (ids.length > 0)
      await database
        .updateTable('interaction.likes')
        .set({ status, closed_at: now, version: 2 })
        .where('id', 'in', ids)
        .execute();
  }

  const initialPairs = [
    ...fixturesInCase(fixtures, 'pair_matched').map((fixture) => ({
      fixture,
      state: 'matched' as const,
      reasonCode: 'matrix_matched',
    })),
    ...fixturesInCase(fixtures, 'pair_unmatched').map((fixture) => ({
      fixture,
      state: 'matched' as const,
      reasonCode: 'matrix_before_unmatch',
    })),
    ...fixturesInCase(fixtures, 'pair_blocked').map((fixture) => ({
      fixture,
      state: 'blocked' as const,
      reasonCode: 'matrix_blocked',
    })),
  ];
  if (initialPairs.length > 0)
    await database
      .insertInto('interaction.user_pair_states')
      .values(
        initialPairs.map(({ fixture, state, reasonCode }) => {
          const [userLowId, userHighId] = normalizedPair(fixture.userId, receiverUserId);
          return {
            user_low_id: userLowId,
            user_high_id: userHighId,
            state,
            reason_code: reasonCode,
            changed_at: now,
          };
        }),
      )
      .execute();
  for (const fixture of fixturesInCase(fixtures, 'pair_unmatched')) {
    const [userLowId, userHighId] = normalizedPair(fixture.userId, receiverUserId);
    await database
      .updateTable('interaction.user_pair_states')
      .set({ state: 'unmatched', reason_code: 'matrix_unmatched', changed_at: now, version: 2 })
      .where('user_low_id', '=', userLowId)
      .where('user_high_id', '=', userHighId)
      .execute();
  }

  const rejected = fixturesInCase(fixtures, 'receiver_rejected_liker');
  if (rejected.length > 0)
    await database
      .insertInto('interaction.not_interested')
      .values(
        rejected.map(({ userId }) => ({
          id: randomUUID(),
          sender_user_id: receiverUserId,
          receiver_user_id: userId,
          source: 'liked_by' as const,
          created_at: now,
        })),
      )
      .execute();

  const hiddenPhotos = fixturesInCase(fixtures, 'photo_hidden').map(({ photoId }) => photoId);
  if (hiddenPhotos.length > 0)
    await database
      .updateTable('media.profile_photos')
      .set({ status: 'hidden', is_primary: false, hidden_at: now, updated_at: now, version: 2 })
      .where('id', 'in', hiddenPhotos)
      .execute();
  const deletedPhotos = fixturesInCase(fixtures, 'photo_deleted').map(({ photoId }) => photoId);
  if (deletedPhotos.length > 0)
    await database
      .updateTable('media.profile_photos')
      .set({ status: 'deleted', is_primary: false, deleted_at: now, updated_at: now, version: 2 })
      .where('id', 'in', deletedPhotos)
      .execute();
  const missingPhotos = fixturesInCase(fixtures, 'photo_missing').map(({ photoId }) => photoId);
  if (missingPhotos.length > 0)
    await database.deleteFrom('media.profile_photos').where('id', 'in', missingPhotos).execute();

  const deletedAssets = fixturesInCase(fixtures, 'asset_deleted').map(({ assetId }) => assetId);
  if (deletedAssets.length > 0)
    await database
      .updateTable('media.media_assets')
      .set({ deleted_at: now, updated_at: now, version: 2 })
      .where('id', 'in', deletedAssets)
      .execute();
  const storageDeletedAssets = fixturesInCase(fixtures, 'asset_storage_deleted').map(
    ({ assetId }) => assetId,
  );
  if (storageDeletedAssets.length > 0)
    await database
      .updateTable('media.media_assets')
      .set({ deleted_at: now, storage_deleted_at: now, updated_at: now, version: 2 })
      .where('id', 'in', storageDeletedAssets)
      .execute();

  const deletedThumbnails = fixturesInCase(fixtures, 'thumbnail_deleted').map(
    ({ variantId }) => variantId,
  );
  if (deletedThumbnails.length > 0)
    await database
      .updateTable('media.photo_variants')
      .set({ deleted_at: now })
      .where('id', 'in', deletedThumbnails)
      .execute();
  const storageDeletedThumbnails = fixturesInCase(fixtures, 'thumbnail_storage_deleted').map(
    ({ variantId }) => variantId,
  );
  if (storageDeletedThumbnails.length > 0)
    await database
      .updateTable('media.photo_variants')
      .set({ deleted_at: now, storage_deleted_at: now })
      .where('id', 'in', storageDeletedThumbnails)
      .execute();
  const missingThumbnails = fixturesInCase(fixtures, 'thumbnail_missing').map(
    ({ variantId }) => variantId,
  );
  if (missingThumbnails.length > 0)
    await database
      .deleteFrom('media.photo_variants')
      .where('id', 'in', missingThumbnails)
      .execute();
}

function isCapabilityDenied(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'capability_denied'
  );
}

async function requireReceiverDenied(
  store: PostgresLikedByStore,
  receiverUserId: string,
): Promise<void> {
  try {
    await store.readActionablePage({
      actor: { kind: 'user', userId: receiverUserId },
      requestId: randomUUID(),
      limit: 50,
    });
  } catch (error) {
    if (isCapabilityDenied(error)) return;
    throw error;
  }
  throw new Error('ACC-019 receiver authorization unexpectedly permitted Liked By access.');
}

async function verifyLikedByMatrix(
  database: NakhDatabase,
  receiverUserId: string,
  fixtures: readonly CandidateFixture[],
): Promise<Readonly<{ expectedActionable: number; returnedActionable: number; cases: object }>> {
  const store = new PostgresLikedByStore(database);
  const expectedIds = new Set(fixturesInCase(fixtures, 'actionable').map(({ likeId }) => likeId));
  const returnedIds = new Set<string>();
  let after: Readonly<{ createdAt: Date; likeId: string }> | undefined;
  let reportedTotal: number | undefined;
  for (;;) {
    const page = await store.readActionablePage(
      {
        actor: { kind: 'user', userId: receiverUserId },
        requestId: randomUUID(),
        limit: 50,
      },
      after,
    );
    reportedTotal ??= page.totalCount;
    if (page.totalCount !== reportedTotal)
      throw new Error('ACC-019 total changed while reading the stable matrix fixture.');
    for (const row of page.rows) {
      if (returnedIds.has(row.likeId))
        throw new Error('ACC-019 pagination returned a duplicate Like.');
      returnedIds.add(row.likeId);
    }
    if (!page.hasMore) break;
    const last = page.rows.at(-1);
    if (last === undefined) throw new Error('ACC-019 returned an empty page with hasMore=true.');
    after = { createdAt: last.createdAt, likeId: last.likeId };
  }
  if (reportedTotal !== expectedIds.size || returnedIds.size !== expectedIds.size)
    throw new Error(
      `ACC-019 expected ${expectedIds.size} actionable Likes but count/page returned ${reportedTotal}/${returnedIds.size}.`,
    );
  for (const likeId of expectedIds)
    if (!returnedIds.has(likeId)) throw new Error('ACC-019 omitted an actionable control Like.');
  for (const likeId of returnedIds)
    if (!expectedIds.has(likeId)) throw new Error('ACC-019 exposed a prohibited Like.');

  const now = new Date();
  for (const state of ['guest', 'incomplete', 'restricted', 'banned', 'deleted'] as const) {
    await database
      .updateTable('identity.accounts')
      .set({ state, state_changed_at: now })
      .where('user_id', '=', receiverUserId)
      .execute();
    await requireReceiverDenied(store, receiverUserId);
  }
  await database
    .updateTable('identity.accounts')
    .set({ state: 'active', state_changed_at: now })
    .where('user_id', '=', receiverUserId)
    .execute();
  await database
    .updateTable('identity.user_settings')
    .set({ visibility_enabled: false })
    .where('user_id', '=', receiverUserId)
    .execute();
  await requireReceiverDenied(store, receiverUserId);
  await database
    .updateTable('identity.user_settings')
    .set({ visibility_enabled: true })
    .where('user_id', '=', receiverUserId)
    .execute();
  await database
    .updateTable('profile.profiles')
    .set({ completion_status: 'invalid', updated_at: now })
    .where('user_id', '=', receiverUserId)
    .execute();
  await requireReceiverDenied(store, receiverUserId);
  await database
    .updateTable('profile.profiles')
    .set({ completion_status: 'complete', updated_at: now })
    .where('user_id', '=', receiverUserId)
    .execute();

  const cases = Object.fromEntries(
    likedByMatrixCases.map((matrixCase) => [
      matrixCase,
      fixturesInCase(fixtures, matrixCase).length,
    ]),
  );
  if (Object.values(cases).some((count) => count === 0))
    throw new Error('ACC-019 matrix did not seed every prohibited state and actionable control.');
  return { expectedActionable: expectedIds.size, returnedActionable: returnedIds.size, cases };
}

async function seedUsers(
  database: NakhDatabase,
  viewerUserId: string,
  receiverUserId: string,
  fixtures: readonly CandidateFixture[],
): Promise<void> {
  const now = new Date();
  const viewerProfileId = randomUUID();
  const receiverProfileId = randomUUID();
  const baseUsers = [viewerUserId, receiverUserId];
  await database
    .insertInto('identity.users')
    .values(
      baseUsers.map((id) => ({ id, last_activity_at: now, created_at: now, updated_at: now })),
    )
    .execute();
  await database
    .insertInto('identity.accounts')
    .values(
      baseUsers.map((userId) => ({
        user_id: userId,
        state: 'active' as const,
        state_reason: null,
        state_changed_at: now,
      })),
    )
    .execute();
  await database
    .insertInto('identity.user_settings')
    .values(baseUsers.map((userId) => ({ user_id: userId, created_at: now, updated_at: now })))
    .execute();
  await database
    .insertInto('profile.profiles')
    .values([
      {
        id: viewerProfileId,
        user_id: viewerUserId,
        name: 'Synthetic plan viewer',
        birth_year: now.getUTCFullYear() - 30,
        gender_option_id: manGenderId,
        gender_preference_id: womenPreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: cityId,
        highlight: 'Synthetic plan viewer',
        bio: null,
        completion_status: 'complete' as const,
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: receiverProfileId,
        user_id: receiverUserId,
        name: 'Synthetic plan receiver',
        birth_year: now.getUTCFullYear() - 30,
        gender_option_id: manGenderId,
        gender_preference_id: womenPreferenceId,
        relationship_goal_id: relationshipGoalId,
        country_id: countryId,
        province_id: provinceId,
        city_id: cityId,
        highlight: 'Synthetic plan receiver',
        bio: null,
        completion_status: 'complete' as const,
        ever_completed: true,
        completed_at: now,
        created_at: now,
        updated_at: now,
      },
    ])
    .execute();

  const checksum = createHash('sha256').update('synthetic-m3-query-plan').digest();
  for (const batch of chunks(fixtures)) {
    await database
      .insertInto('identity.users')
      .values(
        batch.map(({ userId }) => ({
          id: userId,
          last_activity_at: now,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
    await database
      .insertInto('identity.accounts')
      .values(
        batch.map(({ userId, likedByMatrixCase }) => ({
          user_id: userId,
          state: accountState(likedByMatrixCase),
          state_reason: null,
          state_changed_at: now,
        })),
      )
      .execute();
    await database
      .insertInto('identity.user_settings')
      .values(batch.map(({ userId }) => ({ user_id: userId, created_at: now, updated_at: now })))
      .execute();
    await database
      .insertInto('profile.profiles')
      .values(
        batch.map(({ userId, profileId, likedByMatrixCase }) => {
          const incomplete = likedByMatrixCase === 'profile_incomplete';
          return {
            id: profileId,
            user_id: userId,
            name: 'Synthetic plan candidate',
            birth_year: now.getUTCFullYear() - 30,
            gender_option_id: womanGenderId,
            gender_preference_id: menPreferenceId,
            relationship_goal_id: relationshipGoalId,
            country_id: countryId,
            province_id: provinceId,
            city_id: cityId,
            highlight: 'Synthetic plan candidate',
            bio: null,
            completion_status: incomplete
              ? ('incomplete' as const)
              : likedByMatrixCase === 'profile_invalid'
                ? ('invalid' as const)
                : ('complete' as const),
            ever_completed: !incomplete,
            completed_at: incomplete ? null : now,
            created_at: now,
            updated_at: now,
          };
        }),
      )
      .execute();
    await database
      .insertInto('media.media_assets')
      .values(
        batch.map(({ userId, assetId }) => ({
          id: assetId,
          owner_user_id: userId,
          source_type: 'telegram' as const,
          transport_metadata_ciphertext: null,
          validation_state: 'valid' as const,
          error_code: null,
          detected_media_type: 'image/jpeg',
          size_bytes: 1024,
          width: 600,
          height: 600,
          frame_count: 1,
          original_sha256: checksum,
          normalized_sha256: checksum,
          storage_provider: 'r2' as const,
          quarantine_key: `quarantine/test/${assetId}/original`,
          validated_key: `validated/test/${assetId}/original`,
          quarantine_size_bytes: 1024,
          quarantine_sha256: checksum,
          quarantine_uploaded_at: now,
          ingestion_lease_owner: null,
          ingestion_lease_expires_at: null,
          malware_scan_result: 'clean' as const,
          malware_scanner_version: 'synthetic-plan-scanner',
          malware_signature_version: 'synthetic-plan-signatures',
          malware_scanned_at: now,
          validation_lease_owner: null,
          validation_lease_expires_at: null,
          cleanup_lease_owner: null,
          cleanup_lease_expires_at: null,
          attempted_at: now,
          uploaded_at: now,
          validated_at: now,
          terminal_at: now,
          deleted_at: null,
          storage_deleted_at: null,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
    await database
      .insertInto('media.photo_variants')
      .values(
        batch.map(({ assetId, variantId }) => ({
          id: variantId,
          asset_id: assetId,
          variant_type: 'thumbnail' as const,
          transformation_version: 1,
          storage_provider: 'r2' as const,
          storage_key: `variants/test/${assetId}/thumbnail-v1.webp`,
          delivery_path: `/media/${assetId}/thumbnail-v1.webp`,
          width: 300,
          height: 300,
          sha256: checksum,
          generated_at: now,
          verified_at: now,
          deleted_at: null,
          storage_deleted_at: null,
        })),
      )
      .execute();
    await database
      .insertInto('media.profile_photos')
      .values(
        batch.map(({ profileId, assetId, photoId }) => ({
          id: photoId,
          profile_id: profileId,
          asset_id: assetId,
          status: 'visible' as const,
          is_primary: true,
          display_order: 0,
          created_at: now,
          updated_at: now,
          hidden_at: null,
          deleted_at: null,
        })),
      )
      .execute();
    await database
      .insertInto('interaction.likes')
      .values(
        batch.map(({ userId, likeId, likeReceiverId }, index) => ({
          id: likeId,
          sender_user_id: userId,
          receiver_user_id: likeReceiverId,
          status: 'active' as const,
          created_at: new Date(now.getTime() - index),
          closed_at: null,
        })),
      )
      .execute();
  }
  await applyLikedByMatrix(database, receiverUserId, fixtures, now);
}

await runMigrations(databaseUrl, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url: databaseUrl,
  poolMax: 10,
  statementTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
});

try {
  const viewerUserId = randomUUID();
  const receiverUserId = randomUUID();
  const actionableLikeCount = Math.max(500, Math.floor(configuredVolume / 10));
  const fixtures: CandidateFixture[] = Array.from({ length: configuredVolume }, (_, index) => {
    const received = index < actionableLikeCount;
    return {
      userId: randomUUID(),
      profileId: randomUUID(),
      assetId: randomUUID(),
      photoId: randomUUID(),
      variantId: randomUUID(),
      likeId: randomUUID(),
      likeReceiverId: received ? receiverUserId : viewerUserId,
      ...(received
        ? { likedByMatrixCase: likedByMatrixCases[index % likedByMatrixCases.length]! }
        : {}),
    };
  });
  await seedUsers(database, viewerUserId, receiverUserId, fixtures);
  await analyzeM3QueryTables(database);

  const [candidate, likedBy] = await Promise.all([
    explainCandidatePool(database, {
      actor: { kind: 'user', userId: viewerUserId },
      requestId: randomUUID(),
      mode: 'explore',
    }),
    explainLikedByQueries(database, receiverUserId, 50),
  ]);
  const plans = [
    summarizePlan('candidate_pool', candidate),
    summarizePlan('liked_by_count', likedBy.count),
    summarizePlan('liked_by_page', likedBy.page),
  ];
  const likedByMatrix = await verifyLikedByMatrix(database, receiverUserId, fixtures);
  const artifact = {
    schemaVersion: 1,
    fixture: {
      candidateCount: configuredVolume,
      receivedLikeCount: actionableLikeCount,
      likedByMatrix,
    },
    budgets: {
      candidateMaximumExecutionMs: 1_500,
      likedByCountMaximumExecutionMs: 2_000,
      likedByPageMaximumExecutionMs: 1_000,
      maximumRootBlocks: configuredVolume * 20,
      maximumResultRows: { candidate: 100, likedByCount: 1, likedByPage: 51 },
    },
    plans,
  };
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m3-query-plans.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  );

  requirePlan(plans[0]!, {
    maximumExecutionMs: 1_500,
    maximumRootBlocks: configuredVolume * 20,
    maximumRootRows: 100,
    requiredIndexes: ['profiles_complete_shuffle_idx', 'profiles_complete_global_shuffle_idx'],
    forbidSort: true,
  });
  requirePlan(plans[1]!, {
    maximumExecutionMs: 2_000,
    maximumRootBlocks: configuredVolume * 20,
    maximumRootRows: 1,
    requiredIndexes: ['likes_receiver_status_time_idx'],
  });
  requirePlan(plans[2]!, {
    maximumExecutionMs: 1_000,
    maximumRootBlocks: configuredVolume * 20,
    maximumRootRows: 51,
    requiredIndexes: ['likes_receiver_status_time_idx'],
  });
  process.stdout.write(
    `${JSON.stringify({ scenarios: ['M3-PRODUCTION-QUERY-PLAN', 'ACC-019/M3-LIKED-BY-MATRIX'], volume: configuredVolume, likedByMatrix, plans: plans.map(({ name, executionTimeMs }) => ({ name, executionTimeMs })) })}\n`,
  );
} finally {
  await database.destroy();
}
