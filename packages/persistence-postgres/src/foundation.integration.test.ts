import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '@nakh/domain';
import { CreateSampleEffectHandler } from '@nakh/application';

import { createDatabase, type NakhDatabase } from './database.js';
import {
  PostgresFoundationStore,
  PostgresInboxStore,
  SystemIdGenerator,
} from './foundation-store.js';
import { runMigrations } from './migrations.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)('PostgreSQL reliability foundation', () => {
  let database: NakhDatabase;

  beforeAll(async () => {
    await runMigrations(databaseUrl!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: databaseUrl!,
      poolMax: 5,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 1_000,
    });
  });

  afterAll(async () => {
    await database?.destroy();
  });

  it('creates one effect and outbox event for a duplicate command', async () => {
    await database.deleteFrom('platform.sample_projections').execute();
    await database.deleteFrom('platform.inbox_messages').execute();
    await database.deleteFrom('platform.outbox_events').execute();
    await database.deleteFrom('platform.sample_effects').execute();
    await database.deleteFrom('platform.idempotency_records').execute();

    const handler = new CreateSampleEffectHandler(
      new PostgresFoundationStore(database),
      new SystemIdGenerator(),
      new SystemClock(),
    );
    const command = {
      commandId: randomUUID(),
      commandType: 'platform.create-sample-effect' as const,
      schemaVersion: 1 as const,
      actor: { userId: randomUUID(), kind: 'system' as const },
      requestId: randomUUID(),
      idempotencyKey: `test-${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      locale: 'en',
      data: { name: 'one-effect' },
    };

    const first = await handler.execute(command);
    const second = await handler.execute({
      ...command,
      commandId: randomUUID(),
      requestId: randomUUID(),
    });

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      effectId: first.effectId,
      eventId: first.eventId,
      replayed: true,
    });
    expect(await database.selectFrom('platform.sample_effects').selectAll().execute()).toHaveLength(
      1,
    );
    expect(await database.selectFrom('platform.outbox_events').selectAll().execute()).toHaveLength(
      1,
    );
  });

  it('rolls back a crashed consumer and projects once after replay', async () => {
    const eventRow = await database
      .selectFrom('platform.outbox_events')
      .selectAll()
      .executeTakeFirstOrThrow();
    const event = {
      id: eventRow.id,
      eventType: eventRow.event_type,
      schemaVersion: eventRow.schema_version,
      aggregateType: eventRow.aggregate_type,
      aggregateId: eventRow.aggregate_id,
      payload: eventRow.payload,
      occurredAt: eventRow.occurred_at.toISOString(),
      correlationId: eventRow.correlation_id,
      causationId: eventRow.causation_id,
    };
    const inbox = new PostgresInboxStore(database, new SystemIdGenerator());

    await expect(
      inbox.processSampleEvent(event, {
        afterProjection: () => {
          throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(
      await database.selectFrom('platform.sample_projections').selectAll().execute(),
    ).toHaveLength(0);

    await expect(inbox.processSampleEvent(event)).resolves.toBe('processed');
    await expect(inbox.processSampleEvent(event)).resolves.toBe('duplicate');
    expect(
      await database.selectFrom('platform.sample_projections').selectAll().execute(),
    ).toHaveLength(1);
    expect(await database.selectFrom('platform.inbox_messages').selectAll().execute()).toHaveLength(
      1,
    );
  });
});
