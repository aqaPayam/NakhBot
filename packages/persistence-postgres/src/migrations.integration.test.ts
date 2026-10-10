import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations, verifyMigrations } from './migrations.js';
import { createDatabase } from './database.js';
import { createReportFixtureAdmin } from './testing/report-fixture.js';
import { createAdminTotpEnrollment, adminTotpStep } from '@nakh/application';
import { createDeletionFixture } from './testing/deletion-fixture.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { PostgresAccountDeletionCheckpointStore } from './account-deletion-checkpoint-store.js';
import { PostgresAccountDeletionProductStore } from './account-deletion-product-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';
import type { AccountDeletionLease } from '@nakh/application';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('PostgreSQL migration bootstrap and M7 upgrade', () => {
  it.each([
    45, 51, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
    78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
    101, 102,
  ])('upgrades from migration %i and preserves legacy appeal identity', async (baseline) => {
    const name = `nakh_appeal_upgrade_${randomUUID().replaceAll('-', '')}`;
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${name}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const previousDirectory = await mkdtemp(join(tmpdir(), 'nakh-appeal-upgrade-'));
    const directory = resolve(process.cwd(), 'migrations');
    let target: pg.Pool | undefined;
    let created = false;
    const userId = randomUUID(),
      historyId = randomUUID(),
      appealId = randomUUID(),
      legacyEpisodeId = randomUUID(),
      legacySessionId = randomUUID();
    let previousFactor: Record<string, unknown> | undefined;
    let previousPayment:
      | {
          payerId: string;
          intentId: string;
          paymentId: string;
          intent: Record<string, unknown>;
          payment: Record<string, unknown>;
          receipt: Record<string, unknown>;
        }
      | undefined;
    let previousPairFunction: Record<string, unknown> | undefined;
    let pendingProductLease: AccountDeletionLease | undefined;
    let previousDeletion:
      | { recordId: string; record: Record<string, unknown>; work: Record<string, unknown> }
      | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      for (const filename of await readdir(directory)) {
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(filename) && Number(filename.slice(0, 6)) <= baseline)
          await copyFile(join(directory, filename), join(previousDirectory, filename));
      }
      expect((await runMigrations(targetUrl.toString(), previousDirectory)).applied).toHaveLength(
        baseline,
      );
      target = new pg.Pool({ connectionString: targetUrl.toString() });
      if (baseline >= 85) {
        const legacy = createDatabase({
          url: targetUrl.toString(),
          poolMax: 2,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 1000,
        });
        try {
          const fixture = await createDeletionFixture(legacy);
          if (baseline >= 86) {
            const leases = await new PostgresAccountDeletionWorkStore(legacy).claimDue({
              workerId: randomUUID(),
              limit: 1,
              leaseMs: 120000,
            });
            expect(leases).toHaveLength(1);
            if (baseline >= 87)
              await new PostgresAccountDeletionCheckpointStore(legacy).finishShared(leases[0]!);
            if (baseline >= 95) {
              const work = new PostgresAccountDeletionWorkStore(legacy);
              const [evidence] = await work.claimDue({
                workerId: randomUUID(),
                limit: 1,
                leaseMs: 120000,
              });
              await new PostgresAccountDeletionCheckpointStore(legacy).finishEvidence(evidence!);
              const product = await work.claimDue({
                workerId: randomUUID(),
                limit: 1,
                leaseMs: 120000,
              });
              expect(product).toHaveLength(1);
              pendingProductLease = product[0]!;
            }
          }
          previousDeletion = {
            recordId: fixture.recordId,
            record: (
              await target.query<Record<string, unknown>>(
                'SELECT * FROM identity.account_deletion_records WHERE id=$1',
                [fixture.recordId],
              )
            ).rows[0]!,
            work: (
              await target.query<Record<string, unknown>>(
                'SELECT * FROM identity.account_deletion_work WHERE deletion_record_id=$1',
                [fixture.recordId],
              )
            ).rows[0]!,
          };
          if (baseline === 86) {
            await target.query(
              'UPDATE identity.account_deletion_records SET shared_closed_at=clock_timestamp() WHERE id=$1',
              [fixture.recordId],
            );
            await expect(runMigrations(targetUrl.toString(), directory)).rejects.toThrow(
              'legacy deletion progress lacks verified receipt',
            );
            await target.query(
              'UPDATE identity.account_deletion_records SET shared_closed_at=NULL WHERE id=$1',
              [fixture.recordId],
            );
          }
        } finally {
          await legacy.destroy();
        }
      }
      if (baseline === 83) {
        previousPairFunction = (
          await target.query<Record<string, unknown>>(
            "SELECT prosrc,provolatile,proisstrict,prosecdef FROM pg_proc WHERE oid='moderation.admin_pair_target_id(uuid,uuid)'::regprocedure",
          )
        ).rows[0]!;
      }
      if (baseline === 81) {
        const legacy = createDatabase({
          url: targetUrl.toString(),
          poolMax: 2,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 1000,
        });
        try {
          const adminId = await createReportFixtureAdmin(legacy);
          // Historical external-provider grant: migration must preserve it without inventing TOTP provenance.
          await target.query(
            `INSERT INTO administration.admin_sessions
            (id,admin_user_id,admin_version,token_hash,mfa_proof_id,issued_at,expires_at,mfa_verified_at,mfa_expires_at)
            VALUES($1,$2,1,repeat('c',64),$3,now(),now()+interval '15 minutes',now(),now()+interval '5 minutes')`,
            [legacySessionId, adminId, randomUUID()],
          );
        } finally {
          await legacy.destroy();
        }
      }
      if (baseline === 82) {
        const legacy = createDatabase({
          url: targetUrl.toString(),
          poolMax: 2,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 1000,
        });
        const key = randomBytes(32);
        try {
          const adminId = await createReportFixtureAdmin(legacy);
          const owner = await legacy
            .selectFrom('administration.admin_users')
            .select('user_id')
            .where('id', '=', adminId)
            .executeTakeFirstOrThrow();
          const id = randomUUID(),
            auditId = randomUUID();
          const at = (await target.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!
            .at;
          const { secret } = createAdminTotpEnrollment(
            { actorUserId: owner.user_id, credentialId: id },
            { keyId: 'migration-mfa-key', keyVersion: 1, key },
          );
          // Existing confirmed native envelope. Upgrade must retain bytes, counter and activation audit.
          await target.query(
            `INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,request_id,command_id,occurred_at)
            VALUES($1,'security','administration.totp-activated.v1','user',$2,'admin_totp_credential',$3,'activated',1,'{}',$4,$5,$6)`,
            [auditId, owner.user_id, id, randomUUID(), randomUUID(), at],
          );
          await target.query(
            `INSERT INTO administration.admin_totp_credentials(id,admin_user_id,ciphertext,nonce,key_id,key_version,activated_at,activation_audit_id,last_used_step)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              id,
              adminId,
              Buffer.from(secret.ciphertext),
              Buffer.from(secret.nonce),
              secret.keyId,
              secret.keyVersion,
              at,
              auditId,
              adminTotpStep(at),
            ],
          );
          previousFactor = (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM administration.admin_totp_credentials WHERE id=$1',
              [id],
            )
          ).rows[0]!;
        } finally {
          key.fill(0);
          await legacy.destroy();
        }
      }
      if (baseline === 51) {
        await target.query(
          'INSERT INTO identity.users (id, last_activity_at, created_at, updated_at) VALUES ($1, now(), now(), now())',
          [userId],
        );
        await target.query(
          "INSERT INTO identity.accounts (user_id, state, state_reason, state_changed_at) VALUES ($1, 'banned', 'test_ban', now())",
          [userId],
        );
        await target.query(
          "INSERT INTO identity.account_state_history (id, user_id, previous_state, next_state, reason_code, actor_type, changed_at) SELECT $1, user_id, 'active', 'banned', 'test_ban', 'system', state_changed_at FROM identity.accounts WHERE user_id = $2",
          [historyId, userId],
        );
        await target.query(
          'INSERT INTO moderation.user_appeals (id, user_id, ban_state_history_id, message_text) VALUES ($1, $2, $3, $4)',
          [appealId, userId, historyId, 'Legacy restricted appeal'],
        );
      }
      if (baseline === 78) {
        // A deliberately minimal historical fixture tests preservation, never reconstructed proof.
        const reporterId = randomUUID(),
          targetId = randomUUID(),
          reportId = randomUUID();
        await target.query('BEGIN');
        try {
          await target.query(
            'INSERT INTO identity.users(id,last_activity_at,created_at,updated_at) SELECT unnest($1::uuid[]),now(),now(),now()',
            [[reporterId, targetId]],
          );
          // Preserve ordinary identity counters before bypassing only historical safety fixtures.
          await target.query('SET LOCAL session_replication_role=replica');
          await target.query(
            "INSERT INTO moderation.reports(id,reporter_user_id,target_user_id,reason_id,status,command_id,request_id,idempotency_key,request_digest) SELECT $1,$2,$3,id,'pending_review',$4,$5,$6,repeat('a',64) FROM moderation.report_reasons WHERE code='harassment'",
            [reportId, reporterId, targetId, randomUUID(), randomUUID(), randomUUID()],
          );
          await target.query(
            'INSERT INTO moderation.restriction_episodes(id,target_user_id,source_report_id,distinct_reporter_count) VALUES($1,$2,$3,5)',
            [legacyEpisodeId, targetId, reportId],
          );
          await target.query('COMMIT');
        } catch (error) {
          await target.query('ROLLBACK');
          throw error;
        }
      }
      if (baseline === 96) {
        const payerId = randomUUID(),
          intentId = randomUUID(),
          paymentId = randomUUID();
        await target.query(
          'INSERT INTO identity.users(id,last_activity_at,created_at,updated_at) VALUES($1,now(),now(),now())',
          [payerId],
        );
        await target.query(
          "INSERT INTO identity.accounts(user_id,state,state_changed_at) VALUES($1,'active',now())",
          [payerId],
        );
        await target.query(
          'INSERT INTO billing.credit_accounts(user_id,created_at,updated_at) VALUES($1,now(),now())',
          [payerId],
        );
        await target.query(
          'INSERT INTO notification.notification_preferences(user_id,created_at,updated_at) VALUES($1,now(),now())',
          [payerId],
        );
        // Historical SQL shape deliberately omits the not-yet-existing epoch column.
        await target.query(
          `INSERT INTO billing.pending_payments(id,user_id,reason,target_type,target_id,funding_type,
          required_stars,package_code_snapshot,package_credit_amount_snapshot,status,idempotency_key,request_hash,expires_at,resolved_at)
          SELECT $1,$2,'buy_credit_package','credit_package',id,'telegram_stars',stars_price,code,credit_amount,
            'paid',$3,repeat('d',64),now()+interval '1 hour',now() FROM billing.credit_packages WHERE code='starter'`,
          [intentId, payerId, `upgrade-intent:${intentId}`],
        );
        await target.query(
          `INSERT INTO billing.payment_records(id,user_id,pending_payment_id,payment_type,credit_package_id,
          package_code_snapshot,package_credit_amount_snapshot,status,stars_amount,provider,provider_environment,provider_bot_id_digest,
          invoice_payload_digest,invoice_payload_ciphertext,invoice_payload_key_id,provider_payment_id,idempotency_key,request_hash,paid_at)
          SELECT $1,$2,$3,'buy_credit_package',id,code,credit_amount,'paid',stars_price,'telegram_stars','test',repeat('b',64),
            repeat('c',64),decode(repeat('ab',64),'hex'),'upgrade-key',$4,$5,repeat('d',64),now()
          FROM billing.credit_packages WHERE code='starter'`,
          [
            paymentId,
            payerId,
            intentId,
            `upgrade-charge:${paymentId}`,
            `upgrade-payment:${paymentId}`,
          ],
        );
        await target.query(
          `INSERT INTO billing.telegram_stars_receipts(payment_record_id,provider_event_id,telegram_charge_id,payer_user_id,stars_amount)
          VALUES($1,$2,$3,$4,10)`,
          [paymentId, `upgrade-event:${paymentId}`, `upgrade-charge:${paymentId}`, payerId],
        );
        await target.query(
          'INSERT INTO billing.payment_fulfillments(payment_record_id) VALUES($1)',
          [paymentId],
        );
        previousPayment = {
          payerId,
          intentId,
          paymentId,
          intent: (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM billing.pending_payments WHERE id=$1',
              [intentId],
            )
          ).rows[0]!,
          payment: (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM billing.payment_records WHERE id=$1',
              [paymentId],
            )
          ).rows[0]!,
          receipt: (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM billing.telegram_stars_receipts WHERE payment_record_id=$1',
              [paymentId],
            )
          ).rows[0]!,
        };
      }
      expect((await runMigrations(targetUrl.toString(), directory)).applied).toHaveLength(
        103 - baseline,
      );
      await verifyMigrations(targetUrl.toString(), join(directory, 'verify'));
      if (previousPayment !== undefined) {
        const saved = previousPayment;
        expect(
          (
            await target.query('SELECT * FROM billing.pending_payments WHERE id=$1', [
              saved.intentId,
            ])
          ).rows,
        ).toEqual([{ ...saved.intent, product_epoch: 0 }]);
        expect(
          (
            await target.query('SELECT * FROM billing.payment_records WHERE id=$1', [
              saved.paymentId,
            ])
          ).rows,
        ).toEqual([saved.payment]);
        expect(
          (
            await target.query(
              'SELECT * FROM billing.telegram_stars_receipts WHERE payment_record_id=$1',
              [saved.paymentId],
            )
          ).rows,
        ).toEqual([saved.receipt]);
        expect(
          (
            await target.query('SELECT product_epoch FROM identity.accounts WHERE user_id=$1', [
              saved.payerId,
            ])
          ).rows,
        ).toEqual([{ product_epoch: 0 }]);
        const upgraded = createDatabase({
          url: targetUrl.toString(),
          poolMax: 2,
          statementTimeoutMs: 5000,
          lockTimeoutMs: 1000,
        });
        try {
          const store = PostgresTelegramStarsReceiptStore.forFulfillment(upgraded);
          const [claim] = await store.claimFulfillments({
            owner: 'upgrade-package',
            leaseMs: 60000,
            limit: 100,
          });
          expect(claim?.paymentRecordId).toBe(saved.paymentId);
          await expect(
            store.fulfillCreditPackage({
              ...claim!,
              owner: 'upgrade-package',
              creditTransactionId: randomUUID(),
              creditIncreasedEventId: randomUUID(),
              paymentFulfilledEventId: randomUUID(),
              refundRecordId: randomUUID(),
            }),
          ).resolves.toMatchObject({ outcome: 'fulfilled', balanceAfter: 10n, replayed: false });
        } finally {
          await upgraded.destroy();
        }
      }
      if (previousDeletion !== undefined) {
        expect(
          (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM identity.account_deletion_records WHERE id=$1',
              [previousDeletion.recordId],
            )
          ).rows,
        ).toEqual([{ ...previousDeletion.record, product_epoch: 0 }]);
        expect(
          (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM identity.account_deletion_work WHERE deletion_record_id=$1',
              [previousDeletion.recordId],
            )
          ).rows,
        ).toEqual([
          baseline === 85
            ? { ...previousDeletion.work, lease_generation: 0 }
            : previousDeletion.work,
        ]);
        if (pendingProductLease !== undefined) {
          const upgraded = createDatabase({
            url: targetUrl.toString(),
            poolMax: 2,
            statementTimeoutMs: 5000,
            lockTimeoutMs: 1000,
          });
          try {
            expect(
              await new PostgresAccountDeletionProductStore(upgraded).purgeNext(
                pendingProductLease,
              ),
            ).toEqual({ purgedRows: 1, hasMore: true });
          } finally {
            await upgraded.destroy();
          }
        }
      }
      if (baseline === 83) {
        expect(
          (
            await target.query<Record<string, unknown>>(
              "SELECT prosrc,provolatile,proisstrict,prosecdef FROM pg_proc WHERE oid='moderation.admin_pair_target_id(uuid,uuid)'::regprocedure",
            )
          ).rows,
        ).toEqual([previousPairFunction]);
      }
      if (baseline === 81) {
        expect(
          (
            await target.query(
              'SELECT totp_credential_id FROM administration.admin_sessions WHERE id=$1',
              [legacySessionId],
            )
          ).rows,
        ).toEqual([{ totp_credential_id: null }]);
        expect(
          (await target.query('SELECT id FROM administration.admin_totp_credentials')).rows,
        ).toEqual([]);
        expect(
          (await target.query('SELECT id FROM administration.admin_totp_proofs')).rows,
        ).toEqual([]);
      }
      if (baseline === 82) {
        expect(
          (
            await target.query<Record<string, unknown>>(
              'SELECT * FROM administration.admin_totp_credentials WHERE id=$1',
              [previousFactor!.id],
            )
          ).rows,
        ).toEqual([previousFactor]);
        expect(
          (await target.query('SELECT id FROM administration.admin_totp_enrollments')).rows,
        ).toEqual([]);
        expect(
          (await target.query('SELECT request_id FROM administration.admin_totp_operator_commands'))
            .rows,
        ).toEqual([]);
      }
      if (baseline === 78) {
        const legacy = await target.query<{
          witness_required: boolean;
          witness_capture_xid: string | null;
        }>(
          'SELECT witness_required,witness_capture_xid FROM moderation.restriction_episodes WHERE id=$1',
          [legacyEpisodeId],
        );
        expect(legacy.rows).toEqual([{ witness_required: false, witness_capture_xid: null }]);
        expect(
          (
            await target.query(
              'SELECT report_id FROM moderation.threshold_admission_witnesses WHERE restriction_episode_id=$1',
              [legacyEpisodeId],
            )
          ).rows,
        ).toEqual([]);
      }
      expect((await runMigrations(targetUrl.toString(), directory)).applied).toEqual([]);
      if (baseline === 51) {
        const result = await target.query(
          'SELECT id, ban_state_history_id, status, version FROM moderation.user_appeals WHERE id = $1',
          [appealId],
        );
        expect(result.rows).toEqual([
          { id: appealId, ban_state_history_id: historyId, status: 'submitted', version: 1 },
        ]);
        await expect(
          target.query(
            'INSERT INTO moderation.user_appeals (id, user_id, ban_state_history_id, message_text) VALUES ($1, $2, $3, $4)',
            [randomUUID(), userId, historyId, 'Duplicate'],
          ),
        ).rejects.toThrow();
      }
    } finally {
      await target?.end();
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
        await rm(previousDirectory, { recursive: true, force: true });
      }
    }
  });
  it('serializes empty-database bootstrap, upgrades M1, verifies, and replays unchanged', async () => {
    // This suite needs CREATEDB on the disposable CI database server.
    const name = `nakh_migration_${randomUUID().replaceAll('-', '')}`;
    const targetUrl = new URL(databaseUrl!);
    targetUrl.pathname = `/${name}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const previousDirectory = await mkdtemp(join(tmpdir(), 'nakh-m1-migrations-'));
    const directory = resolve(process.cwd(), 'migrations');
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      for (const filename of await readdir(directory)) {
        if (/^00000[1-9]_[a-z0-9_]+\.sql$/u.test(filename))
          await copyFile(join(directory, filename), join(previousDirectory, filename));
      }
      const bootstrap = await Promise.all([
        runMigrations(targetUrl.toString(), previousDirectory),
        runMigrations(targetUrl.toString(), previousDirectory),
      ]);
      expect(bootstrap.map((result) => result.applied.length).sort((a, b) => a - b)).toEqual([
        0, 9,
      ]);
      const upgrade = await runMigrations(targetUrl.toString(), directory);
      expect(upgrade.applied).toEqual([
        '000010_m2_media_assets.sql',
        '000011_m2_profile_photos.sql',
        '000012_m2_media_quarantine.sql',
        '000013_m2_media_jobs.sql',
        '000014_m2_media_validation.sql',
        '000015_m2_media_cleanup.sql',
        '000016_m2_localization.sql',
        '000017_m3_discovery.sql',
        '000018_m3_interactions.sql',
        '000019_m3_matching.sql',
        '000020_m3_candidate_query.sql',
        '000021_m3_localization.sql',
        '000022_m3_telegram_delivery.sql',
        '000023_m3_telegram_delivery_receipts.sql',
        '000024_m3_telegram_receipt_key.sql',
        '000025_m4_credit_ledger.sql',
        '000026_m4_payment_intents.sql',
        '000027_m4_provider_receipts.sql',
        '000028_m4_feature_unlocks.sql',
        '000029_m4_notifications_refunds.sql',
        '000030_m4_localization.sql',
        '000031_m5_nakh_flows.sql',
        '000032_m5_pending_nakhes.sql',
        '000033_m5_delivered_nakhes.sql',
        '000034_m5_billing_matching.sql',
        '000035_m5_localization.sql',
        '000036_m5_reconciliation.sql',
        '000037_m5_query_plans.sql',
        '000038_m5_flow_lookup.sql',
        '000039_m5_ordered_flow_lookup.sql',
        '000040_m6_chat_catalog_messages.sql',
        '000041_m6_unmatch.sql',
        '000042_m6_notification_delivery.sql',
        '000043_m6_chat_retention.sql',
        '000044_m6_localization.sql',
        '000045_m6_reconciliation.sql',
        '000046_m7_reports.sql',
        '000047_m7_report_evidence.sql',
        '000048_m7_threshold_reviews_actions.sql',
        '000049_m7_review_consistency_fix.sql',
        '000050_m7_administration.sql',
        '000051_m7_support_appeals.sql',
        '000052_m7_appeal_admission.sql',
        '000053_m7_appeal_unban.sql',
        '000054_m7_localization.sql',
        '000055_m7_review_decisions.sql',
        '000056_m7_action_report_scope.sql',
        '000057_m7_evidence_access_identity.sql',
        '000058_m7_unmatch_report_deadline.sql',
        '000059_m7_photo_evidence_holds.sql',
        '000060_m7_photo_evidence_cleanup.sql',
        '000061_m7_photo_capture_complete.sql',
        '000062_m7_reconciliation.sql',
        '000063_m7_operational_indexes.sql',
        '000064_m7_admin_queue_localization.sql',
        '000065_m7_admin_support_mutation_localization.sql',
        '000066_m7_admin_appeal_review_localization.sql',
        '000067_m7_admin_appeal_unban_localization.sql',
        '000068_m7_admin_report_assignment_localization.sql',
        '000069_m7_admin_report_decision_localization.sql',
        '000070_m7_admin_report_account_localization.sql',
        '000071_m7_admin_report_evidence_localization.sql',
        '000072_m7_admin_report_photo_localization.sql',
        '000073_m7_admin_evidence_read_localization.sql',
        '000074_m7_report_internal_block_scope.sql',
        '000075_m7_admin_report_block_localization.sql',
        '000076_m7_integrity_history_index.sql',
        '000077_m7_admin_sessions.sql',
        '000078_m7_episode_resolution_index.sql',
        '000079_m7_threshold_admission_witnesses.sql',
        '000080_m7_snapshot_shape_projection.sql',
        '000081_m7_restoration_history_index.sql',
        '000082_m7_admin_totp.sql',
        '000083_m7_admin_totp_enrollment.sql',
        '000084_m7_parallel_pair_target.sql',
        '000085_m8_deletion_admission.sql',
        '000086_m8_deletion_work_fences.sql',
        '000087_m8_shared_checkpoint.sql',
        '000088_m8_shared_payment_proof.sql',
        '000089_m8_capture_verification.sql',
        '000090_m8_profile_archival.sql',
        '000091_m8_chat_archival.sql',
        '000092_m8_match_references.sql',
        '000093_m8_match_archival.sql',
        '000094_m8_photo_archival.sql',
        '000095_m8_evidence_checkpoint.sql',
        '000096_m8_product_batches.sql',
        '000097_m8_payment_lifecycle.sql',
        '000098_m8_media_delivery_authority.sql',
        '000099_m8_credit_lifecycle_provenance.sql',
        '000100_m8_deletion_lifecycle_binding.sql',
        '000101_m8_credit_epoch_partition.sql',
        '000102_m8_support_epoch_closure.sql',
        '000103_m8_support_closure_proof_view.sql',
      ]);
      expect(upgrade.existing).toHaveLength(9);
      const verified = await verifyMigrations(targetUrl.toString(), join(directory, 'verify'));
      expect(verified).toContain('000010_m2_media_assets.sql');
      expect(verified).toContain('000011_m2_profile_photos.sql');
      expect(verified).toContain('000012_m2_media_quarantine.sql');
      expect(verified).toContain('000013_m2_media_jobs.sql');
      expect(verified).toContain('000014_m2_media_validation.sql');
      expect(verified).toContain('000015_m2_media_cleanup.sql');
      expect(verified).toContain('000016_m2_localization.sql');
      expect(verified).toContain('000017_m3_discovery.sql');
      expect(verified).toContain('000018_m3_interactions.sql');
      expect(verified).toContain('000019_m3_matching.sql');
      expect(verified).toContain('000020_m3_candidate_query.sql');
      expect(verified).toContain('000021_m3_localization.sql');
      expect(verified).toContain('000022_m3_telegram_delivery.sql');
      expect(verified).toContain('000023_m3_telegram_delivery_receipts.sql');
      expect(verified).toContain('000024_m3_telegram_receipt_key.sql');
      expect(verified).toContain('000025_m4_credit_ledger.sql');
      expect(verified).toContain('000026_m4_payment_intents.sql');
      expect(verified).toContain('000027_m4_provider_receipts.sql');
      expect(verified).toContain('000028_m4_feature_unlocks.sql');
      expect(verified).toContain('000029_m4_notifications_refunds.sql');
      expect(verified).toContain('000030_m4_localization.sql');
      expect(verified).toContain('000031_m5_nakh_flows.sql');
      expect(verified).toContain('000032_m5_pending_nakhes.sql');
      expect(verified).toContain('000033_m5_delivered_nakhes.sql');
      expect(verified).toContain('000034_m5_billing_matching.sql');
      expect(verified).toContain('000035_m5_localization.sql');
      expect(verified).toContain('000036_m5_reconciliation.sql');
      expect(verified).toContain('000037_m5_query_plans.sql');
      expect(verified).toContain('000038_m5_flow_lookup.sql');
      expect(verified).toContain('000039_m5_ordered_flow_lookup.sql');
      expect(verified).toContain('000040_m6_chat_catalog_messages.sql');
      expect(verified).toContain('000041_m6_unmatch.sql');
      expect(verified).toContain('000042_m6_notification_delivery.sql');
      expect(verified).toContain('000043_m6_chat_retention.sql');
      expect(verified).toContain('000044_m6_localization.sql');
      expect(verified).toContain('000045_m6_reconciliation.sql');
      expect(verified).toContain('000046_m7_reports.sql');
      expect(verified).toContain('000047_m7_report_evidence.sql');
      expect(verified).toContain('000048_m7_threshold_reviews_actions.sql');
      expect(verified).toContain('000049_m7_review_consistency_fix.sql');
      expect(verified).toContain('000050_m7_administration.sql');
      expect(verified).toContain('000051_m7_support_appeals.sql');
      expect(verified).toContain('000052_m7_appeal_admission.sql');
      expect(verified).toContain('000053_m7_appeal_unban.sql');
      expect(verified).toContain('000054_m7_localization.sql');
      expect(verified).toContain('000055_m7_review_decisions.sql');
      expect(verified).toContain('000056_m7_action_report_scope.sql');
      expect(verified).toContain('000057_m7_evidence_access_identity.sql');
      expect(verified).toContain('000058_m7_unmatch_report_deadline.sql');
      expect(verified).toContain('000059_m7_photo_evidence_holds.sql');
      expect(verified).toContain('000060_m7_photo_evidence_cleanup.sql');
      expect(verified).toContain('000061_m7_photo_capture_complete.sql');
      expect(verified).toContain('000062_m7_reconciliation.sql');
      expect(verified).toContain('000063_m7_operational_indexes.sql');
      expect(verified).toContain('000064_m7_admin_queue_localization.sql');
      expect(verified).toContain('000065_m7_admin_support_mutation_localization.sql');
      expect(verified).toContain('000066_m7_admin_appeal_review_localization.sql');
      expect(verified).toContain('000067_m7_admin_appeal_unban_localization.sql');
      expect(verified).toContain('000068_m7_admin_report_assignment_localization.sql');
      expect(verified).toContain('000069_m7_admin_report_decision_localization.sql');
      expect(verified).toContain('000070_m7_admin_report_account_localization.sql');
      expect(verified).toContain('000071_m7_admin_report_evidence_localization.sql');
      expect(verified).toContain('000072_m7_admin_report_photo_localization.sql');
      expect(verified).toContain('000073_m7_admin_evidence_read_localization.sql');
      expect(verified).toContain('000074_m7_report_internal_block_scope.sql');
      expect(verified).toContain('000075_m7_admin_report_block_localization.sql');
      expect(verified).toContain('000076_m7_integrity_history_index.sql');
      expect(verified).toContain('000077_m7_admin_sessions.sql');
      expect(verified).toContain('000078_m7_episode_resolution_index.sql');
      expect(verified).toContain('000079_m7_threshold_admission_witnesses.sql');
      expect(verified).toContain('000080_m7_snapshot_shape_projection.sql');
      expect(verified).toContain('000081_m7_restoration_history_index.sql');
      expect(verified).toContain('000082_m7_admin_totp.sql');
      expect(verified).toContain('000083_m7_admin_totp_enrollment.sql');
      expect(verified).toContain('000085_m8_deletion_admission.sql');
      expect(verified).toContain('000086_m8_deletion_work_fences.sql');
      expect(verified).toContain('000087_m8_shared_checkpoint.sql');
      expect(verified).toContain('000088_m8_shared_payment_proof.sql');
      expect(verified).toContain('000089_m8_capture_verification.sql');
      expect(verified).toContain('000090_m8_profile_archival.sql');
      expect(verified).toContain('000091_m8_chat_archival.sql');
      expect(verified).toContain('000092_m8_match_references.sql');
      expect(verified).toContain('000093_m8_match_archival.sql');
      expect(verified).toContain('000094_m8_photo_archival.sql');
      expect(verified).toContain('000095_m8_evidence_checkpoint.sql');
      expect(verified).toContain('000096_m8_product_batches.sql');
      expect(verified).toContain('000097_m8_payment_lifecycle.sql');
      expect(verified).toContain('000098_m8_media_delivery_authority.sql');
      expect(verified).toContain('000099_m8_credit_lifecycle_provenance.sql');
      expect(verified).toContain('000100_m8_deletion_lifecycle_binding.sql');
      expect(verified).toContain('000101_m8_credit_epoch_partition.sql');
      expect(verified).toContain('000102_m8_support_epoch_closure.sql');
      expect(verified).toContain('000103_m8_support_closure_proof_view.sql');
      const replay = await runMigrations(targetUrl.toString(), directory);
      expect(replay.applied).toEqual([]);
      expect(replay.existing).toHaveLength(103);
    } finally {
      try {
        if (created) await admin.query(`DROP DATABASE "${name}"`);
      } finally {
        await admin.end();
        await rm(previousDirectory, { recursive: true, force: true });
      }
    }
  });
});
