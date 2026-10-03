import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReportTokens } from '@nakh/application';
import { createDatabase, type NakhDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import {
  createReportChat,
  createReportMessage,
  createReportUser,
} from './testing/report-fixture.js';
import {
  PostgresPrepareMessageReportEvidenceHandler,
  resolveMessageReportSource,
} from './message-report-source-store.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
describe.skipIf(url === undefined)('participant-bound message report preparation', () => {
  let database: NakhDatabase;
  beforeAll(async () => {
    await runMigrations(url!, resolve(process.cwd(), 'migrations'));
    database = createDatabase({
      url: url!,
      poolMax: 8,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 10000,
    });
  });
  afterAll(async () => {
    if (database !== undefined) await database.destroy();
  });
  it('issues opaque exact-message intents to either stored participant and denies outsiders and unrelated sources', async () => {
    const first = await createReportUser(database),
      second = await createReportUser(database),
      outsider = await createReportUser(database);
    const chat = await createReportChat(database, first, second),
      messageId = await createReportMessage(database, chat.chatSessionId, second);
    const state = new Map<string, string>(),
      tokens = new ReportTokens(
        {
          get: (id) => Promise.resolve(state.get(id)),
          putIfAbsent: (id, value) => {
            state.set(id, value);
            return Promise.resolve(true);
          },
        },
        Buffer.alloc(32, 82),
      );
    const handler = new PostgresPrepareMessageReportEvidenceHandler(database, tokens),
      source = { kind: 'message' as const, referenceId: messageId };
    for (const [reporter, target] of [
      [first, second],
      [second, first],
    ] as const) {
      const actor = { kind: 'user' as const, userId: reporter },
        query = {
          actor,
          requestId: randomUUID(),
          sourceActionToken: (await tokens.issueSource(reporter, source)).token,
          requestedEvidenceTypes: ['message' as const],
        };
      const prepared = await handler.execute(query, actor);
      expect(await tokens.resolveIntent(prepared.evidenceIntentToken, reporter)).toEqual({
        source,
        targetUserId: target,
        evidence: [{ evidenceType: 'message', referenceId: messageId }],
      });
      for (const id of [first, second, messageId, chat.chatSessionId])
        expect(JSON.stringify(prepared)).not.toContain(id);
      expect(await tokens.resolveIntent(prepared.evidenceIntentToken, outsider)).toBeUndefined();
      await expect(
        handler.execute({ ...query, requestedEvidenceTypes: ['message', 'chat'] }, actor),
      ).rejects.toMatchObject({ code: 'report_unavailable' });
    }
    expect(await resolveMessageReportSource(database, outsider, source)).toBeUndefined();
    expect(
      await resolveMessageReportSource(database, first, {
        kind: 'match',
        referenceId: chat.matchId,
      }),
    ).toBeUndefined();
    const unrelated = await createReportChat(database, outsider, await createReportUser(database)),
      unrelatedMessage = await createReportMessage(database, unrelated.chatSessionId, outsider);
    expect(
      await resolveMessageReportSource(database, first, {
        kind: 'message',
        referenceId: unrelatedMessage,
      }),
    ).toBeUndefined();
  });
  it('rejects purged messages but retains participant authorization for live evidence after session closure', async () => {
    const reporter = await createReportUser(database),
      target = await createReportUser(database),
      chat = await createReportChat(database, reporter, target),
      older = await createReportMessage(database, chat.chatSessionId, target),
      retained = await createReportMessage(database, chat.chatSessionId, target);
    await database.deleteFrom('chat.chat_messages').where('id', '=', older).execute();
    expect(
      await resolveMessageReportSource(database, reporter, { kind: 'message', referenceId: older }),
    ).toBeUndefined();
    await database
      .updateTable('chat.chat_sessions')
      .set({
        status: 'closed',
        closed_reason: 'admin_action',
        closed_at: new Date(),
        version: sql<number>`version + 1`,
      })
      .where('id', '=', chat.chatSessionId)
      .execute();
    expect(
      await resolveMessageReportSource(database, reporter, {
        kind: 'message',
        referenceId: retained,
      }),
    ).toMatchObject({
      targetUserId: target,
      evidence: [{ evidenceType: 'message', referenceId: retained }],
    });
  });
});
