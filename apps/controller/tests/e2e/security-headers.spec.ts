import { test, expect } from '@playwright/test';

/** Login and portal carry the dashboard's nonce CSP, referrer and permissions policies. */

const BASE_URL = 'http://localhost:3000';

for (const path of ['/login', '/portal']) {
  test(`public page ${path} carries the nonce CSP and the full header set`, async ({ request }) => {
    const resp = await request.get(`${BASE_URL}${path}`, { maxRedirects: 0 });
    const headers = resp.headers();
    const csp = headers['content-security-policy'] ?? '';

    expect((headers['x-frame-options'] ?? '').toUpperCase()).toBe('DENY');
    expect(csp).toMatch(/frame-ancestors\s+'none'/i);
    expect(csp).toMatch(/script-src\s+'self'\s+'nonce-[A-Za-z0-9+/=]+'/);
    expect((headers['x-content-type-options'] ?? '').toLowerCase()).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['permissions-policy'] ?? '').toContain('camera=()');
    // The e2e stack serves plain HTTP, where HSTS must not be sent.
    expect(headers['strict-transport-security']).toBeUndefined();
  });
}

test('a public API response gets framing and referrer policy but no document CSP', async ({
  request,
}) => {
  const resp = await request.get(`${BASE_URL}/api/health`);
  const headers = resp.headers();

  expect(headers['content-security-policy']).toBe("frame-ancestors 'none'");
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
});
