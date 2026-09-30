import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportTokens } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import {
  PostgresChatReportSourceStore,
  PostgresPrepareChatReportEvidenceHandler,
} from './chat-report-source-store.js';
import { createReportChat, createReportUser } from './testing/report-fixture.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('participant-bound chat report preparation', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 6,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 5000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  it('prepares either participant with opaque typed evidence and denies outsiders, substitutions and unrelated source kinds', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database),
      outsider = await createReportUser(database);
    const chat = await createReportChat(database, first, second),
      source = { kind: 'match' as const, referenceId: chat.matchId };
    const values = new Map<string, string>(),
      tokens = new ReportTokens(
        {
          get: (id) => Promise.resolve(values.get(id)),
          putIfAbsent: (id, value) => {
            values.set(id, value);
            return Promise.resolve(true);
          },
        },
        Buffer.alloc(32, 72),
      );
    const handler = new PostgresPrepareChatReportEvidenceHandler(database, tokens);
    for (const userId of [first, second, outsider]) {
      const actor = { kind: 'user' as const, userId };
      const query = {
        actor,
        requestId: randomUUID(),
        sourceActionToken: (await tokens.issueSource(userId, source)).token,
        requestedEvidenceTypes: ['chat' as const],
      };
      if (userId === outsider) {
        await expect(handler.execute(query, actor)).rejects.toMatchObject({
          code: 'report_unavailable',
        });
        continue;
      }
      const prepared = await handler.execute(query, actor);
      expect(await tokens.resolveIntent(prepared.evidenceIntentToken, userId)).toEqual({
        source,
        targetUserId: userId === first ? second : first,
        evidence: [{ evidenceType: 'chat', referenceId: chat.chatSessionId }],
      });
      for (const id of [first, second, chat.matchId, chat.chatSessionId])
        expect(JSON.stringify(prepared)).not.toContain(id);
      await expect(handler.execute(query, { ...actor, userId: outsider })).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await expect(
        handler.execute({ ...query, requestedEvidenceTypes: ['chat', 'profile'] }, actor),
      ).rejects.toMatchObject({ code: 'report_unavailable' });
    }
    const store = new PostgresChatReportSourceStore(database);
    expect(await store.resolve(first, { ...source, kind: 'received_like' })).toBeUndefined();
    expect(await store.resolve(first, { ...source, referenceId: randomUUID() })).toBeUndefined();
    await database
      .updateTable('matching.matches')
      .set({ status: 'closed', closed_at: new Date(), version: 2 })
      .where('id', '=', chat.matchId)
      .execute();
    expect(await store.resolve(first, source)).toBeUndefined();
  });
  it('rejects a closed session even while its match remains active', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database);
    const chat = await createReportChat(database, first, second);
    await database
      .updateTable('chat.chat_sessions')
      .set({ status: 'closed', closed_at: new Date(), closed_reason: 'admin_action', version: 2 })
      .where('id', '=', chat.chatSessionId)
      .execute();
    expect(
      await new PostgresChatReportSourceStore(database).resolve(first, {
        kind: 'match',
        referenceId: chat.matchId,
      }),
    ).toBeUndefined();
  });
});
