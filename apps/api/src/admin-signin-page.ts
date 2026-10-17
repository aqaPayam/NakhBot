import { Controller, Get, Inject, Module, Req, Res, type DynamicModule } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApplicationError } from '@nakh/domain';
import type { UserSessionActor } from '@nakh/application';
import type { AdminRuntimeCatalogs } from '@nakh/persistence-postgres';
import { M7ApiBoundary, type M7ApiAuthenticator } from './m7-api-boundary.js';

const OPTIONS = Symbol('ADMIN_SIGNIN_PAGE_OPTIONS');
type Options = Readonly<{
  authenticator: M7ApiAuthenticator;
  eligible: (actor: UserSessionActor) => Promise<boolean>;
  catalogs: () => AdminRuntimeCatalogs;
}>;
function headers(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('Pragma', 'no-cache');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
  reply.header(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}
function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
export function administratorSignInHtml(
  catalogs: AdminRuntimeCatalogs,
  requested: unknown,
): string {
  const locale =
    typeof requested === 'string' && Object.hasOwn(catalogs.messages, requested)
      ? requested
      : catalogs.defaultLocale;
  const messages = catalogs.messages[locale]!;
  const text = (name: string): string => escape(messages[`admin.auth.${name}`]!);
  return `<!doctype html><html lang="${escape(locale)}" dir="auto"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text('title')}</title></head><body>
<main><h1>${text('title')}</h1><p>${text('instructions')}</p>
<form id="signin" autocomplete="off"><fieldset id="signin-fields" disabled><legend>${text('signin')}</legend>
<label for="signin-code">${text('code')}</label><input id="signin-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">${text('signin')}</button></fieldset></form>
<details><summary>${text('begin')}</summary><form id="enroll" autocomplete="off"><fieldset id="enroll-fields" disabled><legend>${text('begin')}</legend>
<label for="invitation">${text('invitation')}</label><input id="invitation" type="password" autocomplete="off" maxlength="2048" required>
<button id="begin" type="button">${text('begin')}</button>
<p id="setup" hidden>${text('seed')}: <output id="setup-key"></output></p>
<label for="enroll-code">${text('code')}</label><input id="enroll-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
<button type="submit">${text('confirm')}</button></fieldset></form></details>
<button id="logout" type="button" hidden>${text('signout')}</button><p id="status" role="status" aria-live="polite"></p>
${['activated', 'signed_in', 'signed_out', 'unavailable', 'expired'].map((name) => `<span id="notice-${name}" hidden>${text(name)}</span>`).join('')}
</main><script type="module" src="/v1/admin/auth/page.js"></script></body></html>`;
}

/** No inline code, cookie authentication, URL query credential, persistent browser
 * storage, third-party asset, auto-retry or secret in the rendered server HTML. */
export const ADMINISTRATOR_SIGNIN_SCRIPT = String.raw`(() => {
'use strict';
const byId = id => document.getElementById(id);
let bearer = new URLSearchParams(location.hash.slice(1)).get('session') || '';
history.replaceState(null, '', location.pathname + location.search);
let actor, adminBearer = '', busy = false;
const fields = [byId('signin-fields'), byId('enroll-fields')];
const disable = value => { for (const field of fields) field.disabled = value; };
const notice = key => { byId('status').textContent = byId('notice-' + key).textContent; };
async function request(path, body, credential = bearer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/v1/admin/auth/' + path, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: controller.signal,
      headers: { authorization: 'Bearer ' + credential, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = response.ok ? await response.json() : undefined;
    if (!response.ok) await response.body?.cancel();
    return { ok: response.ok, status: response.status, result };
  } finally { clearTimeout(timer); }
}
async function perform(operation) {
  if (busy || !actor || !bearer) return;
  busy = true; disable(true);
  try {
    const code = byId(operation === 'sessions' ? 'signin-code' : 'enroll-code').value;
    const invitationToken = byId('invitation').value;
    if (operation !== 'enrollment' && !/^[0-9]{6}$/.test(code)) throw Error();
    const response = await request(operation, {
      actor, requestId: crypto.randomUUID(),
      ...(operation === 'sessions' ? {} : { invitationToken }),
      ...(operation === 'enrollment' ? {} : { code })
    });
    if (!response.ok) throw Error();
    const result = response.result;
    if (operation === 'enrollment') {
      const uri = new URL(result.enrollmentUri);
      const seed = uri.searchParams.get('secret');
      if (uri.protocol !== 'otpauth:' || !/^[A-Z2-7]{32}$/.test(seed || '')) throw Error();
      byId('setup-key').textContent = seed; byId('setup').hidden = false;
      byId('status').textContent = '';
    } else if (operation === 'enrollment/confirm') {
      if (result.status !== 'activated') throw Error();
      byId('setup-key').textContent = ''; byId('setup').hidden = true;
      byId('invitation').value = ''; notice('activated');
    } else {
      if (!/^v1\.as\.[A-Za-z0-9_-]{43}$/.test(result.adminSessionToken)) throw Error();
      adminBearer = result.adminSessionToken; bearer = '';
      byId('setup-key').textContent = ''; byId('setup').hidden = true;
      byId('invitation').value = ''; byId('logout').hidden = false; notice('signed_in');
    }
  } catch { notice('unavailable'); }
  finally {
    byId('signin-code').value = ''; byId('enroll-code').value = '';
    busy = false; disable(!!adminBearer || !bearer);
  }
}
byId('signin').addEventListener('submit', event => { event.preventDefault(); void perform('sessions'); });
byId('enroll').addEventListener('submit', event => { event.preventDefault(); void perform('enrollment/confirm'); });
byId('begin').addEventListener('click', () => { void perform('enrollment'); });
byId('logout').addEventListener('click', async () => {
  if (busy || !adminBearer || !actor) return;
  busy = true; byId('logout').disabled = true;
  try {
    const response = await request('sessions/logout', { actor: { kind: 'admin', userId: actor.userId }, requestId: crypto.randomUUID() }, adminBearer);
    if ((!response.ok && response.status !== 401) || (response.ok && response.result.status !== 'revoked')) throw Error();
    adminBearer = ''; actor = undefined; byId('logout').hidden = true; notice('signed_out');
  } catch { notice('unavailable'); }
  finally { busy = false; byId('logout').disabled = false; }
});
void (async () => {
  try {
    if (!/^v1\.us\.[A-Za-z0-9._-]{16,2048}$/.test(bearer)) throw Error();
    const response = await request('context');
    if (!response.ok) throw Error();
    const result = response.result;
    if (result.actor?.kind !== 'user' || !/^[0-9a-f-]{36}$/.test(result.actor.userId)) throw Error();
    actor = { kind: 'user', userId: result.actor.userId }; disable(false);
  } catch { bearer = ''; notice('expired'); }
})();
})();`;

@Controller('v1/admin/auth')
class AdministratorPageController {
  private readonly boundary: M7ApiBoundary;
  public constructor(@Inject(OPTIONS) private readonly options: Options) {
    this.boundary = new M7ApiBoundary(options.authenticator);
  }
  @Get('page')
  public page(@Req() request: FastifyRequest, @Res() reply: FastifyReply): void {
    headers(reply);
    const query = request.query as Readonly<{ locale?: unknown }> | undefined;
    reply
      .type('text/html; charset=utf-8')
      .send(administratorSignInHtml(this.options.catalogs(), query?.locale));
  }
  @Get('page.js')
  public script(@Res() reply: FastifyReply): void {
    headers(reply);
    reply.type('text/javascript; charset=utf-8').send(ADMINISTRATOR_SIGNIN_SCRIPT);
  }
  @Get('context')
  public async context(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Readonly<{ actor: Readonly<{ kind: 'user'; userId: string }> }>> {
    headers(reply);
    const actor = await this.boundary.user(request);
    return this.boundary.userResult(
      {
        type: 'object',
        additionalProperties: false,
        required: ['actor'],
        properties: {
          actor: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'userId'],
            properties: { kind: { const: 'user' }, userId: { type: 'string', format: 'uuid' } },
          },
        },
      },
      actor,
      async () => {
        if (!(await this.options.eligible(actor)))
          throw new ApplicationError('unauthorized', 'error.m7.unavailable', 401);
        return { actor: { kind: 'user' as const, userId: actor.userId } };
      },
    );
  }
}
@Module({})
export class AdministratorPageModule {
  public static register(options: Options): DynamicModule {
    return {
      module: AdministratorPageModule,
      controllers: [AdministratorPageController],
      providers: [{ provide: OPTIONS, useValue: options }],
    };
  }
}
