import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { sql } from 'kysely';
import { ReportSnapshotKeyRing } from '@nakh/application';
import { createDatabase, type DatabaseConfig, type NakhDatabase } from './database.js';
import {
  captureVpsReadinessBinding,
  observeVpsMachine,
  VPS_READINESS_BINDING_FIELDS,
  withVpsOwnerDatabase,
  type VpsReadinessBinding,
  type VpsMachineIdentity,
} from './vps-launch-readiness.js';
import {
  captureLaunchOperatorRequest,
  launchOperatorCommandDigest,
} from './launch-operator-host.js';
import { PostgresLaunchCohortControl } from './launch-cohort-store.js';
import { measureLaunchHealth } from './launch-health-store.js';
import { prepareLaunchReview, verifyLaunchReviewReference } from './launch-review.js';
import { captureOperatorCommand, checkTotpCustody } from './admin-totp-operator-host.js';
import { PostgresAdminTotpOperator } from './admin-totp-operator-store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
function denied(): never {
  throw new Error('Private VPS operator unavailable.');
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
export type VpsOperatorBinding = VpsReadinessBinding &
  Readonly<{
    operatorId: string;
    approvedCommandDigest: string | null;
  }>;
export type VpsMfaOperatorBinding = VpsOperatorBinding &
  Readonly<{
    totpSecretPath: string;
    keyId: string;
    keyVersion: number;
  }>;
function baseOf(c: VpsReadinessBinding): VpsReadinessBinding {
  return captureVpsReadinessBinding(
    Object.fromEntries(VPS_READINESS_BINDING_FIELDS.map((key) => [key, c[key]])),
  );
}
function captureBinding(value: unknown, extra: readonly string[]): Record<string, unknown> {
  const c = object(structuredClone(value));
  const fields = [...VPS_READINESS_BINDING_FIELDS, 'operatorId', 'approvedCommandDigest', ...extra];
  if (Object.keys(c).length !== fields.length || fields.some((key) => !Object.hasOwn(c, key)))
    denied();
  captureVpsReadinessBinding(
    Object.fromEntries(VPS_READINESS_BINDING_FIELDS.map((key) => [key, c[key]])),
  );
  if (
    typeof c.operatorId !== 'string' ||
    !UUID.test(c.operatorId) ||
    (c.approvedCommandDigest !== null &&
      (typeof c.approvedCommandDigest !== 'string' || !HASH.test(c.approvedCommandDigest)))
  )
    denied();
  c.operatorId = c.operatorId.toLowerCase();
  return c;
}
export function captureVpsOperatorBinding(value: unknown): VpsOperatorBinding {
  return Object.freeze(captureBinding(value, [])) as VpsOperatorBinding;
}
export function captureVpsMfaOperatorBinding(value: unknown): VpsMfaOperatorBinding {
  const c = captureBinding(value, ['totpSecretPath', 'keyId', 'keyVersion']);
  if (
    typeof c.totpSecretPath !== 'string' ||
    !isAbsolute(c.totpSecretPath) ||
    /[\r\n\0]/u.test(c.totpSecretPath) ||
    c.totpSecretPath === c.databaseSecretPath ||
    typeof c.keyId !== 'string' ||
    !/^[A-Za-z0-9_-]{8,160}$/u.test(c.keyId) ||
    !Number.isSafeInteger(c.keyVersion) ||
    Number(c.keyVersion) < 1
  )
    denied();
  return Object.freeze(c) as VpsMfaOperatorBinding;
}
/** Canonical field order is independent of the private request file's formatting.
 * This binds an approval intent; it is not proof that a human approved it. */
export function vpsMfaCommandDigest(value: unknown): string {
  const request = captureOperatorCommand(value),
    input = request.input;
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.operation,
        input.actorUserId,
        input.requestId,
        input.reasonCode,
        request.operation === 'approve' ? request.input.roles : request.input.credentialId,
      ]),
    )
    .digest('hex');
}

/** Staging-only, max ten original-life members. Opening requires both the exact
 * protected command approval and a fresh reviewed dossier. Stop/recovery remain
 * independent. No AWS principal or production qualification is manufactured. */
