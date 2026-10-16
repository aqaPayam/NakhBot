import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdtemp, readdir, copyFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReturnAccountCommand } from '@nakh/contracts';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createAccountReturnFixture } from './testing/account-return-fixture.js';
import { PostgresAccountReturnStore } from './account-return-store.js';
import { PostgresAccountControlSessionStore } from './account-control-session-store.js';
import { PostgresUserSessionStore } from './user-session-store.js';
import { PostgresGuestPreviewStore } from './guest-preview-store.js';
import { PostgresSignupStore } from './signup-store.js';
import { PostgresCreditLedgerStore } from './credit-ledger-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
type Fixture = Awaited<ReturnType<typeof createAccountReturnFixture>>;
function command(f: Fixture): ReturnAccountCommand {
  const id = randomUUID();
  return {
    commandId: id,
    commandType: 'account.return',
    schemaVersion: 1,
    actor: { kind: 'user', userId: f.userId },
    requestId: randomUUID(),
    idempotencyKey: `return:${id}`,
    occurredAt: new Date().toISOString(),
    locale: 'en',
    data: { expectedAccountVersion: f.version },
  };
}
describe.skipIf(url === undefined)('M8 native approved fresh guest Return', () => {
  let database: NakhDatabase, isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>;
  let expiryFixture: Fixture | undefined;
  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase(url!, 'm8_fresh_return');
    await runMigrations(isolated.url, resolve('migrations'));
    await verifyMigrations(isolated.url, resolve('migrations/verify'));
    database = createDatabase({
      url: isolated.url,
      poolMax: 24,
      statementTimeoutMs: 30000,
      lockTimeoutMs: 15000,
    });
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.destroy();
  });
  beforeEach(async ({ task }) => {
    await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day' WHERE phase<>'completed'`.execute(
      database,
    );
    // Bound fixture setup separately; the unchanged case timeout measures actual
    // authority expiry, rollback and its native execution witness.
    if (task.name.includes('rejects expiry at deferred commit'))
      expiryFixture = await createAccountReturnFixture(database);
  });
  async function state(f: Fixture): Promise<unknown> {
    return (
      await sql`SELECT state,version,product_epoch FROM identity.accounts WHERE user_id=${f.userId}::uuid`.execute(
        database,
      )
    ).rows;
  }
  async function proofs(f: Fixture): Promise<unknown> {
    return (
      await sql`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY from_checkpoint_version) FROM identity.account_deletion_phase_receipts p WHERE deletion_record_id=${f.recordId}::uuid) AS phases,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY retained_data_type) FROM identity.data_retention_records r WHERE deletion_record_id=${f.recordId}::uuid) AS retention,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY product_epoch) FROM billing.credit_epoch_closures c WHERE deletion_record_id=${f.recordId}::uuid) AS financial`.execute(
        database,
      )
    ).rows;
  }
  async function returned(f: Fixture): Promise<readonly Record<string, unknown>[]> {
    return (
      await sql<
        Record<string, unknown>
      >`SELECT *,identity.account_return_proof_valid(a,true) AS valid FROM platform.audit_logs a WHERE event_type='account.returned.v1' AND subject_id=${f.recordId}::uuid`.execute(
        database,
      )
    ).rows;
  }
  async function unchanged(f: Fixture): Promise<void> {
    expect(await state(f)).toEqual([{ state: 'deleted', version: f.version, product_epoch: 0 }]);
    expect(await returned(f)).toHaveLength(0);
    expect(
      (
        await sql`SELECT reactivation_allowed FROM identity.account_deletion_records WHERE id=${f.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ reactivation_allowed: false }]);
  }
  it('commits one exact twenty-way Return, preserves identity/preview/history and starts empty with zero credit', async () => {
    let oldGrantId = '';
    const sessions = new PostgresUserSessionStore(database);
    const f = await createAccountReturnFixture(database, {
      beforeDeletion: async (userId) => {
        oldGrantId = (await sessions.issue({ userId, productEpoch: 0 }, randomUUID()))!.id;
      },
    });
    const before = await proofs(f);
    const stable = (
      await sql`SELECT to_jsonb(u) AS user,to_jsonb(t) AS telegram,to_jsonb(p) AS preview FROM identity.users u JOIN identity.telegram_identities t ON t.user_id=u.id JOIN identity.guest_preview_counters p ON p.user_id=u.id WHERE u.id=${f.userId}::uuid`.execute(
        database,
      )
    ).rows;
    const root = (
      await sql`SELECT to_jsonb(r)-'reactivation_allowed' AS root FROM identity.account_deletion_records r WHERE id=${f.recordId}::uuid`.execute(
        database,
      )
    ).rows;
    const ledger = (
      await sql`SELECT to_jsonb(c) AS value FROM billing.credit_accounts c WHERE user_id=${f.userId}::uuid`.execute(
        database,
      )
    ).rows;
    const a = command(f),
      store = new PostgresAccountReturnStore(database, f.control);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.return(a)));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.every((r) => r.returned && r.accountVersion === f.version + 1)).toBe(true);
    expect(await returned(f)).toMatchObject([{ valid: true }]);
    expect(await state(f)).toEqual([{ state: 'guest', version: f.version + 1, product_epoch: 1 }]);
    expect(await proofs(f)).toEqual(before);
    expect(
      (
        await sql`SELECT to_jsonb(u) AS user,to_jsonb(t) AS telegram,to_jsonb(p) AS preview FROM identity.users u JOIN identity.telegram_identities t ON t.user_id=u.id JOIN identity.guest_preview_counters p ON p.user_id=u.id WHERE u.id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(stable);
    expect(
      (
        await sql`SELECT to_jsonb(r)-'reactivation_allowed' AS root FROM identity.account_deletion_records r WHERE id=${f.recordId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(root);
    expect(
      (
        await sql`SELECT to_jsonb(c) AS value FROM billing.credit_accounts c WHERE user_id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual(ledger);
    expect(
      (
        await sql`SELECT count(*)::integer AS count FROM profile.profiles WHERE user_id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      await sessions.current({ userId: f.userId, productEpoch: 0 }, oldGrantId),
    ).toBeUndefined();
    expect(await sessions.issue({ userId: f.userId, productEpoch: 1 }, randomUUID())).toBeDefined();
    expect(
      await new PostgresAccountControlSessionStore(database).current(
        f.control,
        f.control.controlGrantId,
      ),
    ).toBeUndefined();
  });
  it.each(['approval', 'safety'])(
    'denies Return without completed explicit authority: %s',
    async (reason) => {
      const f = await createAccountReturnFixture(database, {
        approve: false,
        banned: reason === 'safety',
      });
      await expect(
        new PostgresAccountReturnStore(database, f.control).return(command(f)),
      ).rejects.toMatchObject({ code: 'conflict' });
      await expect(
        sql`UPDATE identity.account_deletion_records SET reactivation_allowed=true WHERE id=${f.recordId}::uuid`.execute(
          database,
        ),
      ).rejects.toThrow();
      await expect(
        sql`UPDATE identity.accounts SET state='guest',version=version+1,product_epoch=product_epoch+1 WHERE user_id=${f.userId}::uuid`.execute(
          database,
        ),
      ).rejects.toThrow();
      await unchanged(f);
    },
  );
  it('binds owner, original epoch, account version and idempotency, and never lets old control act in the new life', async () => {
    const f = await createAccountReturnFixture(database),
      a = command(f),
      store = new PostgresAccountReturnStore(database, f.control);
    await expect(
      new PostgresAccountReturnStore(database, { ...f.control, userId: randomUUID() }).return(a),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      new PostgresAccountReturnStore(database, { ...f.control, productEpoch: 1 }).return(a),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      new PostgresAccountReturnStore(database, {
        ...f.control,
        controlGrantId: randomUUID(),
      }).return(a),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      store.return({ ...a, data: { expectedAccountVersion: f.version + 1 } }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await store.return(a);
    await expect(store.return({ ...a, requestId: randomUUID() })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    await expect(store.return(command(f))).rejects.toMatchObject({ code: 'conflict' });
    const grant = await new PostgresAccountControlSessionStore(database).issue(
      { userId: f.userId, productEpoch: 1 },
      randomUUID(),
    );
    await expect(
      new PostgresAccountReturnStore(database, {
        ...f.control,
        productEpoch: 1,
        controlGrantId: grant!.id,
      }).return(a),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await store.return(a)).toMatchObject({ replayed: true });
    expect(await returned(f)).toHaveLength(1);
  });
  it('keeps historical financial, retention, provider and approval proof valid after real Return and new signup/credit activity', async () => {
    const f = await createAccountReturnFixture(database),
      before = await proofs(f),
      a = command(f);
    await new PostgresAccountReturnStore(database, f.control).return(a);
    const at = new Date();
    const preview = await new PostgresGuestPreviewStore(database).consumeGuestPreview({
      command: {
        commandId: randomUUID(),
        commandType: 'identity.consume-guest-preview',
        schemaVersion: 1,
        actor: a.actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: at.toISOString(),
        locale: 'en',
        // Counter-only fixture references; discovery/provider delivery is not exercised.
        data: { candidateUserId: randomUUID(), deliveryReceiptId: randomUUID() },
      },
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: at,
    });
    expect(preview.count).toBe(4);
    const signup = await new PostgresSignupStore(database).startSignup({
      command: {
        commandId: randomUUID(),
        commandType: 'identity.start-signup',
        schemaVersion: 1,
        actor: a.actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        occurredAt: at.toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: f.version + 1 },
      },
      accountHistoryId: randomUUID(),
      auditId: randomUUID(),
      eventId: randomUUID(),
      processedAt: at,
    });
    expect(signup).toMatchObject({ currentStep: 'age_confirmation' });
    // Activation is a privileged fixture for ledger activity, not a claim that
    // complete signup/Photo moderation was exercised. Return itself was real.
    await sql`UPDATE identity.accounts SET state='active',version=version+1 WHERE user_id=${f.userId}::uuid`.execute(
      database,
    );
    await new PostgresCreditLedgerStore(database).append({
      transactionId: randomUUID(),
      userId: f.userId,
      transactionType: 'admin_adjustment',
      amount: 5n,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(
      (
        await sql`SELECT balance,product_epoch FROM billing.credit_accounts WHERE user_id=${f.userId}::uuid`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ balance: '5', product_epoch: 1 }]);
    expect(
      (
        await sql`SELECT billing.deletion_credit_cutover_valid(${f.recordId}::uuid) AS financial,
      identity.ephemeral_reconciliation_valid(${f.recordId}::uuid,(SELECT completed_at FROM identity.account_deletion_records WHERE id=${f.recordId}::uuid)) AS provider,
      NOT EXISTS(SELECT 1 FROM identity.data_retention_records r WHERE deletion_record_id=${f.recordId}::uuid AND NOT identity.retention_record_valid(r)) AS retention,
      (SELECT identity.account_return_approval_valid(a,false) FROM platform.audit_logs a WHERE event_type='account.return-approved.v1' AND subject_id=${f.recordId}::uuid) AS approval`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ financial: true, provider: true, retention: true, approval: true }]);
    expect(await returned(f)).toMatchObject([{ valid: true }]);
    expect(await proofs(f)).toEqual(before);
  });
  it('rolls back every required-write suppression and succeeds on the unchanged command after recovery', async () => {
    const f = await createAccountReturnFixture(database),
      a = command(f),
      store = new PostgresAccountReturnStore(database, f.control);
    await sql`CREATE FUNCTION identity.test_suppress_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
      database,
    );
    try {
      for (const [table, operation, condition] of [
        ['platform.audit_logs', 'INSERT', "NEW.event_type='account.returned.v1'"],
        ['platform.outbox_events', 'INSERT', "NEW.event_type='account.returned.v1'"],
        ['identity.account_state_history', 'INSERT', "NEW.reason_code='approved_return'"],
        ['identity.user_settings', 'INSERT', 'true'],
        ['notification.notification_preferences', 'INSERT', 'true'],
        ['identity.account_deletion_records', 'UPDATE', 'NEW.reactivation_allowed'],
        ['identity.accounts', 'UPDATE', "NEW.state='guest'"],
      ]) {
        await sql
          .raw(
            `CREATE TRIGGER zz_test_suppress_return BEFORE ${operation} ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION identity.test_suppress_return()`,
          )
          .execute(database);
        try {
          await expect(store.return(a)).rejects.toThrow('missing');
        } finally {
          await sql.raw(`DROP TRIGGER zz_test_suppress_return ON ${table}`).execute(database);
        }
        await unchanged(f);
      }
    } finally {
      await sql`DROP FUNCTION identity.test_suppress_return()`.execute(database);
    }
    expect(await store.return(a)).toMatchObject({ returned: true, replayed: false });
  });
  it.each(['preview', 'settings', 'signup'])(
    'rechecks the empty-life and preserved-preview proof at deferred commit: %s',
    async (resource) => {
      const f = await createAccountReturnFixture(database),
        a = command(f);
      await expect(
        database.transaction().execute(async (tx) => {
          await new PostgresAccountReturnStore(tx, f.control).return(a);
          if (resource === 'preview')
            await sql`UPDATE identity.guest_preview_counters SET preview_count=0,first_preview_at=NULL,last_preview_at=NULL WHERE user_id=${f.userId}::uuid`.execute(
              tx,
            );
          else if (resource === 'settings')
            await sql`UPDATE identity.user_settings SET visibility_enabled=false WHERE user_id=${f.userId}::uuid`.execute(
              tx,
            );
          else
            await sql`INSERT INTO identity.signup_drafts(user_id,draft_data,schema_version,last_completed_step,expires_at,version,created_at,updated_at)
          VALUES(${f.userId}::uuid,'{}'::jsonb,1,NULL,NULL,1,clock_timestamp(),clock_timestamp())`.execute(
              tx,
            );
        }),
      ).rejects.toThrow(
        resource === 'signup'
          ? 'account Return is not empty'
          : 'account Return commit proof incomplete',
      );
      await unchanged(f);
    },
  );
  it('checks the original limited grant after a real Account lock wait', async () => {
    const f = await createAccountReturnFixture(database),
      grant = await new PostgresAccountControlSessionStore(database, 1).issue(
        f.control,
        randomUUID(),
      );
    let unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>((r) => {
        unlock = r;
      }),
      ready = new Promise<void>((r) => {
        locked = r;
      });
    const held = database.transaction().execute(async (tx) => {
      await sql`SELECT user_id FROM identity.accounts WHERE user_id=${f.userId}::uuid FOR UPDATE`.execute(
        tx,
      );
      locked();
      await gate;
    });
    await ready;
    const outcome = new PostgresAccountReturnStore(database, {
      ...f.control,
      controlGrantId: grant!.id,
    })
      .return(command(f))
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    try {
      await sql`SELECT pg_sleep(2)`.execute(database);
    } finally {
      unlock();
      await held;
    }
    expect(await outcome).toMatchObject({ error: { code: 'unauthorized' } });
    await unchanged(f);
  });
  it('rejects expiry at deferred commit without leaving a Return, using a native nontransactional witness', async () => {
    const f = expiryFixture!,
      grant = await new PostgresAccountControlSessionStore(database, 10).issue(
        f.control,
        randomUUID(),
      );
    await sql`CREATE SEQUENCE identity.test_return_control_expiry_seen`.execute(database);
    await sql`CREATE FUNCTION identity.test_return_control_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN IF NEW.event_type='account.returned.v1' THEN
      SELECT (metadata->>'expiresAt')::timestamptz INTO expiry FROM platform.audit_logs WHERE id=(NEW.metadata->>'controlGrantId')::uuid;
      PERFORM nextval('identity.test_return_control_expiry_seen');PERFORM pg_sleep(greatest(0,extract(epoch FROM expiry-clock_timestamp()))+0.05);END IF;RETURN NULL;END $$`.execute(
      database,
    );
    await sql`CREATE CONSTRAINT TRIGGER aa_test_return_control_expiry AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION identity.test_return_control_expiry()`.execute(
      database,
    );
    try {
      await expect(
        new PostgresAccountReturnStore(database, {
          ...f.control,
          controlGrantId: grant!.id,
        }).return(command(f)),
      ).rejects.toThrow('account Return commit proof incomplete');
      expect(
        (
          await sql`SELECT is_called FROM identity.test_return_control_expiry_seen`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ is_called: true }]);
    } finally {
      await sql`DROP TRIGGER aa_test_return_control_expiry ON platform.audit_logs`.execute(
        database,
      );
      await sql`DROP FUNCTION identity.test_return_control_expiry()`.execute(database);
      await sql`DROP SEQUENCE identity.test_return_control_expiry_seen`.execute(database);
    }
    await unchanged(f);
  });
  it('upgrades an approved completed schema-141 life without inventing Return or changing original proof', async () => {
    const previous = await mkdtemp(join(tmpdir(), 'nakh-return-upgrade-')),
      copied: string[] = [],
      target = await createIsolatedTestDatabase(url!, 'm8_return_upgrade');
    let legacy: NakhDatabase | undefined;
    try {
      for (const file of await readdir(resolve('migrations')))
        if (/^\d{6}_[a-z0-9_]+\.sql$/u.test(file) && Number(file.slice(0, 6)) <= 141) {
          await copyFile(join(resolve('migrations'), file), join(previous, file));
          copied.push(file);
        }
      await runMigrations(target.url, previous);
      legacy = createDatabase({
        url: target.url,
        poolMax: 4,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      const f = await createAccountReturnFixture(legacy),
        before = (
          await sql`SELECT to_jsonb(r) AS root FROM identity.account_deletion_records r WHERE id=${f.recordId}::uuid`.execute(
            legacy,
          )
        ).rows;
      expect((await runMigrations(target.url, resolve('migrations'))).applied).toEqual([
        '000142_m8_fresh_account_return.sql',
        '000143_m8_return_localization.sql',
        '000144_m8_fresh_entry_localization.sql',
        '000145_m8_retention_policy.sql',
        '000146_m8_retained_source_membership.sql',
        '000147_m8_support_content_release.sql',
        '000148_m8_protected_profile_change_lives.sql',
        '000149_m8_live_retained_safety_holds.sql',
        '000150_m8_batched_photo_sources.sql',
      ]);
      await verifyMigrations(target.url, resolve('migrations/verify'));
      expect(
        (
          await sql`SELECT to_jsonb(r) AS root FROM identity.account_deletion_records r WHERE id=${f.recordId}::uuid`.execute(
            legacy,
          )
        ).rows,
      ).toEqual(before);
      expect(
        await new PostgresAccountReturnStore(legacy, f.control).return(command(f)),
      ).toMatchObject({ returned: true, replayed: false });
    } finally {
      await legacy?.destroy();
      await target.destroy();
      for (const file of copied) await rm(join(previous, file));
      await rmdir(previous);
    }
  });
});
