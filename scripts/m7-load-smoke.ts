import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { UserSupportWrite } from '@nakh/application';
import { ApplicationError } from '@nakh/domain';
import { createDatabase, runMigrations, PostgresSupportStore } from '@nakh/persistence-postgres';
import { createReportUser } from '../packages/persistence-postgres/src/testing/report-fixture.js';
const url = process.env.NAKH_TEST_DATABASE_URL;
if (url === undefined)
  throw new Error('NAKH_TEST_DATABASE_URL is required for M7 concurrency evidence.');
await runMigrations(url, resolve(process.cwd(), 'migrations'));
const database = createDatabase({
  url,
  poolMax: 20,
  statementTimeoutMs: 15000,
  lockTimeoutMs: 10000,
});
const artifact = {
  schemaVersion: 1,
  scenario: 'M7-SHARED-SUPPORT-ADMISSION',
  users: 5,
  attemptsPerUser: 20,
  accepted: 0,
  denied: 0,
  replayed: 0,
  passed: false,
};
try {
  const store = new PostgresSupportStore(database);
  for (let user = 0; user < artifact.users; user++) {
    const userId = await createReportUser(database);
    const writes: UserSupportWrite[] = Array.from({ length: artifact.attemptsPerUser }, () => ({
      userId,
      supportThreadId: randomUUID(),
      messageId: randomUUID(),
      eventId: randomUUID(),
      commandId: randomUUID(),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      requestDigest: randomUUID().replaceAll('-', '').repeat(2),
      normalizedText: 'Synthetic private support load fixture',
    }));
    const results = await Promise.allSettled(writes.map((write) => store.open(write)));
    const accepted = results.flatMap((result, index) =>
      result.status === 'fulfilled' ? [writes[index]!] : [],
    );
    const denied = results.filter(
      (result) =>
        result.status === 'rejected' &&
        result.reason instanceof ApplicationError &&
        result.reason.code === 'support_unanswered_limit',
    );
    if (accepted.length !== 2 || denied.length !== 18)
      throw new Error('M7 support admission invariant failed.');
    artifact.accepted += accepted.length;
    artifact.denied += denied.length;
    const replays = await Promise.all(Array.from({ length: 20 }, () => store.open(accepted[0]!)));
    if (replays.some((result) => !result.replayed))
      throw new Error('M7 support replay invariant failed.');
    artifact.replayed += replays.length;
    const count = await database
      .selectFrom('support.support_messages')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('sender_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    if (Number(count.count) !== 2) throw new Error('M7 support duplicate-write invariant failed.');
  }
  artifact.passed = true;
} catch {
  throw new Error('M7 support load smoke failed; private database diagnostics are not exported.');
} finally {
  await mkdir(resolve(process.cwd(), 'artifacts'), { recursive: true });
  await writeFile(
    resolve(process.cwd(), 'artifacts/m7-load-smoke.json'),
    JSON.stringify(artifact, null, 2) + '\n',
  );
  await database.destroy();
}
process.stdout.write(JSON.stringify(artifact) + '\n');
