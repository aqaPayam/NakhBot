import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  analyzeM3QueryTables,
  createDatabase,
  explainCandidatePool,
  explainLikedByQueries,
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

type CandidateFixture = Readonly<{
  userId: string;
  profileId: string;
  assetId: string;
  photoId: string;
  variantId: string;
  likeId: string;
  likeReceiverId: string;
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
    requiredIndex: string;
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
  if (!plan.nodes.some((node) => node.index === input.requiredIndex))
    throw new Error(`${plan.name} did not use required index ${input.requiredIndex}.`);
  if (input.forbidSort && plan.nodes.some((node) => node.nodeType === 'Sort'))
    throw new Error(`${plan.name} introduced an unbounded Sort node.`);
  if (plan.nodes.some((node) => node.nodeType === 'Function Scan'))
    throw new Error(`${plan.name} introduced a function scan.`);
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
        batch.map(({ userId }) => ({
          user_id: userId,
          state: 'active' as const,
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
        batch.map(({ userId, profileId }) => ({
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
          completion_status: 'complete' as const,
          ever_completed: true,
          completed_at: now,
          created_at: now,
          updated_at: now,
        })),
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
  const fixtures: CandidateFixture[] = Array.from({ length: configuredVolume }, (_, index) => ({
    userId: randomUUID(),
    profileId: randomUUID(),
    assetId: randomUUID(),
    photoId: randomUUID(),
    variantId: randomUUID(),
    likeId: randomUUID(),
    likeReceiverId: index < actionableLikeCount ? receiverUserId : viewerUserId,
  }));
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
  const artifact = {
    schemaVersion: 1,
    fixture: { candidateCount: configuredVolume, actionableLikeCount },
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
    requiredIndex: 'profiles_complete_global_shuffle_idx',
    forbidSort: true,
  });
  requirePlan(plans[1]!, {
    maximumExecutionMs: 2_000,
    maximumRootBlocks: configuredVolume * 20,
    maximumRootRows: 1,
    requiredIndex: 'likes_receiver_status_time_idx',
  });
  requirePlan(plans[2]!, {
    maximumExecutionMs: 1_000,
    maximumRootBlocks: configuredVolume * 20,
    maximumRootRows: 51,
    requiredIndex: 'likes_receiver_status_time_idx',
  });
  process.stdout.write(
    `${JSON.stringify({ scenario: 'M3-PRODUCTION-QUERY-PLAN', volume: configuredVolume, plans: plans.map(({ name, executionTimeMs }) => ({ name, executionTimeMs })) })}\n`,
  );
} finally {
  await database.destroy();
}