export async function runVpsLaunchOperator(
  binding: unknown,
  command: unknown,
  readSecret: (path: string) => Promise<unknown>,
  observe: () => Promise<VpsMachineIdentity> = observeVpsMachine,
  connect: (config: DatabaseConfig) => NakhDatabase = createDatabase,
): Promise<unknown> {
  try {
    const c = captureVpsOperatorBinding(binding),
      request = captureLaunchOperatorRequest(command);
    const intent =
      request.operation === 'prepare-review'
        ? request.intent
        : request.operation === 'apply' ||
            request.operation === 'apply-reviewed' ||
            request.operation === 'receipt'
          ? request.input
          : undefined;
    if (
      intent &&
      (intent.sourceSha !== c.sourceSha ||
        intent.environment !== c.environment ||
        intent.telegramBotId !== c.telegramBotId ||
        intent.members.length > 10)
    )
      denied();
    if (request.operation === 'apply' && request.input.mode === 'cohort') denied();
    if (request.operation === 'apply-reviewed') {
      if (launchOperatorCommandDigest(request) !== c.approvedCommandDigest) denied();
      if (object(object(request.review).dossier).operatorId !== c.operatorId) denied();
      verifyLaunchReviewReference(request.review, request.input, new Date());
    }
    return await withVpsOwnerDatabase(
      baseOf(c),
      readSecret,
      async (database, authenticate) => {
        const control = new PostgresLaunchCohortControl(database, { operatorId: c.operatorId });
        if (request.operation === 'receipt') return control.receipt(request.input);
        if (request.operation === 'health' || request.operation === 'prepare-review') {
          const health = await measureLaunchHealth(database, {
            sourceSha: c.sourceSha,
            environment: c.environment,
            telegramBotId: c.telegramBotId,
          });
          return request.operation === 'health'
            ? health
            : prepareLaunchReview(health, request, c.operatorId);
        }
        if (request.operation === 'apply' || request.operation === 'apply-reviewed') {
          await authenticate();
          let deadline: string | undefined;
          if (request.operation === 'apply-reviewed') {
            verifyLaunchReviewReference(request.review, request.input, new Date());
            deadline = String(object(object(request.review).dossier).expiresAt);
          }
          return control.apply(request.input, deadline);
        }
        if (request.operation === 'resolve-member')
          return (
            (await database
              .selectFrom('identity.telegram_identities as telegram')
              .innerJoin('identity.accounts as account', 'account.user_id', 'telegram.user_id')
              .select(['account.user_id as userId', 'account.product_epoch as productEpoch'])
              .where('telegram.telegram_user_id', '=', request.telegramUserId)
              .where('account.state', '!=', 'deleted')
              .executeTakeFirst()) ?? null
          );
        const policy = (
          await sql<{
            policyId: string;
            version: string | null;
            mode: string;
            metadata: Record<string, unknown>;
          }>`SELECT id AS "policyId", platform.launch_policy_version(id)::text AS version,
        result_code AS mode,metadata FROM platform.audit_logs
        WHERE event_type='platform.launch-policy-applied.v1'
        ORDER BY ((metadata->>'version')::bigint) DESC LIMIT 1`.execute(database)
        ).rows[0];
        if (!policy) return null;
        if (policy.version === null) denied();
        return {
          policyId: policy.policyId,
          version: Number(policy.version),
          mode: policy.mode,
          sourceSha: policy.metadata.sourceSha,
          environment: policy.metadata.environment,
          telegramBotId: policy.metadata.telegramBotId,
          expiresAt: policy.metadata.expiresAt,
          cohortSize: policy.metadata.cohortSize,
          reviewDigest: policy.metadata.reviewDigest,
        };
      },
      observe,
      connect,
    );
  } catch {
    return denied();
  }
}

/** Native MFA provisioning retains historical key custody and mandatory audit
 * checks. A protected exact approval is needed to grant roles/enrollment; a
 * trusted revocation does not depend on an opening approval. */
export async function runVpsMfaOperator(
  binding: unknown,
  command: unknown,
  readSecret: (path: string) => Promise<unknown>,
  observe: () => Promise<VpsMachineIdentity> = observeVpsMachine,
  connect: (config: DatabaseConfig) => NakhDatabase = createDatabase,
): Promise<unknown> {
  try {
    const c = captureVpsMfaOperatorBinding(binding),
      request = captureOperatorCommand(command);
    if (request.operation === 'approve' && vpsMfaCommandDigest(request) !== c.approvedCommandDigest)
      denied();
    return await withVpsOwnerDatabase(
      baseOf(c),
      readSecret,
      async (database, authenticate) => {
        let operator: PostgresAdminTotpOperator | undefined, writeKey: Uint8Array | undefined;
        try {
          await authenticate();
          const contents = await readSecret(c.totpSecretPath);
          const keys = new ReportSnapshotKeyRing(JSON.stringify(contents));
          const encryption = keys.writeKey(c.keyId, c.keyVersion);
          writeKey = encryption.key;
          await authenticate();
          await checkTotpCustody(database, keys);
          await authenticate();
          operator = new PostgresAdminTotpOperator(
            database,
            { operatorId: c.operatorId },
            encryption,
            keys,
          );
          return request.operation === 'approve'
            ? await operator.approve(request.input)
            : await operator.revokeCredential(request.input);
        } finally {
          operator?.dispose();
          writeKey?.fill(0);
        }
      },
      observe,
      connect,
    );
  } catch {
    return denied();
  }
}
