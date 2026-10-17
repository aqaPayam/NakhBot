import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  adminTotpCode,
  adminTotpStep,
  ReportSnapshotKeyRing,
  ReportTokenFactory,
} from '@nakh/application';
import {
  createRedisConnection,
  RedisUserOpaqueTokenStores,
  RedisOpaqueTokenStore,
} from '@nakh/queue-redis';
import { TelegramAdminReportQueueState } from '@nakh/telegram';
import {
  createDatabase,
  runMigrations,
  verifyMigrations,
  createPostgresUserSessions,
  PostgresAdminTotpOperator,
  PostgresAccountReturnStore,
  type NakhDatabase,
} from '@nakh/persistence-postgres';
import { createIsolatedTestDatabase } from '../../../packages/persistence-postgres/src/testing/isolated-database.js';
import {
  createReportUser,
  createReportLike,
  createRetainedPhotoReview,
} from '../../../packages/persistence-postgres/src/testing/report-fixture.js';
import { createAccountReturnFixture } from '../../../packages/persistence-postgres/src/testing/account-return-fixture.js';

const databaseUrl = process.env.NAKH_TEST_DATABASE_URL,
  redisUrl = process.env.NAKH_TEST_REDIS_URL;
const key = (byte: number): string => Buffer.alloc(32, byte).toString('base64url');
const entry = (
  keyId: string,
  byte: number,
  keyVersion = 1,
): { keyId: string; keyVersion: number; key: string } => ({ keyId, keyVersion, key: key(byte) });
const totp = entry('totp-host-v1', 13),
  note = entry('review-notes-v1', 14),
  snapshot = entry('report-snapshot-v1', 15);
const botId = 12345,
  botToken = `${botId}:${'a'.repeat(24)}`,
  webhookSecret = 'native-admin-webhook-secret-00000000000000';
type Menu = {
  message_id?: number;
  chat_id: string;
  text: string;
  reply_markup?: {
    inline_keyboard?: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
  };
};
type Host = {
  child: ChildProcess;
  origin: string;
  menus: Menu[];
  media: {
    objects: Map<string, Buffer>;
    photos: Array<{ chat_id: string; protect_content: string; photoBytes: string }>;
    reads: string[];
    purges: string[][];
    failPurge: boolean;
  };
  diagnostics: () => string;
  stop: () => Promise<void>;
};

/** Native HTTP keeps the integration client usable under the original jitless
 * gate, where Node fetch's WebAssembly HTTP parser is deliberately unavailable. */
async function localRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
    throw new Error('Native host origin invalid.');
  const body = init.body;
  if (body !== undefined && typeof body !== 'string')
    throw new Error('Native request body invalid.');
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(
      target,
      { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)) },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 131072) request.destroy(new Error('Native response exceeds limit.'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          const status = response.statusCode ?? 500;
          resolveResponse(
            new Response(
              [204, 205, 304].includes(status) ? null : Buffer.concat(chunks).toString('utf8'),
              { status, headers },
            ),
          );
        });
      },
    );
    request.setTimeout(15000, () => request.destroy(new Error('Native HTTP deadline exceeded.')));
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

async function port(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Native host port unavailable.');
  const selected = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error === undefined ? resolveClose() : reject(error))),
  );
  return selected;
}

