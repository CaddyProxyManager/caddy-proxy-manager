/**
 * The /api/auth wrapper around the passkey routes: adding and removing one is audited, the shared
 * demo account cannot touch them, a passkey sign-in skips the password path's throttle, and SCIM's
 * other methods reach the library.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { testTranslator } from '@/tests/helpers/next-intl';

const ctx = vi.hoisted(() => ({
  seen: [] as string[],
  methods: [] as string[],
  status: 200,
  userId: '7',
  audits: [] as Array<{ action: string; summary: string; userId: number }>,
}));

vi.mock('@/src/lib/auth/server', () => ({
  getAuth: async () => ({
    handler: async (request: Request) => {
      ctx.seen.push(new URL(request.url).pathname);
      ctx.methods.push(request.method);
      return new Response('{}', { status: ctx.status });
    },
    api: { getSession: async () => ({ user: { id: ctx.userId } }) },
  }),
}));

vi.mock('@/src/lib/models/audit', () => ({
  createAuditEvent: async (event: { action: string; summary: string; userId: number }) => {
    ctx.audits.push(event);
  },
}));

vi.mock('@/src/lib/captcha/settings', () => ({ getActiveCaptcha: async () => null }));

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) => testTranslator(namespace),
}));

import { DELETE, GET, PATCH, POST, PUT } from '@/src/app/api/auth/[...all]/route';

const post = (path: string, body: unknown = {}) =>
  POST(
    new Request(`http://localhost:3000/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  ctx.seen = [];
  ctx.methods = [];
  ctx.status = 200;
  ctx.userId = '7';
  ctx.audits = [];
});

afterEach(() => {
  delete process.env.DEMO_MODE;
});

describe('/api/auth passkey routes', () => {
  it('audits a passkey added and a passkey removed, once they succeed', async () => {
    await post('/passkey/verify-registration', { response: {} });
    await post('/passkey/delete-passkey', { id: '3' });
    expect(ctx.audits.map(({ action, summary, userId }) => ({ action, summary, userId }))).toEqual([
      { action: 'passkey_added', summary: 'User added a passkey', userId: 7 },
      { action: 'passkey_removed', summary: 'User removed a passkey', userId: 7 },
    ]);
  });

  it('audits nothing the plugin refused', async () => {
    ctx.status = 400;
    await post('/passkey/verify-registration', { response: {} });
    await post('/passkey/delete-passkey', { id: '3' });
    expect(ctx.audits).toEqual([]);
  });

  it('leaves the sign-in audit to the session hook', async () => {
    await post('/passkey/verify-authentication', { response: {} });
    expect(ctx.seen).toEqual(['/api/auth/passkey/verify-authentication']);
    expect(ctx.audits).toEqual([]);
  });

  it('locks the shared demo account out of every passkey write, the GET that starts one too', async () => {
    process.env.DEMO_MODE = 'true';
    ctx.userId = '1';
    for (const path of [
      '/passkey/verify-registration',
      '/passkey/update-passkey',
      '/passkey/delete-passkey',
    ]) {
      const response = await post(path);
      expect(response.status).toBe(403);
      expect((await response.json()).code).toBe('DEMO_LOCKED');
    }
    const start = await GET(
      new Request('http://localhost:3000/api/auth/passkey/generate-register-options'),
    );
    expect(start.status).toBe(403);
    expect(ctx.seen).toEqual([]);
  });

  it('still lets the demo account sign in with a passkey it cannot have', async () => {
    process.env.DEMO_MODE = 'true';
    ctx.userId = '1';
    const response = await GET(
      new Request('http://localhost:3000/api/auth/passkey/generate-authenticate-options'),
    );
    expect(response.status).toBe(200);
  });
});

// A method the route does not export answers 405 before the library sees it.
describe('/api/auth beyond GET and POST', () => {
  it("hands SCIM's PUT, PATCH and DELETE to the library, method and all", async () => {
    for (const [method, handle] of [
      ['PUT', PUT],
      ['PATCH', PATCH],
      ['DELETE', DELETE],
    ] as const) {
      const response = await handle(
        new Request('http://localhost:3000/api/auth/scim/v2/Users/u1', {
          method,
          headers: { 'content-type': 'application/scim+json' },
          ...(method === 'DELETE' ? {} : { body: '{}' }),
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(ctx.methods).toEqual(['PUT', 'PATCH', 'DELETE']);
    expect(ctx.seen).toEqual(Array(3).fill('/api/auth/scim/v2/Users/u1'));
  });
});
