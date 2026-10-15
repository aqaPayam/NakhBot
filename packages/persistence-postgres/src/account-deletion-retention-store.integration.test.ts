import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDeletionLease } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations, verifyMigrations } from './migrations.js';
import { createIsolatedTestDatabase } from './testing/isolated-database.js';
import { createEphemeralDeletionFixture } from './testing/ephemeral-deletion-fixture.js';
import { PostgresAccountDeletionEphemeralStore } from './account-deletion-ephemeral-store.js';
import { PostgresAccountDeletionSessionStore } from './account-deletion-session-store.js';
import { PostgresAccountDeletionRetentionStore } from './account-deletion-retention-store.js';
import { PostgresAccountDeletionWorkStore } from './account-deletion-work-store.js';
import { DELETION_REGISTRY } from './deletion-registry.js';
import { PostgresAccountDeletionSampleStore } from './account-deletion-sample-store.js';

const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)(
  'M8 provisional retention inventory and independent checkpoint',
  () => {
    let database: NakhDatabase,
      isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>,
      store: PostgresAccountDeletionRetentionStore,
      work: PostgresAccountDeletionWorkStore;
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(url!, 'm8_retention_manifest');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 30000,
        lockTimeoutMs: 15000,
      });
      store = new PostgresAccountDeletionRetentionStore(database);
      work = new PostgresAccountDeletionWorkStore(database);
    });
    afterAll(async () => {
      await database?.destroy();
      await isolated?.destroy();
    });
    beforeEach(async () => {
      await sql`UPDATE identity.account_deletion_work SET lease_owner=NULL,lease_expires_at=NULL,available_at=clock_timestamp()+interval '1 day'`.execute(
        database,
      );
    });
    async function scene(samples = 0): Promise<AccountDeletionLease> {
      const item = await createEphemeralDeletionFixture(
        database,
        async (userId) => {
          for (let n = 0; n < samples; n++)
            await database
              .insertInto('platform.sample_effects')
              .values({
                id: randomUUID(),
                actor_user_id: userId,
                name: 'private retained-source fixture',
                created_at: new Date(),
              })
              .execute();
        },
        async (lease) => {
          if (samples > 0)
            while (
              (await new PostgresAccountDeletionSampleStore(database).purgeNext(lease)).hasMore
            ) {
              /* bounded */
            }
        },
      );
      await new PostgresAccountDeletionSessionStore(database).revokeNext(item.lease);
      const ephemeral = new PostgresAccountDeletionEphemeralStore(
        database,
        'm8-retention-test',
        'a'.repeat(64),
      );
      // Native provider receipts are a fixture of the already independently tested
      // phase. This suite does not claim to inspect Redis or operator drain evidence.
      for (let n = 0; n < 6; n++) {
        const op = (await ephemeral.claimNext(item.lease)).operation!;
        await ephemeral.complete(item.lease, op.id, {
          cursor: op.stage.startsWith('queue_') ? { redisCursor: '0', pendingKeys: [] } : '0',
          more: false,
          found: 0,
        });
      }
      expect(await ephemeral.finish(item.lease)).toEqual({ completed: true });
      const [lease] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
      expect(lease?.deletionRecordId).toBe(item.recordId);
      return lease!;
    }
    async function complete(lease: AccountDeletionLease): Promise<void> {
      for (let n = 0; n < 20; n++) if (!(await store.recordNext(lease)).hasMore) return;
      throw new Error('Retention inventory did not converge.');
    }
    async function rows(lease: AccountDeletionLease): Promise<readonly Record<string, unknown>[]> {
      return (
        await sql<
          Record<string, unknown>
        >`SELECT * FROM identity.data_retention_records WHERE deletion_record_id=${lease.deletionRecordId}::uuid ORDER BY retained_data_type`.execute(
          database,
        )
      ).rows;
    }
    async function manifestsOnly(lease: AccountDeletionLease): Promise<void> {
      for (let n = 0; n < 20; n++) {
        const row = (
          await sql<{
            count: number;
          }>`SELECT identity.record_retention_manifest_batch(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration}) AS count`.execute(
            database,
          )
        ).rows[0]!;
        if (row.count === 0) return;
      }
      throw new Error('Manifest fixture did not converge');
    }
    async function sources(
      lease: AccountDeletionLease,
    ): Promise<
      readonly { id: string; metadata: Record<string, unknown>; valid: boolean; matches: boolean }[]
    > {
      return (
        await sql<{
          id: string;
          metadata: Record<string, unknown>;
          valid: boolean;
          matches: boolean;
        }>`SELECT a.id,a.metadata,
        identity.retained_source_proof_valid(a,false) AS valid,
        identity.retained_source_matches(a.subject_id,a.metadata->>'resource',a.metadata->>'rowKeyHash',a.metadata->>'rowHash') AS matches
        FROM platform.audit_logs a WHERE a.subject_id=${lease.deletionRecordId}::uuid AND a.event_type='account.retained-source-recorded.v1' ORDER BY a.id`.execute(
          database,
        )
      ).rows;
    }
    it('captures bounded exact original source membership before checkpoint without copying keys or contents', async () => {
      const lease = await scene(11);
      await manifestsOnly(lease);
      expect(await sources(lease)).toHaveLength(0);
      expect(await store.finish(lease)).toEqual({ completed: false });
      const before = (
        await sql`SELECT jsonb_agg(to_jsonb(s) ORDER BY id) AS rows FROM platform.sample_reference_anchors s WHERE actor_user_id=${lease.userId}::uuid`.execute(
          database,
        )
      ).rows;
      let count = 0;
      for (let n = 0; n < 10; n++) {
        const added = (
          await sql<{
            count: number;
          }>`SELECT identity.record_retained_source_batch(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration}) AS count`.execute(
            database,
          )
        ).rows[0]!.count;
        expect(added).toBeGreaterThanOrEqual(0);
        expect(added).toBeLessThanOrEqual(10);
        count += added;
        if (added === 0) break;
        if (n === 0) {
          expect(added).toBe(10);
          expect(await store.finish(lease)).toEqual({ completed: false });
        }
      }
      const proof = await sources(lease);
      expect(proof).toHaveLength(count);
      expect(
        proof.filter((x) => x.metadata.resource === 'platform.sample_reference_anchors'),
      ).toHaveLength(11);
      expect(proof.every((x) => x.valid && x.matches)).toBe(true);
      expect(JSON.stringify(proof)).not.toContain('private retained-source fixture');
      expect(Object.keys(proof[0]!.metadata).sort()).toEqual(
        [
          'retentionRecordId',
          'resource',
          'registryHash',
          'rowKeyHash',
          'rowHash',
          'leaseOwner',
          'leaseGeneration',
          'leaseExpiresAtEpoch',
          'transactionId',
        ].sort(),
      );
      expect(
        (
          await sql`SELECT jsonb_agg(to_jsonb(s) ORDER BY id) AS rows FROM platform.sample_reference_anchors s WHERE actor_user_id=${lease.userId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual(before);
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL TimeZone='Pacific/Auckland'`.execute(tx);
        const a = proof[0]!;
        expect(
          (
            await sql<{
              matches: boolean;
            }>`SELECT identity.retained_source_matches(${lease.deletionRecordId}::uuid,${a.metadata.resource}::text,${a.metadata.rowKeyHash}::text,${a.metadata.rowHash}::text) AS matches`.execute(
              tx,
            )
          ).rows,
        ).toEqual([{ matches: true }]);
        expect(
          (await sql<{ zone: string }>`SELECT current_setting('TimeZone') AS zone`.execute(tx))
            .rows,
        ).toEqual([{ zone: 'Pacific/Auckland' }]);
      });
      expect(await store.finish(lease)).toEqual({ completed: true });
      await expect(
        sql`SELECT identity.record_retained_source_batch(${lease.deletionRecordId}::uuid,${lease.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(
          database,
        ),
      ).rejects.toThrow();
    });
    it('serializes source capture retries, rejects foreign ownership and freezes historical fingerprints', async () => {
      const lease = await scene(1),
        other = await scene();
      await manifestsOnly(lease);
      await expect(
        sql`SELECT identity.record_retained_source_batch(${lease.deletionRecordId}::uuid,${other.userId}::uuid,${lease.leaseOwner}::uuid,${lease.leaseGeneration})`.execute(
          database,
        ),
      ).rejects.toThrow();
      await Promise.all(Array.from({ length: 20 }, () => store.recordNext(lease)));
      const proof = await sources(lease);
      expect(proof.length).toBeGreaterThan(1);
      expect(proof.every((x) => x.valid && x.matches)).toBe(true);
      await Promise.all(Array.from({ length: 20 }, () => store.recordNext(lease)));
      expect(await sources(lease)).toEqual(proof);
      const sample = proof.find(
        (x) => x.metadata.resource === 'platform.sample_reference_anchors',
      )!;
      await expect(
        sql`UPDATE platform.audit_logs SET metadata='{}'::jsonb WHERE id=${sample.id}::uuid`.execute(
          database,
        ),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM platform.audit_logs WHERE id=${sample.id}::uuid`.execute(database),
      ).rejects.toThrow();
      await expect(
        sql`INSERT INTO platform.audit_logs(id,category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,metadata,command_id,request_id,occurred_at) SELECT gen_random_uuid(),category,event_type,actor_type,actor_user_id,actor_admin_id,subject_type,subject_id,result_code,metadata_schema_version,
        metadata||jsonb_build_object('rowKeyHash',${'a'.repeat(64)}),command_id,request_id,clock_timestamp()
        FROM platform.audit_logs WHERE id=${sample.id}::uuid`.execute(database),
      ).rejects.toThrow();
      const anchor = (
        await sql<{
          id: string;
          digest: string;
        }>`SELECT id,name_digest AS digest FROM platform.sample_reference_anchors WHERE actor_user_id=${lease.userId}::uuid`.execute(
          database,
        )
      ).rows[0]!;
      await database.transaction().execute(async (tx) => {
        await sql`SET LOCAL session_replication_role=replica`.execute(tx);
        await sql`UPDATE platform.sample_reference_anchors SET name_digest=${'b'.repeat(64)} WHERE id=${anchor.id}::uuid`.execute(
          tx,
        );
      });
      try {
        expect((await sources(lease)).find((x) => x.id === sample.id)).toMatchObject({
          valid: true,
          matches: false,
        });
        expect(await sources(other)).toHaveLength(0);
      } finally {
        await database.transaction().execute(async (tx) => {
          await sql`SET LOCAL session_replication_role=replica`.execute(tx);
          await sql`UPDATE platform.sample_reference_anchors SET name_digest=${anchor.digest} WHERE id=${anchor.id}::uuid`.execute(
            tx,
          );
        });
      }
    });
    it('rolls back the owning batch when its mandatory source audit is suppressed', async () => {
      const lease = await scene();
      await manifestsOnly(lease);
      await sql`CREATE FUNCTION public.suppress_retained_source() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.event_type='account.retained-source-recorded.v1' THEN RETURN NULL; END IF; RETURN NEW; END $$;
        CREATE TRIGGER aaa_suppress_retained_source BEFORE INSERT ON platform.audit_logs FOR EACH ROW EXECUTE FUNCTION public.suppress_retained_source()`.execute(
        database,
      );
      try {
        await expect(store.recordNext(lease)).rejects.toThrow('retained source audit missing');
        expect(await sources(lease)).toHaveLength(0);
        expect(await store.finish(lease)).toEqual({ completed: false });
      } finally {
        await sql`DROP TRIGGER aaa_suppress_retained_source ON platform.audit_logs; DROP FUNCTION public.suppress_retained_source()`.execute(
          database,
        );
      }
      await complete(lease);
      expect(await store.finish(lease)).toEqual({ completed: true });
    });
    it('rejects source capture that reaches deferred commit after its exact lease expires', async () => {
      const original = await scene();
      await manifestsOnly(original);
      await work.release(original);
      await sql`CREATE SEQUENCE public.source_expiry_seen;
        CREATE FUNCTION public.delay_source_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN
          IF NEW.event_type='account.retained-source-recorded.v1' THEN
            PERFORM nextval('public.source_expiry_seen');
            expiry:=to_timestamp((NEW.metadata->>'leaseExpiresAtEpoch')::double precision);
            PERFORM pg_sleep(greatest(0,extract(epoch FROM expiry-clock_timestamp()))+0.05);
          END IF; RETURN NULL; END $$;
        CREATE CONSTRAINT TRIGGER aaa_delay_source_expiry AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION public.delay_source_expiry()`.execute(database);
      const [lease] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 });
      expect(lease?.deletionRecordId).toBe(original.deletionRecordId);
      try {
        await expect(store.recordNext(lease!)).rejects.toThrow('retained source proof incomplete');
        expect(
          (await sql`SELECT is_called FROM public.source_expiry_seen`.execute(database)).rows,
        ).toEqual([{ is_called: true }]);
        expect(await sources(lease!)).toHaveLength(0);
      } finally {
        await sql`DROP TRIGGER aaa_delay_source_expiry ON platform.audit_logs; DROP FUNCTION public.delay_source_expiry(); DROP SEQUENCE public.source_expiry_seen`.execute(
          database,
        );
      }
    });
    it('records every reviewed category in bounded batches, with no invented period or copied contents', async () => {
      const lease = await scene();
      expect(await store.finish(lease)).toEqual({ completed: false });
      await store.recordNext(lease);
      expect(await rows(lease)).toHaveLength(10);
      await complete(lease);
      const records = await rows(lease);
      expect(records).toHaveLength(DELETION_REGISTRY.length);
      expect(records.map((r) => r.retained_data_type)).toEqual(
        DELETION_REGISTRY.map((e) => e.table).sort(),
      );
      for (const [index, entry] of [...DELETION_REGISTRY]
        .sort((a, b) => a.table.localeCompare(b.table))
        .entries()) {
        expect(records[index]).toMatchObject({
          user_id: lease.userId,
          deletion_record_id: lease.deletionRecordId,
          classification: entry.classification,
          disposition: entry.action,
          legal_or_safety_reason: entry.purpose,
          access_policy:
            entry.classification === 'reference' ? 'reference_only' : 'purpose_restricted',
          policy_status:
            entry.releasePolicy === 'approval_required' ? 'pending_approval' : 'not_applicable',
          retention_expires_at: null,
          indefinite_reason: null,
          deleted_at: null,
        });
        if (entry.subjectScope === null) expect(records[index]!.observed_present).toBeNull();
      }
      expect(await store.finish(lease)).toEqual({ completed: true });
      expect(await store.finish(lease)).toEqual({ completed: true });
      expect(
        (
          await sql`SELECT phase,checkpoint_version,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
            database,
          )
        ).rows,
      ).toEqual([
        {
          phase: 'verification',
          checkpoint_version: 7,
          completed_at: null,
          reactivation_allowed: false,
        },
      ]);
    });
    it('serializes twenty retries without duplicate records or audit facts', async () => {
      const lease = await scene();
      await Promise.all(Array.from({ length: 20 }, () => store.recordNext(lease)));
      const snapshot = await rows(lease);
      expect(snapshot).toHaveLength(DELETION_REGISTRY.length);
      await Promise.all(Array.from({ length: 20 }, () => store.recordNext(lease)));
      expect(await rows(lease)).toEqual(snapshot);
      expect(
        (
          await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE subject_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-retention-recorded.v1'`.execute(
            database,
          )
        ).rows,
      ).toEqual([{ count: DELETION_REGISTRY.length }]);
    });
    it('resumes a durable partial inventory under a new lease generation and rejects the old worker', async () => {
      const lease = await scene();
      await store.recordNext(lease);
      const original = await rows(lease);
      await work.release(lease);
      const [next] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 120000 });
      await expect(store.recordNext(lease)).rejects.toBeDefined();
      await expect(store.finish(lease)).rejects.toBeDefined();
      await complete(next!);
      expect((await rows(next!)).filter((r) => original.some((o) => o.id === r.id))).toEqual(
        original,
      );
      expect(await store.finish(next!)).toEqual({ completed: true });
    });
    it('keeps release and policy mutation disabled, including forged indefinite justification', async () => {
      const lease = await scene();
      await complete(lease);
      for (const statement of [
        sql`DELETE FROM identity.data_retention_records WHERE deletion_record_id=${lease.deletionRecordId}::uuid`,
        sql`UPDATE identity.data_retention_records SET policy_status='not_applicable' WHERE deletion_record_id=${lease.deletionRecordId}::uuid`,
        sql`UPDATE identity.data_retention_records SET indefinite_reason='unknown is not an approval' WHERE deletion_record_id=${lease.deletionRecordId}::uuid`,
        sql`UPDATE identity.data_retention_records SET deleted_at=clock_timestamp() WHERE deletion_record_id=${lease.deletionRecordId}::uuid`,
      ])
        await expect(statement.execute(database)).rejects.toMatchObject({ code: '55000' });
    });
    it.each(['audit', 'record'])(
      'rolls back an entire batch if its mandatory %s write is suppressed',
      async (kind) => {
        const lease = await scene();
        await sql`CREATE FUNCTION public.suppress_retention_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
          database,
        );
        const relation =
          kind === 'audit' ? 'platform.audit_logs' : 'identity.data_retention_records';
        const when =
          kind === 'audit' ? "WHEN (NEW.event_type='account.deletion-retention-recorded.v1')" : '';
        try {
          await sql
            .raw(
              `CREATE TRIGGER suppress_retention_write BEFORE INSERT ON ${relation} FOR EACH ROW ${when} EXECUTE FUNCTION public.suppress_retention_write()`,
            )
            .execute(database);
          await expect(store.recordNext(lease)).rejects.toMatchObject({ code: '23514' });
          expect(await rows(lease)).toHaveLength(0);
          expect(
            (
              await sql`SELECT count(*)::integer AS count FROM platform.audit_logs WHERE subject_id=${lease.deletionRecordId}::uuid AND event_type='account.deletion-retention-recorded.v1'`.execute(
                database,
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
        } finally {
          await sql
            .raw(`DROP TRIGGER IF EXISTS suppress_retention_write ON ${relation}`)
            .execute(database);
          await sql`DROP FUNCTION public.suppress_retention_write()`.execute(database);
        }
        await complete(lease);
        expect(await store.finish(lease)).toEqual({ completed: true });
      },
    );
    it.each(['audit', 'event', 'receipt', 'root', 'work'])(
      'keeps checkpoint six intact when its mandatory %s write is suppressed',
      async (kind) => {
        const lease = await scene();
        await complete(lease);
        const relations: Readonly<Record<string, string>> = {
          audit: 'platform.audit_logs',
          event: 'platform.outbox_events',
          receipt: 'identity.account_deletion_phase_receipts',
          root: 'identity.account_deletion_records',
          work: 'identity.account_deletion_work',
        };
        const relation = relations[kind]!;
        const update = kind === 'root' || kind === 'work';
        const condition =
          kind === 'audit' || kind === 'event'
            ? "NEW.event_type='account.deletion-phase-completed.v1'"
            : kind === 'receipt'
              ? "NEW.completed_phase='retention_manifest'"
              : "NEW.phase='verification'";
        await sql`CREATE FUNCTION public.suppress_retention_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`.execute(
          database,
        );
        try {
          await sql
            .raw(
              `CREATE TRIGGER suppress_retention_checkpoint BEFORE ${update ? 'UPDATE' : 'INSERT'} ON ${relation} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public.suppress_retention_checkpoint()`,
            )
            .execute(database);
          await expect(store.finish(lease)).rejects.toMatchObject({ code: '23514' });
          expect(
            (
              await sql`SELECT phase,checkpoint_version,completed_at,reactivation_allowed FROM identity.account_deletion_records WHERE id=${lease.deletionRecordId}::uuid`.execute(
                database,
              )
            ).rows,
          ).toEqual([
            {
              phase: 'retention_manifest',
              checkpoint_version: 6,
              completed_at: null,
              reactivation_allowed: false,
            },
          ]);
          expect(
            (
              await sql`SELECT count(*)::integer AS count FROM identity.account_deletion_phase_receipts WHERE deletion_record_id=${lease.deletionRecordId}::uuid AND completed_phase='retention_manifest'`.execute(
                database,
              )
            ).rows,
          ).toEqual([{ count: 0 }]);
        } finally {
          await sql
            .raw(`DROP TRIGGER IF EXISTS suppress_retention_checkpoint ON ${relation}`)
            .execute(database);
          await sql`DROP FUNCTION public.suppress_retention_checkpoint()`.execute(database);
        }
        expect(await store.finish(lease)).toEqual({ completed: true });
      },
    );
    it('rejects a lease that expires at deferred commit and leaves no partial batch', async () => {
      const original = await scene();
      await work.release(original);
      await sql`CREATE SEQUENCE public.retention_expiry_probe`.execute(database);
      await sql`CREATE FUNCTION public.delay_retention_commit() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE expiry timestamptz; BEGIN
      PERFORM nextval('public.retention_expiry_probe');
      SELECT lease_expires_at INTO expiry FROM identity.data_retention_records WHERE id=(NEW.metadata->>'retentionRecordId')::uuid;
      IF expiry IS NULL THEN RAISE EXCEPTION 'retention expiry source absent'; END IF;
      PERFORM pg_sleep(greatest(0,extract(epoch FROM expiry-clock_timestamp()))+0.1); RETURN NULL;
    END $$`.execute(database);
      // Runs before the required audit check. The nontransactional sequence proves
      // the deferred trigger was reached, rather than merely expiring before work.
      await sql`CREATE CONSTRAINT TRIGGER a_retention_expiry_probe AFTER INSERT ON platform.audit_logs DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW WHEN (NEW.event_type='account.deletion-retention-recorded.v1') EXECUTE FUNCTION public.delay_retention_commit()`.execute(
        database,
      );
      const [lease] = await work.claimDue({ workerId: randomUUID(), limit: 1, leaseMs: 10000 });
      expect(lease?.deletionRecordId).toBe(original.deletionRecordId);
      try {
        await expect(store.recordNext(lease!)).rejects.toMatchObject({ code: '23514' });
        expect(
          (
            await sql`SELECT last_value::integer AS value,is_called FROM public.retention_expiry_probe`.execute(
              database,
            )
          ).rows,
        ).toEqual([{ value: 1, is_called: true }]);
        expect(await rows(lease!)).toHaveLength(0);
      } finally {
        await sql`DROP TRIGGER a_retention_expiry_probe ON platform.audit_logs`.execute(database);
        await sql`DROP FUNCTION public.delay_retention_commit()`.execute(database);
        await sql`DROP SEQUENCE public.retention_expiry_probe`.execute(database);
      }
    });
    it('independently rejects corrupted history rather than accepting a complete row count', async () => {
      const lease = await scene();
      await complete(lease);
      const record = (await rows(lease))[0]!;
      await database.transaction().execute(async (tx) => {
        await sql`ALTER TABLE identity.data_retention_records DISABLE TRIGGER USER`.execute(tx);
        await sql`UPDATE identity.data_retention_records SET registry_hash=${'b'.repeat(64)} WHERE id=${record.id}::uuid`.execute(
          tx,
        );
        await sql`ALTER TABLE identity.data_retention_records ENABLE TRIGGER USER`.execute(tx);
      });
      try {
        expect(await store.finish(lease)).toEqual({ completed: false });
      } finally {
        await database.transaction().execute(async (tx) => {
          await sql`ALTER TABLE identity.data_retention_records DISABLE TRIGGER USER`.execute(tx);
          await sql`UPDATE identity.data_retention_records SET registry_hash=${record.registry_hash} WHERE id=${record.id}::uuid`.execute(
            tx,
          );
          await sql`ALTER TABLE identity.data_retention_records ENABLE TRIGGER USER`.execute(tx);
        });
      }
      expect(await store.finish(lease)).toEqual({ completed: true });
    });
    it('denies schema drift before recording any inventory', async () => {
      const lease = await scene();
      await sql`CREATE TABLE public.unclassified_retention_probe(value text)`.execute(database);
      try {
        await expect(store.recordNext(lease)).rejects.toBeDefined();
        expect(await rows(lease)).toHaveLength(0);
      } finally {
        await sql`DROP TABLE public.unclassified_retention_probe`.execute(database);
      }
    });
  },
);