describe.skipIf(databaseUrl === undefined || redisUrl === undefined)(
  'ordinary compiled administrator entry hosts',
  () => {
    let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>>, database: NakhDatabase;
    let directory: string, preload: string, api: Host, gateway: Host, apiPort: number;
    let operator: PostgresAdminTotpOperator;
    const hosts: Host[] = [];
    const prefix = `m9-admin-${randomUUID()}`;
    let updateId = 100000,
      messageId = 1;
    let telegramSequence = 6000000000000;
    function environment(service: string, selectedPort: number): NodeJS.ProcessEnv {
      return {
        ...process.env,
        NODE_OPTIONS: '',
        NAKH_ENV: 'test',
        NAKH_SERVICE_NAME: service,
        NAKH_RELEASE: 'native-admin-host',
        NAKH_HTTP_HOST: '127.0.0.1',
        NAKH_HTTP_PORT: String(selectedPort),
        NAKH_DATABASE_URL: isolated.url,
        NAKH_REDIS_URL: redisUrl!,
        NAKH_QUEUE_PREFIX: prefix,
        NAKH_TELEGRAM_BOT_TOKEN_REF: 'M9_HOST_BOT',
        M9_HOST_BOT: botToken,
        NAKH_TELEGRAM_WEBHOOK_SECRET: webhookSecret,
        NAKH_TELEGRAM_ACTION_TOKEN_KEY_REF: 'M9_HOST_NAV',
        M9_HOST_NAV: key(11),
        NAKH_ADMINISTRATION_ENABLED: 'true',
        NAKH_ADMIN_MEDIA_ENABLED: 'true',
        NAKH_ADMIN_EVIDENCE_R2_ACCESS_KEY_REF: 'M9_EVIDENCE_ACCESS',
        NAKH_ADMIN_EVIDENCE_R2_SECRET_KEY_REF: 'M9_EVIDENCE_SECRET',
        M9_EVIDENCE_ACCESS: 'native-evidence-read-access',
        M9_EVIDENCE_SECRET: 'native-evidence-read-secret-only',
        NAKH_ADMIN_PUBLIC_ORIGIN: `http://127.0.0.1:${apiPort}`,
        NAKH_ADMIN_TOTP_KEY_RING_REF: 'M9_HOST_TOTP',
        M9_HOST_TOTP: JSON.stringify([totp]),
        NAKH_ADMIN_ACTION_KEY_REF: 'M9_HOST_ADMIN',
        M9_HOST_ADMIN: key(12),
        NAKH_ADMIN_REVIEW_NOTE_KEY_RING_REF: 'M9_HOST_NOTES',
        M9_HOST_NOTES: JSON.stringify([note]),
        NAKH_ADMIN_REVIEW_NOTE_KEY_ID: note.keyId,
        NAKH_ADMIN_REVIEW_NOTE_KEY_VERSION: '1',
        NAKH_DELETION_EVIDENCE_KEY_RING_REF: 'M9_HOST_SNAPSHOTS',
        M9_HOST_SNAPSHOTS: JSON.stringify([snapshot, entry('photo-fixture', 81)]),
        NAKH_REPORT_SNAPSHOT_KEY_ID: snapshot.keyId,
        NAKH_REPORT_SNAPSHOT_KEY_VERSION: '1',
        NAKH_TELEGRAM_START_DELIVERY_ENABLED: 'true',
        NAKH_TELEGRAM_SIGNUP_ENABLED: 'true',
        NAKH_TELEGRAM_GUEST_PREVIEW_ENABLED: 'false',
        NAKH_TELEGRAM_EXPLORE_ENABLED: 'false',
        NAKH_TELEGRAM_STARS_ENABLED: 'false',
        NAKH_TELEGRAM_STARS_REFUNDS_ENABLED: 'false',
        NAKH_TELEGRAM_REPORTS_ENABLED: 'false',
        NAKH_TELEGRAM_LIKED_BY_DELIVERY_ENABLED: 'false',
        NAKH_TELEGRAM_NOTIFICATION_DELIVERY_ENABLED: 'false',
        NAKH_TELEGRAM_SUPPORT_APPEAL_ENABLED: 'false',
        NAKH_MEDIA_INGESTION_ENABLED: 'true',
        NAKH_MEDIA_CLEANUP_ENABLED: 'false',
        NAKH_MEDIA_CACHE_PURGE_ENABLED: 'true',
        NAKH_CLOUDFLARE_ZONE_ID: 'a'.repeat(32),
        NAKH_CLOUDFLARE_API_TOKEN_REF: 'M9_HOST_PURGE',
        M9_HOST_PURGE: 'synthetic-cloudflare-purge-token',
        NAKH_MEDIA_ORPHAN_RECONCILIATION_ENABLED: 'false',
        NAKH_MEDIA_TRANSPORT_KEY_REF: 'M9_HOST_TRANSPORT',
        M9_HOST_TRANSPORT: key(16),
        NAKH_R2_ENDPOINT: 'https://native-account.r2.cloudflarestorage.com',
        NAKH_R2_BUCKET: 'native-admin',
        NAKH_R2_ACCESS_KEY_REF: 'M9_UNUSED_R2_ACCESS',
        NAKH_R2_SECRET_KEY_REF: 'M9_UNUSED_R2_SECRET',
        NAKH_MEDIA_CDN_HOST: 'media.invalid',
        NAKH_MEDIA_SIGNING_KEY_REF: 'M9_HOST_SIGNING',
        M9_HOST_SIGNING: key(17),
        NAKH_DELETION_WORKER_ENABLED: 'false',
        NAKH_DELETION_API_ENABLED: 'false',
        NAKH_DELETION_TELEGRAM_ENABLED: 'false',
        NAKH_RETURN_API_ENABLED: 'false',
        NAKH_RETURN_TELEGRAM_ENABLED: 'false',
        NAKH_FRESH_ENTRY_TELEGRAM_ENABLED: 'false',
        NAKH_OTEL_ENABLED: 'false',
      };
    }
    async function start(
      service: 'api' | 'telegram-gateway',
      overrides: NodeJS.ProcessEnv = {},
      ready = true,
    ): Promise<Host> {
      const selectedPort = service === 'api' && hosts.length === 0 ? apiPort : await port();
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv.filter((arg) => arg === '--no-opt' || arg === '--jitless'),
          '--import',
          pathToFileURL(preload).href,
          resolve(`apps/${service}/dist/main.js`),
        ],
        {
          env: { ...environment(service, selectedPort), ...overrides },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      const ended = once(child, 'exit');
      const menus: Menu[] = [];
      const media: Host['media'] = {
        objects: new Map(),
        photos: [],
        reads: [],
        purges: [],
        failPurge: false,
      };
      let diagnostics = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-64000);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-64000);
      });
      child.on('message', (raw: unknown) => {
        const request = raw as {
          type?: string;
          id?: number;
          method?: string;
          path?: string;
          authorization?: string;
          body?: Menu & { files?: string[]; protect_content?: string; photoBytes?: string };
        };
        if (request.type === 'r2-read') {
          const path = decodeURIComponent(
            new URL(request.path!, 'https://native.invalid').pathname,
          ).replace(/^\/(?:native-admin\/)?/u, '');
          media.reads.push(path);
          const bytes =
            request.method === 'GET' &&
            request.authorization?.startsWith(
              'AWS4-HMAC-SHA256 Credential=native-evidence-read-access/',
            )
              ? media.objects.get(path)
              : undefined;
          child.send({
            type: 'r2-result',
            id: request.id,
            bytes: bytes?.toString('base64'),
            status: bytes === undefined ? 403 : 200,
          });
          return;
        }
        if (request.type !== 'provider') return;
        const body = request.body!;
        if (request.method === 'purge_cache') {
          media.purges.push(body.files!);
          child.send({
            type: 'provider-result',
            id: request.id,
            result: { success: !media.failPurge },
          });
          return;
        }
        const deliveredMessageId = ++messageId;
        if (request.method === 'sendMessage')
          menus.push({ ...body, message_id: deliveredMessageId });
        if (request.method === 'sendPhoto')
          media.photos.push({
            chat_id: body.chat_id,
            protect_content: body.protect_content!,
            photoBytes: body.photoBytes!,
          });
        child.send({
          type: 'provider-result',
          id: request.id,
          result:
            request.method === 'answerCallbackQuery'
              ? true
              : {
                  message_id: deliveredMessageId,
                  from: { id: botId, is_bot: true },
                  chat: { id: Number(body.chat_id), type: 'private' },
                  text: body.text,
                },
        });
      });
      const host: Host = {
        child,
        origin: `http://127.0.0.1:${selectedPort}`,
        menus,
        media,
        diagnostics: () => diagnostics,
        stop: async () => {
          if (child.exitCode !== null || child.signalCode !== null) return;
          if (child.connected) child.send({ stop: true });
          else child.kill('SIGTERM');
          const result = await Promise.race([
            ended.then(() => true),
            pause(10000, undefined, { ref: false }).then(() => false),
          ]);
          if (!result) {
            child.kill('SIGKILL');
            await ended;
            throw new Error('Native administrator host did not drain.');
          }
        },
      };
      hosts.push(host);
      if (ready)
        await vi.waitFor(
          async () => {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error('Native host exited: ' + diagnostics);
            expect((await localRequest(host.origin + '/health/ready')).status).toBe(200);
          },
          { timeout: 25000, interval: 100 },
        );
      return host;
    }
    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase(databaseUrl!, 'm9_admin_hosts');
      await runMigrations(isolated.url, resolve('migrations'));
      await verifyMigrations(isolated.url, resolve('migrations/verify'));
      database = createDatabase({
        url: isolated.url,
        poolMax: 24,
        statementTimeoutMs: 20000,
        lockTimeoutMs: 15000,
      });
      directory = await mkdtemp(join(tmpdir(), 'nakh-admin-host-'));
      preload = join(directory, 'provider.mjs');
      await writeFile(
        preload,
        `
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable, Writable } from 'node:stream';
const pending = new Map(); let id = 0, stopping = false;
// Synthetic transport only: exercise the real S3 SDK signer and GET pipeline.
https.request = (options, callback) => {
  if (!options.host.endsWith('.r2.cloudflarestorage.com')) throw Error('Unexpected object origin');
  const request = new Writable({ autoDestroy: false, write(_chunk,_encoding,done) {done();}, final(done) {
    const requestId = ++id;
    const answer = new Promise(resolve => pending.set(requestId, resolve));
    process.send({type:'r2-read',id:requestId,method:options.method,path:options.path,authorization:options.headers.authorization});
    done();
    void answer.then(result => {
      const bytes = result.status === 200 ? Buffer.from(result.bytes,'base64') : Buffer.from('<Error><Code>AccessDenied</Code></Error>');
      const response = Readable.from([bytes]); response.statusCode = result.status;
      response.statusMessage = result.status === 200 ? 'OK' : 'Forbidden';
      response.headers = {'content-length':String(bytes.length),'content-type':result.status === 200 ? 'image/webp' : 'application/xml'};
      response.on('end',()=>request.destroy()); callback(response);
    });
  }});
  return request;
};
syncBuiltinESMExports();
globalThis.fetch = async (url, options) => {
  const parsed = new URL(String(url));
  const purge = parsed.origin === 'https://api.cloudflare.com' && parsed.pathname === '/client/v4/zones/' + 'a'.repeat(32) + '/purge_cache';
  if (!purge && parsed.origin !== 'https://api.telegram.org') throw Error('Unexpected native provider origin');
  const requestId = ++id;
  const answer = new Promise(resolve => pending.set(requestId, resolve));
  const body = options.body instanceof FormData ? { chat_id:options.body.get('chat_id'), protect_content:options.body.get('protect_content'),
    photoBytes:Buffer.from(await options.body.get('photo').arrayBuffer()).toString('base64') } : JSON.parse(options.body);
  process.send({type:'provider',id:requestId,method:parsed.pathname.split('/').at(-1),body});
  const result = await answer; return Response.json(purge ? result : {ok:true,result});
};
const stop = () => { if(stopping && process.listenerCount('SIGTERM') > 0) { stopping = false; process.emit('SIGTERM','SIGTERM'); process.disconnect(); } };
process.on('newListener', name => { if(name === 'SIGTERM') queueMicrotask(stop); });
process.on('message', message => {
  if(message?.stop) { stopping = true; stop(); }
  else if(message?.type === 'provider-result') { pending.get(message.id)?.(message.result); pending.delete(message.id); }
  else if(message?.type === 'r2-result') { pending.get(message.id)?.(message); pending.delete(message.id); }
});
`,
      );
      apiPort = await port();
      api = await start('api');
      gateway = await start('telegram-gateway');
      operator = new PostgresAdminTotpOperator(
        database,
        { operatorId: randomUUID() },
        {
          keyId: totp.keyId,
          keyVersion: 1,
          key: Buffer.from(totp.key, 'base64url'),
        },
        new ReportSnapshotKeyRing(JSON.stringify([totp])),
      );
    });
    afterAll(async () => {
      for (const host of hosts.reverse()) await host.stop();
      operator?.dispose();
      await database?.destroy();
      await isolated?.destroy();
      if (preload !== undefined) await unlink(preload);
      if (directory !== undefined) await rmdir(directory);
    });
    async function identity(userId: string): Promise<string> {
      return (
        await database
          .selectFrom('identity.telegram_identities')
          .select('telegram_user_id')
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow()
      ).telegram_user_id;
    }
    async function register(
      telegramUserId = String(++telegramSequence),
      eventId = ++updateId,
    ): Promise<Readonly<{ userId: string; telegramUserId: string; eventId: number }>> {
      expect((await webhook(telegramUserId, '/start', eventId)).status).toBe(201);
      const registered = await database
        .selectFrom('identity.telegram_identities')
        .select('user_id')
        .where('telegram_user_id', '=', telegramUserId)
        .executeTakeFirstOrThrow();
      return { userId: registered.user_id, telegramUserId, eventId };
    }
    async function webhook(
      telegramUserId: string,
      text = '/start',
      eventId = ++updateId,
      secret = webhookSecret,
      replyTo?: number,
    ): Promise<Response> {
      return localRequest(gateway.origin + '/v1/providers/telegram/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify({
          update_id: eventId,
          message: {
            message_id: eventId,
            date: Math.floor(Date.now() / 1000),
            text,
            from: { id: Number(telegramUserId), is_bot: false },
            chat: { id: Number(telegramUserId), type: 'private' },
            ...(replyTo === undefined
              ? {}
              : {
                  reply_to_message: {
                    message_id: replyTo,
                    from: { id: botId, is_bot: true },
                    chat: { id: Number(telegramUserId), type: 'private' },
                  },
                }),
          },
        }),
      });
    }
    function handoff(telegramUserId: string): string {
      const menu = gateway.menus.filter((item) => String(item.chat_id) === telegramUserId).at(-1)!;
      const url = menu.reply_markup?.inline_keyboard
        ?.flat()
        .find((button) => button.url !== undefined)?.url;
      if (url === undefined) throw new Error('Native administrator handoff missing.');
      const selected = new URL(url);
      expect(selected.origin).toBe(api.origin);
      expect(selected.searchParams.has('session')).toBe(false);
      return new URLSearchParams(selected.hash.slice(1)).get('session')!;
    }
    async function post(
      path: string,
      bearer: string,
      body: object,
      origin = api.origin,
    ): Promise<Response> {
      return localRequest(origin + '/v1/admin/' + path, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    async function context(bearer: string, origin = api.origin): Promise<Response> {
      return localRequest(origin + '/v1/admin/auth/context', {
        headers: { authorization: 'Bearer ' + bearer },
      });
    }
    async function approve(userId: string): Promise<string> {
      const result = await operator.approve({
        actorUserId: userId,
        requestId: randomUUID(),
        roles: ['super_admin'],
        reasonCode: 'bootstrap',
      });
      if (result.status !== 'pending') throw new Error('Native operator approval missing.');
      return result.invitationToken;
    }
    async function clock(): Promise<Date> {
      return (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(database)).rows[0]!
        .at;
    }
    async function attemptWindows(): Promise<readonly Record<string, unknown>[]> {
      return (
        await sql<Record<string, unknown>>`SELECT admin_user_id,started_at,attempts
        FROM administration.admin_totp_attempt_windows ORDER BY admin_user_id`.execute(database)
      ).rows;
    }
    async function credentialSteps(): Promise<readonly { id: string; last_used_step: string }[]> {
      return (
        await sql<{ id: string; last_used_step: string }>`SELECT id,last_used_step
        FROM administration.admin_totp_credentials ORDER BY id`.execute(database)
      ).rows;
    }
    async function reviewProtectedReport(adminUserId: string, bearer: string): Promise<string> {
      // Native fixture data; capture and every privileged command use the real API.
      const reporter = await createReportUser(database, true),
        target = await createReportUser(database, true);
      const like = await createReportLike(database, reporter, target);
      const life = { userId: reporter, productEpoch: 0 };
      const user = await createPostgresUserSessions(
        database,
        Buffer.from(key(11), 'base64url'),
      ).issue(life, randomUUID());
      const redis = createRedisConnection(redisUrl!);
      try {
        const sources = new ReportTokenFactory(
          new RedisUserOpaqueTokenStores(redis, prefix),
          Buffer.from(key(11), 'base64url'),
        );
        const reference = await sources
          .forLife(life)
          .issueSource(reporter, { kind: 'received_like', referenceId: like });
        const actor = { kind: 'user' as const, userId: reporter };
        const prepared = await localRequest(api.origin + '/v1/reports/prepare', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + user.userSessionToken,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            actor,
            requestId: randomUUID(),
            sourceActionToken: reference.token,
            requestedEvidenceTypes: ['profile'],
          }),
        });
        expect(prepared.status).toBe(200);
        const { evidenceIntentToken } = (await prepared.json()) as { evidenceIntentToken: string };
        const id = randomUUID();
        const submitted = await localRequest(api.origin + '/v1/reports', {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + user.userSessionToken,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            actor,
            commandId: id,
            requestId: id,
            idempotencyKey: id,
            schemaVersion: 1,
            commandType: 'moderation.submit-report',
            occurredAt: new Date().toISOString(),
            locale: 'en',
            data: { evidenceIntentToken, reasonCode: 'harassment' },
          }),
        });
        expect(submitted.status).toBe(201);
      } finally {
        await redis.quit();
      }
      const report = await database
        .selectFrom('moderation.reports')
        .select('id')
        .where('reporter_user_id', '=', reporter)
        .executeTakeFirstOrThrow();
      const review = await database
        .selectFrom('moderation.moderation_reviews')
        .select(['id', 'version'])
        .where('report_id', '=', report.id)
        .executeTakeFirstOrThrow();
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', adminUserId)
        .executeTakeFirstOrThrow();
      const actor = { kind: 'admin' as const, userId: adminUserId };
      const queue = await post('reports/queue/actions', bearer, { actor, requestId: randomUUID() });
      expect(queue.status).toBe(200);
      const { metadataActionToken } = (await queue.json()) as { metadataActionToken: string };
      async function action(version: number, selected: 'assign' | 'dismissed'): Promise<string> {
        const response = await post('moderation/reviews/actions', bearer, {
          actor,
          requestId: randomUUID(),
          adminActionToken: metadataActionToken,
          reviewId: review.id,
          expectedReviewVersion: version,
          action: selected,
        });
        expect(response.status).toBe(200);
        return ((await response.json()) as { adminActionToken: string }).adminActionToken;
      }
      async function execute(
        path: string,
        commandType: string,
        data: Readonly<Record<string, unknown>>,
      ): Promise<void> {
        const id = randomUUID();
        const draft = {
          actor,
          commandType,
          schemaVersion: 1,
          commandId: id,
          requestId: id,
          idempotencyKey: id,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data,
        };
        const prepared = await post(path + '/prepare', bearer, draft);
        expect(prepared.status).toBe(200);
        const { confirmationToken } = (await prepared.json()) as { confirmationToken: string };
        const results = await Promise.all(
          Array.from({ length: 2 }, () =>
            post(path, bearer, { ...draft, data: { ...data, confirmationToken } }),
          ),
        );
        for (const result of results) {
          expect(result.status).toBe(200);
          expect(await result.json()).toMatchObject({ result: 'succeeded' });
        }
      }
      await execute('moderation/reviews/assignment', 'moderation.assign-review', {
        expectedTargetVersion: review.version,
        reason: 'Synthetic custody review',
        assigneeAdminId: admin.id,
        adminActionToken: await action(review.version, 'assign'),
      });
      const privateNote = 'Synthetic private custody note';
      await execute('moderation/reviews/decision/dismissed', 'moderation.decide-review', {
        expectedTargetVersion: review.version + 1,
        reason: 'Synthetic custody review',
        decision: 'dismissed',
        note: privateNote,
        adminActionToken: await action(review.version + 1, 'dismissed'),
      });
      const decided = await database
        .selectFrom('moderation.moderation_reviews')
        .selectAll()
        .where('id', '=', review.id)
        .executeTakeFirstOrThrow();
      expect(decided).toMatchObject({
        status: 'dismissed',
        version: review.version + 2,
        decision_note_key_id: note.keyId,
      });
      expect(decided.decision_note_ciphertext).not.toBeNull();
      expect(Buffer.from(decided.decision_note_ciphertext!).toString('utf8')).not.toContain(
        privateNote,
      );
      return privateNote;
    }
    async function verifyMediaControls(
      userId: string,
      recipient: string,
      bearer: string,
    ): Promise<void> {
      const bytes = Buffer.alloc(32);
      bytes.write('RIFF');
      bytes.writeUInt32LE(24, 4);
      bytes.write('WEBP', 8);
      const held = await createRetainedPhotoReview(database, bytes);
      const admin = await database
        .selectFrom('administration.admin_users')
        .select('id')
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      // Governing assigned-review fixture; actual effects below use confirmed commands.
      await database
        .updateTable('moderation.moderation_reviews')
        .set({
          status: 'in_review',
          assigned_admin_id: admin.id,
          assigned_at: new Date(),
          updated_at: new Date(),
          version: 2,
        })
        .where('id', '=', held.reviewId)
        .execute();
      const variant = await database
        .selectFrom('media.profile_photos as photo')
        .innerJoin('media.photo_variants as variant', 'variant.asset_id', 'photo.asset_id')
        .select(['variant.storage_key', 'variant.delivery_path'])
        .where('photo.id', '=', held.photoId)
        .where('variant.variant_type', '=', 'thumbnail')
        .executeTakeFirstOrThrow();
      gateway.media.objects.set(variant.storage_key, bytes);
      const actor = { kind: 'admin' as const, userId };
      const queue = await post('reports/queue/actions', bearer, { actor, requestId: randomUUID() });
      expect(queue.status).toBe(200);
      const { metadataActionToken } = (await queue.json()) as { metadataActionToken: string };
      async function change(
        action: 'hide_photo' | 'delete_photo',
        version: number,
        expected: 'failed' | 'succeeded',
      ): Promise<void> {
        const selected = await post('moderation/reports/photo-selection', bearer, {
          actor,
          requestId: randomUUID(),
          adminActionToken: metadataActionToken,
          reportId: held.reportId,
          expectedReportVersion: 2,
          evidenceId: held.evidenceId,
          action,
        });
        expect(selected.status).toBe(200);
        const selection = (await selected.json()) as {
          adminActionToken: string;
          photoVersion: number;
        };
        expect(selection.photoVersion).toBe(version);
        const id = randomUUID();
        const draft = {
          actor,
          requestId: id,
          commandId: id,
          idempotencyKey: id,
          commandType: 'moderation.apply-photo-action',
          schemaVersion: 1,
          occurredAt: new Date().toISOString(),
          locale: 'en',
          data: {
            action,
            expectedTargetVersion: version,
            reason: 'Controlled photo review',
            adminActionToken: selection.adminActionToken,
          },
        };
        const path = 'moderation/photos/' + action;
        const prepared = await post(path + '/prepare', bearer, draft);
        expect(prepared.status).toBe(200);
        const { confirmationToken } = (await prepared.json()) as { confirmationToken: string };
        const command = { ...draft, data: { ...draft.data, confirmationToken } };
        for (const result of await Promise.all(
          Array.from({ length: 3 }, () => post(path, bearer, command)),
        )) {
          expect(result.status).toBe(200);
          expect(await result.json()).toMatchObject({ result: expected });
        }
        expect(
          await database
            .selectFrom('administration.admin_action_logs')
            .select('id')
            .where('command_id', '=', id)
            .execute(),
        ).toHaveLength(1);
      }
      api.media.failPurge = true;
      await change('hide_photo', 1, 'failed');
      expect(
        await database
          .selectFrom('media.profile_photos')
          .select(['status', 'version'])
          .where('id', '=', held.photoId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'visible', version: 1 });
      api.media.failPurge = false;
      await change('hide_photo', 1, 'succeeded');
      await change('delete_photo', 2, 'succeeded');
      expect(
        await database
          .selectFrom('media.profile_photos')
          .select(['status', 'version'])
          .where('id', '=', held.photoId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: 'deleted', version: 3 });
      expect(api.media.purges.flat()).toContain('https://media.invalid' + variant.delivery_path);
      expect(
        await database
          .selectFrom('media.report_photo_evidence_holds')
          .select('report_evidence_id')
          .where('report_evidence_id', '=', held.evidenceId)
          .execute(),
      ).toHaveLength(1);

      // Select only opaque choices actually delivered by the running gateway.
      const redis = createRedisConnection(redisUrl!);
      try {
        const derive = (domain: string): Buffer =>
          createHmac('sha256', Buffer.from(key(12), 'base64url'))
            .update(domain)
            .digest();
        const state = new TelegramAdminReportQueueState(
          new RedisOpaqueTokenStore(redis, prefix + ':admin'),
          derive('nakh-admin-ui-encryption-v1'),
          derive('nakh-admin-ui-reference-v1'),
        );
        async function callback(data: string, eventId = ++updateId): Promise<void> {
          const result = await localRequest(gateway.origin + '/v1/providers/telegram/webhook', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-telegram-bot-api-secret-token': webhookSecret,
            },
            body: JSON.stringify({
              update_id: eventId,
              callback_query: {
                id: String(eventId),
                data,
                from: { id: Number(recipient), is_bot: false },
                message: { message_id: eventId, chat: { id: Number(recipient), type: 'private' } },
              },
            }),
          });
          expect(
            result.status,
            JSON.stringify({
              syntheticObjectReads: gateway.media.reads,
              syntheticUploads: gateway.media.photos.length,
            }),
          ).toBe(201);
        }
        const buttons = (): string[] =>
          gateway.menus
            .at(-1)!
            .reply_markup!.inline_keyboard!.flat()
            .map((b) => b.callback_data!);
        expect((await webhook(recipient, '/admin_reports pending_review')).status).toBe(201);
        let selected: string | undefined;
        for (let page = 0; page < 20 && selected === undefined; page++) {
          for (const button of buttons().filter((b) => b.startsWith('m7T:'))) {
            if ((await state.choice(actor, button.slice(4)))?.targetId === held.reportId) {
              selected = button;
              break;
            }
          }
          if (selected === undefined) {
            const next = buttons().find((b) => b.startsWith('m7O:'));
            expect(next).toBeDefined();
            await callback(next!);
          }
        }
        expect(selected).toBeDefined();
        await callback(selected!);
        await callback(selected!.replace('m7T:', 'm7C:'));
        const evidence = buttons().find((b) => b.startsWith('m7J:'))!;
        expect(evidence).toBeDefined();
        await callback(evidence);
        await callback(evidence.replace('m7J:', 'm7W:'));
        const prompt = gateway.menus.at(-1)!.message_id!;
        expect(
          (
            await webhook(
              recipient,
              'Controlled held evidence review',
              ++updateId,
              webhookSecret,
              prompt,
            )
          ).status,
        ).toBe(201);
        const confirmation = buttons().find((b) => b.startsWith('m7K:'));
        expect(confirmation).toBeDefined();
        const replay = ++updateId;
        const deliveries = await Promise.allSettled(
          Array.from({ length: 8 }, () => callback(confirmation!, replay)),
        );
        for (const delivery of deliveries)
          expect(
            delivery.status,
            delivery.status === 'rejected' && delivery.reason instanceof Error
              ? delivery.reason.message
              : undefined,
          ).toBe('fulfilled');
        expect(gateway.media.photos).toEqual([
          { chat_id: recipient, protect_content: 'true', photoBytes: bytes.toString('base64') },
        ]);
        expect(gateway.media.reads).toEqual([variant.storage_key]);
        expect(
          await database
            .selectFrom('moderation.evidence_access_audits')
            .select('outcome')
            .where('report_evidence_id', '=', held.evidenceId)
            .execute(),
        ).toEqual([{ outcome: 'revealed' }]);
        for (const menu of gateway.menus)
          expect(JSON.stringify(menu)).not.toContain(variant.storage_key);
      } finally {
        await redis.quit();
      }
    }
    function seed(uri: string): Buffer {
      const text = new URL(uri).searchParams.get('secret')!;
      const bits = [...text]
        .map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0'))
        .join('');
      return Buffer.from(bits.match(/.{8}/gu)!.map((b) => parseInt(b, 2)));
    }

    it('uses actual private webhook entry, one original grant across retries, native TOTP and the running administrator queue', async () => {
      const telegramUserId = String(++telegramSequence),
        event = ++updateId;
      expect((await webhook(telegramUserId, '/start', event, 'invalid')).status).toBe(401);
      const { userId } = await register(telegramUserId, event);
      const invitationToken = await approve(userId);
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => webhook(telegramUserId, '/start', event)),
      );
      // One original start plus twenty retries crosses the existing 20/minute
      // transport limit. Admission stays bounded; accepted retries share one grant.
      expect(responses.filter((response) => response.status === 201)).toHaveLength(19);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
      expect(await responses.find((response) => response.status === 429)!.json()).toMatchObject({
        code: 'rate_limited',
      });
      const facts = await database
        .selectFrom('platform.audit_logs')
        .selectAll()
        .where('actor_user_id', '=', userId)
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .execute();
      expect(facts).toHaveLength(1);
      const token = handoff(telegramUserId),
        actor = { kind: 'user' as const, userId };
      const page = await localRequest(api.origin + '/v1/admin/auth/page?locale=en');
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await page.text();
      expect(html).toContain('Sign in as an administrator');
      expect(html).not.toContain(token);
      const script = await localRequest(api.origin + '/v1/admin/auth/page.js');
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('javascript');
      const javascript = await script.text();
      expect(javascript).toContain('history.replaceState');
      expect(javascript).not.toContain(token);
      expect((await context(token)).status).toBe(200);
      expect(
        (
          await post('moderation/operational-health/prepare', token, {
            actor: { kind: 'admin', userId },
            requestId: randomUUID(),
          })
        ).status,
      ).toBe(401);
      const opened = await post('auth/enrollment', token, {
        actor,
        requestId: randomUUID(),
        invitationToken,
      });
      expect(opened.status).toBe(200);
      const { enrollmentUri } = (await opened.json()) as { enrollmentUri: string };
      const secret = seed(enrollmentUri),
        at = await clock();
      try {
        const confirmation = await post('auth/enrollment/confirm', token, {
          actor,
          requestId: randomUUID(),
          invitationToken,
          code: adminTotpCode(secret, at),
        });
        expect(confirmation.status).toBe(200);
        const signIn = await post('auth/sessions', token, {
          actor,
          requestId: randomUUID(),
          code: adminTotpCode(secret, new Date((adminTotpStep(at) + 1) * 30000)),
        });
        expect(signIn.status).toBe(200);
        const { adminSessionToken } = (await signIn.json()) as { adminSessionToken: string };
        const before = gateway.menus.length;
        expect((await webhook(telegramUserId, '/admin_reports')).status).toBe(201);
        expect(gateway.menus.length).toBeGreaterThan(before);
        expect(gateway.menus.at(-1)!.text).toContain('Report');
        const privateNote = await reviewProtectedReport(userId, adminSessionToken);
        await verifyMediaControls(userId, telegramUserId, adminSessionToken);
        const persisted = JSON.stringify(
          await database.selectFrom('platform.audit_logs').select('metadata').execute(),
        );
        for (const sensitive of [
          token,
          adminSessionToken,
          invitationToken,
          enrollmentUri,
          privateNote,
        ])
          expect(persisted).not.toContain(sensitive);
        const logout = await post('auth/sessions/logout', adminSessionToken, {
          actor: { kind: 'admin', userId },
          requestId: randomUUID(),
        });
        expect(logout.status).toBe(200);
      } finally {
        secret.fill(0);
      }
    });
    it('rejects non-staff, changed actors, privileged audience substitution and revoked original grants', async () => {
      const { userId, telegramUserId } = await register();
      expect(
        gateway.menus
          .filter((menu) => String(menu.chat_id) === telegramUserId)
          .flatMap((menu) => menu.reply_markup?.inline_keyboard?.flat() ?? [])
          .some((button) => button.url !== undefined),
      ).toBe(false);
      const grant = await database
        .selectFrom('platform.audit_logs')
        .select('id')
        .where('actor_user_id', '=', userId)
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .executeTakeFirstOrThrow();
      const users = createPostgresUserSessions(database, Buffer.from(key(11), 'base64url'));
      const nonStaff = await users.exportCurrent({
        kind: 'user',
        userId,
        productEpoch: 0,
        sessionGrantId: grant.id,
      });
      expect((await context(nonStaff.userSessionToken)).status).toBe(401);
      await approve(userId);
      expect((await context(nonStaff.userSessionToken)).status).toBe(200);
      expect(
        (
          await post('auth/sessions', nonStaff.userSessionToken, {
            actor: { kind: 'user', userId: randomUUID() },
            requestId: randomUUID(),
            code: '000000',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await post('auth/sessions', nonStaff.userSessionToken, {
            actor: { kind: 'user', userId },
            requestId: randomUUID(),
            code: '000000',
            roles: ['super_admin'],
          })
        ).status,
      ).toBe(400);
      await users.revoke({ userId, productEpoch: 0 }, nonStaff.userSessionToken, randomUUID());
      expect((await context(nonStaff.userSessionToken)).status).toBe(401);
      expect((await post('operator/bootstrap', nonStaff.userSessionToken, {})).status).toBe(404);
    });
    it('cannot turn a pre-Root handoff into a new-life grant after genuine native deletion and approved Return', async () => {
      let oldToken!: string, telegramUserId!: string;
      const fixture = await createAccountReturnFixture(database, {
        beforeDeletion: async (userId) => {
          telegramUserId = await identity(userId);
          await approve(userId);
          expect((await webhook(telegramUserId)).status).toBe(201);
          oldToken = handoff(telegramUserId);
          expect((await context(oldToken)).status).toBe(200);
        },
      });
      const commandId = randomUUID();
      await new PostgresAccountReturnStore(database, fixture.control).return({
        commandId,
        requestId: commandId,
        commandType: 'account.return',
        schemaVersion: 1,
        actor: { kind: 'user', userId: fixture.userId },
        idempotencyKey: commandId,
        occurredAt: new Date().toISOString(),
        locale: 'en',
        data: { expectedAccountVersion: fixture.version },
      });
      expect((await context(oldToken)).status).toBe(401);
      const before = gateway.menus.length;
      await webhook(telegramUserId);
      expect(
        gateway.menus
          .slice(before)
          .flatMap((menu) => menu.reply_markup?.inline_keyboard?.flat() ?? [])
          .some((button) => button.url !== undefined),
      ).toBe(false);
      const issued = await database
        .selectFrom('platform.audit_logs')
        .select('metadata')
        .where('actor_user_id', '=', fixture.userId)
        .where('event_type', '=', 'identity.user-session-issued.v1')
        .execute();
      expect(
        issued.some((row) => (row.metadata as { productEpoch?: number }).productEpoch === 1),
      ).toBe(false);
    });
    it('preserves historical factor custody across process recreation without consuming verification counters and refuses missing keys', async () => {
      const windows = await attemptWindows();
      const steps = await credentialSteps();
      expect(windows.length).toBeGreaterThan(0);
      expect(steps.length).toBeGreaterThan(0);
      const rotated = await start('api', {
        M9_HOST_TOTP: JSON.stringify([entry('totp-host-v2', 18, 2), totp]),
      });
      expect((await localRequest(rotated.origin + '/v1/admin/auth/page')).status).toBe(200);
      expect(await attemptWindows()).toEqual(windows);
      expect(await credentialSteps()).toEqual(steps);
      await rotated.stop();
      const missing = await start(
        'api',
        { M9_HOST_TOTP: JSON.stringify([entry('totp-host-v2', 18, 2)]) },
        false,
      );
      await vi.waitFor(() => expect(missing.child.exitCode).not.toBeNull(), { timeout: 20000 });
      expect(missing.child.exitCode).not.toBe(0);
      expect(missing.diagnostics()).toContain('Administrator key custody unavailable.');
      for (const override of [
        { M9_HOST_NOTES: JSON.stringify([entry(note.keyId, 19)]) },
        {
          M9_HOST_SNAPSHOTS: JSON.stringify([
            entry(snapshot.keyId, 20),
            entry('photo-fixture', 81),
          ]),
        },
      ]) {
        const invalid = await start('api', override, false);
        await vi.waitFor(() => expect(invalid.child.exitCode).not.toBeNull(), {
          timeout: 20000,
        });
        expect(invalid.child.exitCode).not.toBe(0);
        expect(invalid.diagnostics()).toContain('Administrator key custody unavailable.');
        expect(invalid.diagnostics()).not.toContain('Synthetic private custody note');
      }
    });
    it('keeps administrator media closed without resolving provider credentials while native sign-in stays available', async () => {
      const overrides = {
        NAKH_ADMIN_MEDIA_ENABLED: 'false',
        M9_HOST_PURGE: undefined,
        M9_EVIDENCE_ACCESS: undefined,
        M9_EVIDENCE_SECRET: undefined,
      };
      const metadataOnly = await start('api', overrides);
      const metadataGateway = await start('telegram-gateway', overrides);
      expect((await localRequest(metadataOnly.origin + '/v1/admin/auth/page')).status).toBe(200);
      expect((await localRequest(metadataGateway.origin + '/health/ready')).status).toBe(200);
      for (const action of ['hide_photo', 'restore_photo', 'delete_photo']) {
        const result = await localRequest(
          metadataOnly.origin + '/v1/admin/moderation/photos/' + action + '/prepare',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        );
        expect(result.status).toBe(404);
      }
      expect(metadataGateway.media.reads).toEqual([]);
      expect(metadataGateway.media.photos).toEqual([]);
      await metadataGateway.stop();
      await metadataOnly.stop();
    });
    it('leaves all administrator routes absent when disabled, without resolving administrator secrets', async () => {
      const disabled = await start('api', {
        NAKH_ADMINISTRATION_ENABLED: 'false',
        NAKH_ADMIN_MEDIA_ENABLED: 'false',
        M9_HOST_TOTP: undefined,
        M9_HOST_NOTES: undefined,
        M9_HOST_ADMIN: undefined,
      });
      for (const path of [
        '/v1/admin/auth/page',
        '/v1/admin/auth/context',
        '/v1/admin/auth/page.js',
      ])
        expect((await localRequest(disabled.origin + path)).status).toBe(404);
      for (const path of [
        '/v1/admin/auth/enrollment',
        '/v1/admin/auth/sessions',
        '/v1/admin/operator/bootstrap',
        '/v1/admin/operator/recovery',
      ])
        expect(
          (
            await localRequest(disabled.origin + path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            })
          ).status,
        ).toBe(404);
      await disabled.stop();
    });
  },
);
