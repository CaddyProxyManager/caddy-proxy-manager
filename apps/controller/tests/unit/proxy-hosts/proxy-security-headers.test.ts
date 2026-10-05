/**
 * Regression (L1): public pages (/login, /portal, /setup) got framing protection only - no script
 * policy, Referrer-Policy or Permissions-Policy - and nothing sent HSTS.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { NextRequest } from 'next/server';
import { config } from '@/src/lib/config';
import proxy from '@/src/proxy';

const originalBaseUrl = config.baseUrl;

afterEach(() => {
  (config as { baseUrl: string }).baseUrl = originalBaseUrl;
});

function forwardedCsp(response: Response): string | null {
  for (const [name, value] of response.headers) {
    if (name.startsWith('x-middleware-request-') && name.endsWith('content-security-policy')) {
      return value;
    }
  }
  return null;
}

describe('proxy security headers', () => {
  it.each(['/portal', '/setup', '/setup/migrate'])(
    'gives the public page %s a nonce CSP that reaches the renderer',
    async (path) => {
      const response = await proxy(new NextRequest(`http://localhost:3000${path}`));
      const csp = response.headers.get('content-security-policy') ?? '';

      expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp).toContain("frame-ancestors 'none'");
      // default-src does not cover these, so each needs saying.
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(forwardedCsp(response)).toBe(csp);
      expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('permissions-policy')).toContain('camera=()');
      expect(response.headers.get('x-frame-options')).toBe('DENY');
    },
  );

  it('uses a fresh nonce per request', async () => {
    const a = await proxy(new NextRequest('http://localhost:3000/portal'));
    const b = await proxy(new NextRequest('http://localhost:3000/portal'));
    expect(a.headers.get('content-security-policy')).not.toBe(
      b.headers.get('content-security-policy'),
    );
  });

  it('keeps public API responses free of a document CSP', async () => {
    const response = await proxy(new NextRequest('http://localhost:3000/api/auth/get-session'));
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(forwardedCsp(response)).toBeNull();
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  it('sends HSTS only when the dashboard is served over HTTPS', async () => {
    const plain = await proxy(new NextRequest('http://localhost:3000/portal'));
    expect(plain.headers.get('strict-transport-security')).toBeNull();

    (config as { baseUrl: string }).baseUrl = 'https://cpm.example.com';
    const secure = await proxy(new NextRequest('https://cpm.example.com/api/health'));
    expect(secure.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});
