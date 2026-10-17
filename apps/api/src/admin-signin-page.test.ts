import 'reflect-metadata';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { M9_ADMIN_TEXTS } from '@nakh/localization';
import { ADMINISTRATOR_SIGNIN_SCRIPT, administratorSignInHtml } from './admin-signin-page.js';

type Listener = (event: { preventDefault: () => void }) => void | Promise<void>;
function browser(
  fetcher: typeof fetch,
  fragment = `session=${'v1.us.' + 'a'.repeat(60)}`,
): {
  elements: Map<
    string,
    {
      value: string;
      textContent: string;
      hidden: boolean;
      disabled: boolean;
      listeners: Map<string, Listener>;
    }
  >;
  history: ReturnType<typeof vi.fn>;
  events: string[];
  fire: (id: string, event: string) => Promise<void>;
} {
  const names = [
    'signin',
    'enroll',
    'signin-fields',
    'enroll-fields',
    'signin-code',
    'enroll-code',
    'invitation',
    'setup',
    'setup-key',
    'begin',
    'logout',
    'status',
    ...['activated', 'signed_in', 'signed_out', 'unavailable', 'expired'].map(
      (key) => 'notice-' + key,
    ),
  ];
  const elements = new Map(
    names.map((name) => [
      name,
      {
        value: '',
        textContent: name.startsWith('notice-') ? name.slice('notice-'.length) : '',
        hidden: true,
        disabled: name.endsWith('-fields'),
        listeners: new Map<string, Listener>(),
        addEventListener(event: string, listener: Listener): void {
          this.listeners.set(event, listener);
        },
      },
    ]),
  );
  const events: string[] = [];
  const history = vi.fn(() => {
    events.push('history');
  });
  const sandbox = {
    document: {
      getElementById: (id: string) => elements.get(id),
      get cookie(): never {
        throw new Error('Browser cookies forbidden');
      },
    },
    location: { hash: '#' + fragment, pathname: '/v1/admin/auth/page', search: '?locale=en' },
    history: { replaceState: history },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: { randomUUID },
    fetch: (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
      events.push('fetch');
      return fetcher(...args);
    },
    get localStorage(): never {
      throw new Error('Browser persistence forbidden');
    },
    get sessionStorage(): never {
      throw new Error('Browser persistence forbidden');
    },
  };
  runInNewContext(ADMINISTRATOR_SIGNIN_SCRIPT, sandbox);
  return {
    elements,
    history,
    events,
    fire: async (id, event) => {
      await elements.get(id)!.listeners.get(event)!({ preventDefault: vi.fn() });
    },
  };
}
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function requestPath(value: Parameters<typeof fetch>[0]): string {
  if (typeof value !== 'string') throw new Error('Expected a relative request path');
  return value;
}
function requestBody(init: RequestInit): unknown {
  if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as unknown;
}
afterEach(() => vi.useRealTimers());
describe('minimal administrator sign-in browser entry', () => {
  it('escapes catalog content, has disabled initial forms and uses only an external same-origin script', () => {
    const html = administratorSignInHtml(
      {
        defaultLocale: 'en',
        messages: { en: { ...M9_ADMIN_TEXTS, 'admin.auth.title': '<script>private</script>' } },
      },
      '__proto__',
    );
    expect(html).toContain('&lt;script&gt;private&lt;/script&gt;');
    expect(html).not.toContain('<script>private');
    expect(html).toContain('<fieldset id="signin-fields" disabled>');
    expect(html).toContain('type="module" src="/v1/admin/auth/page.js"');
    expect(html).not.toContain('onerror=');
  });
  it('strips the fragment before requesting native identity and keeps TOTP and the admin bearer in the proper channels', async () => {
    const userId = randomUUID(),
      adminToken = 'v1.as.' + 'b'.repeat(43);
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetcher = vi.fn<typeof fetch>((url, init) => {
      const path = requestPath(url);
      calls.push({ path, init: init! });
      if (path.endsWith('/context'))
        return Promise.resolve(
          response({ actor: { kind: 'user', userId, roles: ['untrusted-role'] } }),
        );
      if (path.endsWith('/sessions/logout'))
        return Promise.resolve(response({ status: 'revoked' }));
      return Promise.resolve(response({ adminSessionToken: adminToken }));
    });
    const b = browser(fetcher);
    expect(b.events.slice(0, 2)).toEqual(['history', 'fetch']);
    await vi.waitFor(() => expect(b.elements.get('signin-fields')!.disabled).toBe(false));
    expect(b.history).toHaveBeenCalledWith(null, '', '/v1/admin/auth/page?locale=en');
    b.elements.get('signin-code')!.value = '123456';
    await b.fire('signin', 'submit');
    await vi.waitFor(() => expect(b.elements.get('status')!.textContent).toBe('signed_in'));
    const login = calls[1]!;
    expect(login.path).toBe('/v1/admin/auth/sessions');
    expect(requestBody(login.init)).toEqual({
      actor: { kind: 'user', userId },
      requestId: expect.any(String) as unknown,
      code: '123456',
    });
    expect(login.init).toMatchObject({ redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(b.elements.get('signin-code')!.value).toBe('');
    expect(b.elements.get('signin-fields')!.disabled).toBe(true);
    await b.fire('begin', 'click');
    expect(calls).toHaveLength(2);
    await b.fire('logout', 'click');
    await vi.waitFor(() => expect(b.elements.get('status')!.textContent).toBe('signed_out'));
    expect(calls[2]!.init.headers).toMatchObject({ authorization: 'Bearer ' + adminToken });
    expect(requestBody(calls[2]!.init)).toMatchObject({ actor: { kind: 'admin', userId } });
  });
  it('requires separate enrollment confirmation and a later explicit sign-in, clearing seed and invitation after activation', async () => {
    const userId = randomUUID(),
      seed = 'A'.repeat(32);
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>((url) => {
      const path = requestPath(url);
      calls.push(path);
      if (path.endsWith('/context'))
        return Promise.resolve(response({ actor: { kind: 'user', userId } }));
      if (path.endsWith('/enrollment/confirm'))
        return Promise.resolve(response({ status: 'activated' }));
      return Promise.resolve(response({ enrollmentUri: 'otpauth://totp/Nakh?secret=' + seed }));
    });
    const b = browser(fetcher);
    await vi.waitFor(() => expect(b.elements.get('enroll-fields')!.disabled).toBe(false));
    b.elements.get('invitation')!.value = 'synthetic-operator-invitation';
    await b.fire('begin', 'click');
    await vi.waitFor(() => expect(b.elements.get('setup-key')!.textContent).toBe(seed));
    b.elements.get('enroll-code')!.value = '654321';
    await b.fire('enroll', 'submit');
    await vi.waitFor(() => expect(b.elements.get('status')!.textContent).toBe('activated'));
    expect(b.elements.get('setup-key')!.textContent).toBe('');
    expect(b.elements.get('invitation')!.value).toBe('');
    expect(b.elements.get('enroll-code')!.value).toBe('');
    expect(calls.some((path) => path.endsWith('/sessions'))).toBe(false);
  });
  it('does not request identity for a malformed handoff and keeps expired entry disabled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const b = browser(fetcher, 'session=private-malformed-fragment');
    await vi.waitFor(() => expect(b.elements.get('status')!.textContent).toBe('expired'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(b.history).toHaveBeenCalledOnce();
    expect(b.elements.get('signin-fields')!.disabled).toBe(true);
  });
  it('bounds a stalled JSON body as well as the initial fetch without retrying a privileged request', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener('abort', () =>
              reject(new Error('private-network-error')),
            ),
          ),
      } as Response),
    );
    const b = browser(fetcher);
    await vi.advanceTimersByTimeAsync(10001);
    expect(b.elements.get('status')!.textContent).toBe('expired');
    expect(b.elements.get('signin-fields')!.disabled).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
