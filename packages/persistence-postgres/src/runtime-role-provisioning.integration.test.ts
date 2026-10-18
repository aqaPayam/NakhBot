import {
  PostgresLaunchCohortControl,
  PostgresLaunchCohortAdmission,
} from './launch-cohort-store.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateDirectNakhHandler } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, sourceMigrationDigests } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createReportUser } from './testing/report-fixture.js';
import { PostgresAppealStore } from './appeal-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';
import { PostgresDirectNakhStore } from './direct-nakh-store.js';
import { SystemIdGenerator } from './foundation-store.js';
import { PostgresFundingStore } from './funding-store.js';
import { PostgresRefundStore } from './refund-store.js';
import { PostgresAccountDeletionStore } from './account-deletion-store.js';
import { PostgresTelegramStarsReceiptStore } from './payment-receipt-store.js';
import { createFinalDeletionFixture } from './testing/final-deletion-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import { RUNTIME_DATABASE_ROLES, type RuntimeDatabasePurpose } from './runtime-database-policy.js';
import { RuntimeDatabases, verifyRuntimeDatabaseRole } from './runtime-database.js';
import {
  PostgresRuntimeRoleProvisioning,
  type RuntimeRoleProvisioning,
} from './runtime-role-provisioning.js';

const source = process.env.NAKH_TEST_DATABASE_URL;
const execute = promisify(execFile);
describe.skipIf(source === undefined)('native purpose role provisioning', () => {
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  let database: NakhDatabase;
  let input: RuntimeRoleProvisioning;
  let provisioner: PostgresRuntimeRoleProvisioning;
  let mayCleanRoles = false;
  const pools = new Map<RuntimeDatabasePurpose, NakhDatabase>();
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(source!, 'nakh_runtime_roles');
    await runMigrations(isolated.url, resolve('migrations'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 20000,
    });
    const existing = (
      await sql<{
        name: string;
      }>`SELECT rolname AS name FROM pg_roles WHERE rolname IN (${sql.join(Object.values(RUNTIME_DATABASE_ROLES))})`.execute(
        database,
      )
    ).rows;
    if (existing.length !== 0)
      throw new Error(
        'Role fixture requires an isolated PostgreSQL cluster without managed role names.',
      );
    mayCleanRoles = true;
    const urls = {} as Record<RuntimeDatabasePurpose, string>;
    for (const purpose of Object.keys(RUNTIME_DATABASE_ROLES) as RuntimeDatabasePurpose[]) {
      const url = new URL(isolated.url);
      url.username = RUNTIME_DATABASE_ROLES[purpose];
      url.password = randomBytes(32).toString('base64url');
      urls[purpose] = url.toString();
    }
    input = {
      commandId: randomUUID(),
      sourceSha: '1'.repeat(40),
      urls,
      migrations: await sourceMigrationDigests(resolve('migrations')),
    };
    provisioner = new PostgresRuntimeRoleProvisioning(database, isolated.url);
  });
  afterAll(async () => {
    await Promise.all([...pools.values()].map((pool) => pool.destroy()));
    // Role names are cluster-wide: only remove names proven absent before this
    // fixture, and remove this fixture database before dropping those roles.
    if (database && mayCleanRoles) {
      for (const role of Object.values(RUNTIME_DATABASE_ROLES))
        await sql`DROP OWNED BY ${sql.id(role)}`.execute(database).catch(() => undefined);
    }
    await database?.destroy();
    await isolated?.destroy();
    if (mayCleanRoles) {
      const admin = createDatabase({
        url: source!,
        poolMax: 1,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
      try {
        for (const role of Object.values(RUNTIME_DATABASE_ROLES))
          await sql`DROP ROLE IF EXISTS ${sql.id(role)}`.execute(admin);
      } finally {
        await admin.destroy();
      }
    }
  });
  it('serializes concurrent same-command provisioning to one audit and applies native policy', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => provisioner.provision(input)),
    );
    expect(results.filter((row) => !row.replayed)).toHaveLength(1);
    expect(results.every((row) => row.roles === 5)).toBe(true);
    const receipts = await database
      .selectFrom('platform.audit_logs')
      .select(['metadata'])
      .where('subject_id', '=', input.commandId)
      .execute();
    expect(receipts).toHaveLength(1);
    expect(JSON.stringify(receipts)).not.toContain('postgres');
    for (const purpose of Object.keys(input.urls) as RuntimeDatabasePurpose[]) {
      const db = createDatabase({
        url: input.urls[purpose],
        poolMax: 2,
        statementTimeoutMs: 15000,
        lockTimeoutMs: 10000,
      });
      pools.set(purpose, db);
      await verifyRuntimeDatabaseRole(db, purpose);
      const auth = (
        await sql<{ method: string | null }>`SELECT system_user::text AS method`.execute(db)
      ).rows[0]!.method;
      // Local developer PG may use trust. CI's service requires real SCRAM.
      if (process.env.GITHUB_ACTIONS === 'true') expect(auth).toMatch(/^scram-sha-256:/u);
    }
  });
  it('denies private financial payloads, seed writes, DDL and audit alteration', async () => {
    const user = pools.get('user')!;
    for (const statement of [
      sql`SELECT invoice_payload_ciphertext FROM billing.payment_records LIMIT 0`,
      sql`SELECT telegram_charge_id FROM billing.refund_records LIMIT 0`,
      sql`UPDATE platform.audit_logs SET result_code='tampered' WHERE false`,
      sql`DELETE FROM platform.audit_logs WHERE false`,
      sql`UPDATE administration.admin_role_permissions SET role_code=role_code WHERE false`,
      sql`UPDATE billing.credit_packages SET code=code WHERE false`,
      sql`INSERT INTO moderation.reports(id,reviewed_at) SELECT gen_random_uuid(),clock_timestamp() WHERE false`,
      sql`INSERT INTO moderation.moderation_actions(id,actor_admin_id) SELECT gen_random_uuid(),gen_random_uuid() WHERE false`,
      sql`UPDATE moderation.restriction_episodes SET status='resolved' WHERE false`,
      sql`CREATE TABLE profile.forbidden_role_table(id integer)`,
    ])
      await expect(statement.execute(user)).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql`SELECT id,status FROM billing.payment_records LIMIT 0`.execute(user),
    ).resolves.toBeDefined();
    await expect(
      sql`SELECT invoice_payload_ciphertext FROM billing.payment_records LIMIT 0`.execute(
        pools.get('financial')!,
      ),
    ).resolves.toBeDefined();
    await expect(
      sql`SELECT ciphertext FROM administration.admin_totp_credentials LIMIT 0`.execute(user),
    ).rejects.toMatchObject({ code: '42501' });
    for (const statement of [
      sql`UPDATE profile.profiles SET completion_status=completion_status WHERE false`,
      sql`UPDATE billing.telegram_stars_receipts SET stars_amount=stars_amount WHERE false`,
      sql`DELETE FROM billing.telegram_stars_receipts WHERE false`,
      sql`UPDATE discovery.explore_consumptions SET reason=reason WHERE false`,
      sql`DELETE FROM discovery.explore_consumptions WHERE false`,
    ])
      await expect(statement.execute(pools.get('financial')!)).rejects.toMatchObject({
        code: '42501',
      });
  });
  it('admits one exact-ban appeal through the public purpose without granting review or proof mutation', async () => {
    const userId = await createReportUser(database),
      banHistoryId = randomUUID(),
      at = new Date();
    await database.transaction().execute(async (tx) => {
      await tx
        .updateTable('identity.accounts')
        .set({ state: 'banned', state_reason: 'test_ban', state_changed_at: at, version: 2 })
        .where('user_id', '=', userId)
        .execute();
      await tx
        .insertInto('identity.account_state_history')
        .values({
          id: banHistoryId,
          user_id: userId,
          previous_state: 'active',
          next_state: 'banned',
          reason_code: 'test_ban',
          actor_type: 'system',
          actor_user_id: null,
          actor_admin_id: null,
          changed_at: at,
        })
        .execute();
    });
    const user = pools.get('user')!,
      store = new PostgresAppealStore(user),
      commandId = randomUUID(),
      write = {
        userId,
        banHistoryId,
        commandId,
        appealId: randomUUID(),
        eventId: randomUUID(),
        requestId: randomUUID(),
        idempotencyKey: commandId,
        requestDigest: 'a'.repeat(64),
        normalizedText: 'Private purpose-bound appeal text',
        expectedProductEpoch: 0,
      };
    const results = await Promise.all(Array.from({ length: 12 }, () => store.submit(write)));
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.every((result) => result.appealId === write.appealId)).toBe(true);
    await expect(
      store.submit({ ...write, commandId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(store.submit({ ...write, requestDigest: 'b'.repeat(64) })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    const appeal = await database
      .selectFrom('moderation.user_appeals')
      .selectAll()
      .where('id', '=', write.appealId)
      .executeTakeFirstOrThrow();
    expect(appeal).toMatchObject({
      status: 'submitted',
      version: 1,
      reviewed_by_admin_id: null,
      admin_note: null,
      reviewed_at: null,
    });
    for (const statement of [
      sql`INSERT INTO moderation.user_appeals(id,status) SELECT gen_random_uuid(),'accepted' WHERE false`,
      sql`INSERT INTO moderation.user_appeals(id,reviewed_by_admin_id) SELECT gen_random_uuid(),gen_random_uuid() WHERE false`,
      sql`INSERT INTO moderation.user_appeals(id,admin_note) SELECT gen_random_uuid(),'forged' WHERE false`,
      sql`INSERT INTO moderation.user_appeals(id,reviewed_at) SELECT gen_random_uuid(),clock_timestamp() WHERE false`,
      sql`INSERT INTO moderation.user_appeals(id,version) SELECT gen_random_uuid(),2 WHERE false`,
      sql`UPDATE moderation.user_appeals SET status='accepted' WHERE false`,
      sql`UPDATE moderation.appeal_submissions SET request_digest=request_digest WHERE false`,
      sql`DELETE FROM moderation.appeal_submissions WHERE false`,
    ])
      await expect(statement.execute(user)).rejects.toMatchObject({ code: '42501' });
    const proof = await database
      .selectFrom('moderation.appeal_submissions')
      .selectAll()
      .where('appeal_id', '=', write.appealId)
      .execute();
    const events = await database
      .selectFrom('platform.outbox_events')
      .selectAll()
      .where('causation_id', '=', commandId)
      .execute();
    expect(proof).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(write.normalizedText);
    for (const drift of [
      sql`GRANT INSERT(status) ON moderation.user_appeals TO nakh_user`,
      sql`GRANT UPDATE(request_digest) ON moderation.appeal_submissions TO nakh_user`,
      sql`REVOKE INSERT(message_text) ON moderation.user_appeals FROM nakh_user`,
    ]) {
      await drift.execute(database);
      await expect(verifyRuntimeDatabaseRole(user, 'user')).rejects.toThrow(
        'Runtime database role unavailable.',
      );
      expect((await provisioner.provision(input)).replayed).toBe(true);
      await verifyRuntimeDatabaseRole(user, 'user');
    }
  });
  it('serializes a funded Nakh and its exact credit debit through the financial login', async () => {
    const sender = await createReportUser(database, true),
      receiver = await createReportUser(database, true),
      at = new Date();
    for (const userId of [sender, receiver]) {
      await database
        .insertInto('identity.user_settings')
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
      await database
        .insertInto('billing.credit_accounts')
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
      await database
        .insertInto('notification.notification_preferences')
        .values({ user_id: userId, created_at: at, updated_at: at })
        .execute();
    }
    const financial = pools.get('financial')!,
      ledger = new PostgresCreditLedgerStore(financial);
    await ledger.append({
      transactionId: randomUUID(),
      userId: sender,
      transactionType: 'admin_adjustment',
      amount: 2n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    const command = {
      commandType: 'nakh.create-direct' as const,
      schemaVersion: 1 as const,
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      actor: { kind: 'user' as const, userId: sender },
      occurredAt: at.toISOString(),
      locale: 'en',
      data: { targetUserId: receiver, text: 'Private purpose-qualified Nakh' },
    };
    const handler = new CreateDirectNakhHandler(
      new PostgresDirectNakhStore(financial),
      new SystemIdGenerator(),
    );
    const results = await Promise.all(Array.from({ length: 12 }, () => handler.execute(command)));
    expect(new Set(results.map((result) => result.nakhId)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect((await ledger.getBalance(sender)).balance).toBe(0n);
    const transactions = await database
      .selectFrom('billing.credit_transactions')
      .select(['amount', 'nakh_id'])
      .where('user_id', '=', sender)
      .where('transaction_type', '=', 'spend_nakh')
      .execute();
    expect(transactions).toEqual([{ amount: '-2', nakh_id: results[0]!.nakhId }]);
  });
  it('records and fulfills one synthetic Stars package through the financial login under competing workers', async () => {
    const userId = await createReportUser(database, true),
      at = new Date(),
      telegramUserId = String(3_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: telegramUserId,
        username: null,
        first_seen_at: at,
        last_seen_at: at,
      })
      .execute();
    await database
      .insertInto('identity.user_settings')
      .values({ user_id: userId, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('billing.credit_accounts')
      .values({ user_id: userId, created_at: at, updated_at: at })
      .execute();
    await database
      .insertInto('notification.notification_preferences')
      .values({ user_id: userId, created_at: at, updated_at: at })
      .execute();
    const financial = pools.get('financial')!,
      funding = new PostgresFundingStore(financial),
      digest = (value: string): string => createHash('sha256').update(value).digest('hex'),
      cleartext = randomBytes(24).toString('base64url'),
      payload = {
        cleartext,
        digest: digest(cleartext),
        ciphertext: Uint8Array.from(randomBytes(64)),
        keyId: 'synthetic-billing-v1',
      },
      botDigest = 'b'.repeat(64);
    const intent = await funding.createFundingIntent({
      intentId: randomUUID(),
      userId,
      funding: 'stars',
      target: { type: 'credit_package', packageCode: 'starter' },
      idempotencyKey: randomUUID(),
    });
    const payment = await funding.prepareStarsAttempt({
      paymentRecordId: randomUUID(),
      fundingIntentId: intent.id,
      expectedVersion: 1,
      userId,
      idempotencyKey: randomUUID(),
      providerEnvironment: 'test',
      providerBotIdDigest: botDigest,
      payload,
    });
    const receipts = new PostgresTelegramStarsReceiptStore(
        financial,
        { uuid: randomUUID },
        { digest },
      ),
      eventId = randomUUID(),
      callback = {
        providerEventId: eventId,
        telegramUserId,
        invoicePayload: cleartext,
        currency: 'XTR',
        totalAmount: payment.starsAmount,
        providerEnvironment: 'test' as const,
        providerBotIdDigest: botDigest,
        telegramChargeId: randomUUID(),
        evidence: {
          digest: digest(eventId),
          ciphertext: Uint8Array.from(randomBytes(64)),
          keyId: 'synthetic-provider-v1',
          schemaVersion: 1 as const,
        },
      };
    await expect(receipts.recordSuccessfulPayment(callback)).resolves.toMatchObject({
      outcome: 'receipt_recorded',
    });
    const owner = randomUUID(),
      claim = (await receipts.claimFulfillments({ owner, leaseMs: 60_000, limit: 100 })).find(
        (row) => row.paymentRecordId === payment.paymentRecordId,
      )!;
    expect(claim).toBeDefined();
    const fulfillment = {
      paymentRecordId: payment.paymentRecordId,
      owner,
      fenceToken: claim.fenceToken,
      creditTransactionId: randomUUID(),
      creditIncreasedEventId: randomUUID(),
      paymentFulfilledEventId: randomUUID(),
      refundRecordId: randomUUID(),
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () => receipts.fulfillCreditPackage(fulfillment)),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    await receipts.recordSuccessfulPayment(callback);
    expect((await new PostgresCreditLedgerStore(financial).getBalance(userId)).balance).toBe(10n);
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('payment_record_id', '=', payment.paymentRecordId)
        .execute(),
    ).toHaveLength(1);
    const lateCleartext = randomBytes(24).toString('base64url'),
      lateIntent = await funding.createFundingIntent({
        intentId: randomUUID(),
        userId,
        funding: 'stars',
        target: { type: 'credit_package', packageCode: 'starter' },
        idempotencyKey: randomUUID(),
      }),
      latePayment = await funding.prepareStarsAttempt({
        paymentRecordId: randomUUID(),
        fundingIntentId: lateIntent.id,
        expectedVersion: 1,
        userId,
        idempotencyKey: randomUUID(),
        providerEnvironment: 'test',
        providerBotIdDigest: botDigest,
        payload: { ...payload, cleartext: lateCleartext, digest: digest(lateCleartext) },
      });
    const key = randomBytes(32),
      deletion = new PostgresAccountDeletionStore(pools.get('user')!, {
        activeKeyId: 'purpose-deletion-fixture',
        keys: new Map([['purpose-deletion-fixture', key]]),
      });
    try {
      const account = await database
        .selectFrom('identity.accounts')
        .select('version')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      const proof = await deletion.prepare({
        actor: { kind: 'user', userId },
        requestId: randomUUID(),
        expectedAccountVersion: account.version,
      });
      const deletionCommand = randomUUID();
      await deletion.request({
        commandId: deletionCommand,
        commandType: 'account.delete',
        schemaVersion: 1,
        actor: { kind: 'user', userId },
        requestId: randomUUID(),
        idempotencyKey: deletionCommand,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: {
          expectedAccountVersion: account.version,
          confirmationToken: proof.confirmationToken,
        },
      });
    } finally {
      key.fill(0);
    }
    // Keep this pending fixture separate from the next case's single-subject poll.
    await sql`UPDATE identity.account_deletion_work SET available_at=clock_timestamp()+interval '1 day' WHERE deletion_record_id IN (SELECT id FROM identity.account_deletion_records WHERE user_id=${userId}::uuid)`.execute(
      database,
    );
    const lateEvent = randomUUID();
    await receipts.recordSuccessfulPayment({
      ...callback,
      providerEventId: lateEvent,
      invoicePayload: lateCleartext,
      telegramChargeId: randomUUID(),
      evidence: { ...callback.evidence, digest: digest(lateEvent) },
    });
    const lateClaim = (
      await receipts.claimFulfillments({ owner, leaseMs: 60_000, limit: 100 })
    ).find((row) => row.paymentRecordId === latePayment.paymentRecordId)!;
    expect(lateClaim).toBeDefined();
    const lateFulfillment = {
      ...fulfillment,
      paymentRecordId: latePayment.paymentRecordId,
      fenceToken: lateClaim.fenceToken,
      creditTransactionId: randomUUID(),
      creditIncreasedEventId: randomUUID(),
      paymentFulfilledEventId: randomUUID(),
      refundRecordId: randomUUID(),
    };
    const corrections = await Promise.all(
      Array.from({ length: 12 }, () => receipts.fulfillCreditPackage(lateFulfillment)),
    );
    expect(corrections.filter((result) => !result.replayed)).toHaveLength(1);
    expect(corrections.every((result) => result.outcome === 'correction_required')).toBe(true);
    const refunds = new PostgresRefundStore(financial),
      refund = (await refunds.claimStarsRefunds({ owner, leaseMs: 60_000, limit: 100 })).find(
        (row) => row.refundRecordId === lateFulfillment.refundRecordId,
      )!;
    expect(refund).toBeDefined();
    await expect(refunds.beginProviderCall(refund)).resolves.toBe(true);
    await expect(refunds.completeStarsRefund(refund)).resolves.toBe('processed');
    await expect(refunds.completeStarsRefund(refund)).resolves.toBe('replayed');
    expect(
      await database
        .selectFrom('billing.credit_transactions')
        .select('id')
        .where('payment_record_id', '=', latePayment.paymentRecordId)
        .execute(),
    ).toHaveLength(0);
  });
  it('completes every native deletion checkpoint through the maintenance login with retained erasure disabled', async () => {
    const maintenance = pools.get('maintenance')!,
      item = await createFinalDeletionFixture(maintenance),
      store = new PostgresAccountDeletionEphemeralStore(
        maintenance,
        'm8-native-final',
        'a'.repeat(64),
      );
    expect(await store.finish(item.lease)).toEqual({ completed: false });
    for (let page = 0; page < 20; page++) {
      const next = await store.claimNext(item.lease);
      if (next.done) break;
      expect(next.operation).toBeDefined();
      await store.complete(item.lease, next.operation!.id, {
        cursor: next.operation!.stage.startsWith('queue_')
          ? { redisCursor: '0', pendingKeys: [] }
          : '0',
        more: false,
        found: 0,
      });
    }
    expect(await store.finish(item.lease)).toEqual({ completed: true });
    expect(
      (
        await sql<{
          phase: string;
          checkpoint_version: number;
          reactivation_allowed: boolean;
        }>`SELECT phase,checkpoint_version,reactivation_allowed FROM identity.account_deletion_records WHERE id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ phase: 'completed', checkpoint_version: 8, reactivation_allowed: false }]);
    expect(
      (
        await sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${item.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 7 }]);
  });
  it('preserves RBAC seed row locks without giving the administrator login seed write rights', async () => {
    const userId = await createReportUser(database),
      adminId = randomUUID(),
      at = new Date();
    await database
      .insertInto('identity.telegram_identities')
      .values({
        user_id: userId,
        telegram_user_id: '7000000000001',
        username: null,
        first_seen_at: at,
        last_seen_at: at,
      })
      .execute();
    await database
      .insertInto('administration.admin_users')
      .values({
        id: adminId,
        user_id: userId,
        telegram_user_id: '7000000000001',
        identity_verified_at: at,
        is_active: true,
        disabled_at: null,
        created_at: at,
        updated_at: at,
      })
      .execute();
    await database
      .insertInto('administration.admin_user_roles')
      .values({
        admin_user_id: adminId,
        role_code: 'super_admin',
        assigned_by_admin_id: adminId,
        revoked_by_admin_id: null,
        revoked_at: null,
      })
      .execute();
    const administrator = pools.get('administration')!;
    await expect(
      sql`UPDATE administration.admin_roles SET is_active=false WHERE false`.execute(administrator),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql`SELECT * FROM administration.lock_runtime_admin_permission(${adminId}::uuid,'view_reports')`.execute(
        pools.get('user')!,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await administrator.transaction().execute(async (tx) => {
      const permission = await sql<{
        permission_code: string;
      }>`SELECT * FROM administration.lock_runtime_admin_permission(${adminId}::uuid,'view_reports')`.execute(
        tx,
      );
      expect(permission.rows).toEqual([{ permission_code: 'view_reports' }]);
      await expect(
        database.transaction().execute(async (owner) => {
          await sql`SET LOCAL lock_timeout='50ms'`.execute(owner);
          await sql`UPDATE administration.admin_roles SET is_active=false WHERE code='super_admin'`.execute(
            owner,
          );
        }),
      ).rejects.toMatchObject({ code: '55P03' });
    });
    await database
      .updateTable('administration.admin_user_roles')
      .set({ revoked_at: sql<Date>`clock_timestamp()`, revoked_by_admin_id: adminId })
      .where('admin_user_id', '=', adminId)
      .execute();
    const denied =
      await sql`SELECT * FROM administration.lock_runtime_admin_permission(${adminId}::uuid,'view_reports')`.execute(
        administrator,
      );
    expect(denied.rows).toHaveLength(0);
    await verifyRuntimeDatabaseRole(administrator, 'administration');
    await expect(
      sql`UPDATE moderation.report_reasons SET is_active=false WHERE false`.execute(
        pools.get('user')!,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const reason =
      await sql`SELECT * FROM moderation.lock_runtime_report_reason('harassment')`.execute(
        pools.get('user')!,
      );
    expect(reason.rows).toHaveLength(1);
    await pools
      .get('user')!
      .transaction()
      .execute(async (tx) => {
        await sql`SELECT * FROM moderation.lock_runtime_report_reason('harassment')`.execute(tx);
        await expect(
          database.transaction().execute(async (owner) => {
            await sql`SET LOCAL lock_timeout='50ms'`.execute(owner);
            await sql`UPDATE moderation.report_reasons SET is_active=false WHERE code='harassment'`.execute(
              owner,
            );
          }),
        ).rejects.toMatchObject({ code: '55P03' });
      });
    await expect(
      sql`INSERT INTO moderation.moderation_reviews(id,report_id,assigned_admin_id)
      SELECT gen_random_uuid(),gen_random_uuid(),${adminId}::uuid WHERE false`.execute(
        pools.get('user')!,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('admits a fixed host pool set using native role proofs and denies production without TLS', async () => {
    await expect(
      sql`SELECT id FROM interaction.current_like_lives LIMIT 0 FOR UPDATE`.execute(
        pools.get('financial')!,
      ),
    ).resolves.toBeDefined();
    const settings = {
      url: input.urls.user,
      poolMax: 10,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
      roleIsolationEnabled: true,
    };
    const host = new RuntimeDatabases(
      { environment: 'test', serviceName: 'api', database: settings },
      () => input.urls.administration,
    );
    try {
      expect(host.get('user')).not.toBe(host.get('administration'));
      await host.verify();
      expect(() => host.get('financial')).toThrow('Runtime database role unavailable.');
    } finally {
      await host.destroy();
    }
    expect(() => host.get('user')).toThrow('Runtime database role unavailable.');
    await expect(verifyRuntimeDatabaseRole(pools.get('user')!, 'user', true)).rejects.toThrow(
      'Runtime database role unavailable.',
    );
  });
  it('rejects command reuse with changed credentials and mismatched schema before changes', async () => {
    const user = input.urls.user.replace(
      /:[^:@/]+@/u,
      ':' + randomBytes(32).toString('base64url') + '@',
    );
    await expect(
      provisioner.provision({ ...input, urls: { ...input.urls, user } }),
    ).rejects.toThrow('Runtime database provisioning unavailable.');
    await expect(
      provisioner.provision({
        ...input,
        commandId: randomUUID(),
        migrations: input.migrations.slice(1),
      }),
    ).rejects.toThrow('Runtime database provisioning unavailable.');
  });
  it('repairs column ACL drift on replay rather than trusting an old receipt', async () => {
    await sql`GRANT SELECT(invoice_payload_ciphertext) ON billing.payment_records TO nakh_user`.execute(
      database,
    );
    await sql`GRANT SELECT(storage_key) ON media.report_photo_source_facts TO nakh_user`.execute(
      database,
    );
    await expect(verifyRuntimeDatabaseRole(pools.get('user')!, 'user')).rejects.toThrow(
      'Runtime database role unavailable.',
    );
    expect((await provisioner.provision(input)).replayed).toBe(true);
    await verifyRuntimeDatabaseRole(pools.get('user')!, 'user');
    await expect(
      sql`SELECT storage_key FROM media.report_photo_source_facts LIMIT 0`.execute(
        pools.get('user')!,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      sql`SELECT invoice_payload_ciphertext FROM billing.payment_records LIMIT 0`.execute(
        pools.get('user')!,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rolls back permission changes if the required audit cannot be written', async () => {
    await sql`GRANT SELECT(invoice_payload_ciphertext) ON billing.payment_records TO nakh_user`.execute(
      database,
    );
    await sql`CREATE FUNCTION public.reject_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='platform.runtime-database-roles-provisioned.v1' THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$`.execute(
      database,
    );
    await sql`CREATE TRIGGER reject_role_audit BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION public.reject_role_audit()`.execute(
      database,
    );
    try {
      await expect(provisioner.provision({ ...input, commandId: randomUUID() })).rejects.toThrow(
        'Runtime database provisioning unavailable.',
      );
      await expect(
        sql`SELECT invoice_payload_ciphertext FROM billing.payment_records LIMIT 0`.execute(
          pools.get('user')!,
        ),
      ).resolves.toBeDefined();
    } finally {
      await sql`DROP TRIGGER reject_role_audit ON platform.audit_logs`.execute(database);
      await sql`DROP FUNCTION public.reject_role_audit()`.execute(database);
      await provisioner.provision(input);
    }
  });
  it('cannot use a runtime login as the role-provisioning authority', async () => {
    const attacker = new PostgresRuntimeRoleProvisioning(pools.get('user')!, input.urls.user);
    await expect(attacker.provision({ ...input, commandId: randomUUID() })).rejects.toThrow(
      'Runtime database provisioning unavailable.',
    );
  });
  it('runs the compiled migration-host CLI without printing private credentials', async () => {
    const env = {
      ...process.env,
      NAKH_RELEASE: input.sourceSha,
      NAKH_DATABASE_URL: isolated!.url,
      NAKH_USER_DATABASE_URL: input.urls.user,
      NAKH_FINANCIAL_DATABASE_URL: input.urls.financial,
      NAKH_ADMIN_DATABASE_URL: input.urls.administration,
      NAKH_MAINTENANCE_DATABASE_URL: input.urls.maintenance,
      NAKH_SCHEDULER_DATABASE_URL: input.urls.scheduler,
    };
    const commandId = randomUUID();
    const result = await execute(
      process.execPath,
      [
        resolve('packages/persistence-postgres/dist/cli/provision-runtime-roles.js'),
        commandId,
        input.sourceSha,
      ],
      { env, timeout: 30000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'provisioned',
      roles: 5,
      replayed: false,
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('postgres');
    try {
      await execute(
        process.execPath,
        [
          resolve('packages/persistence-postgres/dist/cli/provision-runtime-roles.js'),
          commandId,
          '3'.repeat(40),
        ],
        { env, timeout: 30000 },
      );
      throw new Error('Expected CLI denial.');
    } catch (error) {
      expect(error).toMatchObject({
        code: 1,
        stdout: '',
        stderr: 'Runtime database provisioning unavailable.\n',
      });
    }
  });

  it('runs read-only rollback qualification without migrations, role repair or private output', async () => {
    const env = {
      ...process.env,
      NAKH_ENV: 'staging',
      NAKH_RELEASE: input.sourceSha,
      NAKH_DATABASE_ROLE_ISOLATION_ENABLED: 'true',
      NAKH_DATABASE_URL: isolated!.url,
      NAKH_USER_DATABASE_URL: input.urls.user,
      NAKH_FINANCIAL_DATABASE_URL: input.urls.financial,
      NAKH_ADMIN_DATABASE_URL: input.urls.administration,
      NAKH_MAINTENANCE_DATABASE_URL: input.urls.maintenance,
      NAKH_SCHEDULER_DATABASE_URL: input.urls.scheduler,
    };
    const snapshot = async (): Promise<{ audits: string; migrations: string } | undefined> =>
      (
        await sql<{ audits: string; migrations: string }>`SELECT
      (SELECT count(*)::text FROM platform.audit_logs) AS audits,
      (SELECT count(*)::text FROM platform.schema_migrations) AS migrations`.execute(database)
      ).rows[0];
    const before = await snapshot();
    const command = [
      '--no-opt',
      resolve('packages/persistence-postgres/dist/cli/verify-runtime-roles.js'),
      input.sourceSha,
    ];
    const result = await execute(process.execPath, command, { env, timeout: 30000 });
    expect(JSON.parse(result.stdout)).toEqual({
      verified: true,
      sourceSha: input.sourceSha,
      roles: 5,
      readOnly: true,
    });
    expect(result.stderr).toBe('');
    expect(await snapshot()).toEqual(before);
    await sql`GRANT UPDATE ON platform.audit_logs TO nakh_user`.execute(database);
    try {
      await expect(
        execute(process.execPath, command, { env, timeout: 30000 }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: 'Runtime database role verification unavailable.\n',
      });
      const drift = (
        await sql<{
          allowed: boolean;
        }>`SELECT has_table_privilege('nakh_user','platform.audit_logs','UPDATE') AS allowed`.execute(
          database,
        )
      ).rows[0];
      expect(drift?.allowed).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally {
      await sql`REVOKE UPDATE ON platform.audit_logs FROM nakh_user`.execute(database);
    }
    await expect(
      execute(process.execPath, command, {
        env: { ...env, NAKH_ADMIN_DATABASE_URL: input.urls.user },
        timeout: 30000,
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'Runtime database role verification unavailable.\n',
    });
  });

  it('lets runtime read cohort admission while denying it authority to admit or stop users', async () => {
    const user = await createReportUser(database),
      operatorId = randomUUID();
    const expiry = (
      await sql<{
        expiry: string;
      }>`SELECT to_char((clock_timestamp()+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expiry`.execute(
        database,
      )
    ).rows[0]!.expiry;
    const command = {
      requestId: randomUUID(),
      expectedVersion: 0,
      sourceSha: input.sourceSha,
      environment: 'staging' as const,
      telegramBotId: '123456789',
      mode: 'cohort',
      expiresAt: expiry,
      reviewDigest: 'a'.repeat(64),
      members: [{ userId: user, productEpoch: 0 }],
    };
    const owner = new PostgresLaunchCohortControl(database, { operatorId });
    await owner.apply(command);
    const runtime = pools.get('user')!,
      reader = new PostgresLaunchCohortAdmission(runtime, {
        sourceSha: input.sourceSha,
        environment: 'staging',
        telegramBotId: '123456789',
      });
    expect(await reader.allows(user)).toBe(true);
    await expect(
      new PostgresLaunchCohortControl(runtime, { operatorId }).apply({
        ...command,
        requestId: randomUUID(),
        expectedVersion: 1,
        mode: 'closed',
        expiresAt: null,
        members: [],
      }),
    ).rejects.toThrow('Launch cohort unavailable');
    expect(await reader.allows(user)).toBe(true);
    await sql`CREATE FUNCTION public.launch_definer_fixture() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      DECLARE item uuid:=gen_random_uuid(); BEGIN
        INSERT INTO platform.audit_logs(id,category,event_type,actor_type,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at)
        VALUES(item,'security','platform.launch-policy-applied.v1','system','launch_policy','00000000-0000-4000-8000-000000000009','closed',1,'{}',item,item,clock_timestamp());
      END $$`.execute(database);
    try {
      await expect(
        sql`SELECT public.launch_definer_fixture()`.execute(runtime),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await sql`DROP FUNCTION public.launch_definer_fixture()`.execute(database);
    }
    await owner.apply({
      ...command,
      requestId: randomUUID(),
      expectedVersion: 1,
      mode: 'closed',
      expiresAt: null,
      members: [],
    });
    expect(await reader.allows(user)).toBe(false);
  });
  it('observes a migration committed while waiting on the migrator lock', async () => {
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      ready = resolveHeld;
    });
    const released = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    let blocker = 0;
    const upgrade = database.transaction().execute(async (tx) => {
      blocker = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0]!
        .pid;
      await sql`SELECT pg_advisory_xact_lock(hashtext('nakh-schema-migrations'))`.execute(tx);
      await tx
        .insertInto('platform.schema_migrations')
        .values({
          name: '999999_role_race_fixture.sql',
          sha256: '2'.repeat(64),
          applied_at: new Date(),
        })
        .execute();
      ready();
      await released;
    });
    await held;
    const pending = provisioner.provision({ ...input, commandId: randomUUID() });
    // Attach rejection handling immediately; only release after PostgreSQL itself
    // proves the provisioning transaction is blocked behind this migration.
    const result = pending.then(
      () => 'unexpected',
      () => 'denied',
    );
    try {
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        blocked = (
          await sql<{ blocked: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
          WHERE ${blocker} = ANY(pg_blocking_pids(a.pid))) AS blocked`.execute(database)
        ).rows[0]!.blocked;
        if (!blocked) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      await upgrade;
    }
    try {
      expect(await result).toBe('denied');
    } finally {
      await database
        .deleteFrom('platform.schema_migrations')
        .where('name', '=', '999999_role_race_fixture.sql')
        .execute();
    }
    expect((await provisioner.provision(input)).replayed).toBe(true);
  });
});
