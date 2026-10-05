/** A fresh deployment reached at its IP got "Invalid origin": BASE_URL defaults to localhost. */
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const ctx = vi.hoisted(() => ({
  setupCompleted: false as boolean | Error,
  setupChecks: 0,
  publicUrl: 'http://localhost:3000',
  dashboard: null as { enabled: boolean; domain: string; tls: boolean } | null,
}));

vi.mock('@/src/lib/setup', () => ({
  isSetupCompleted: async () => {
    ctx.setupChecks++;
    if (ctx.setupCompleted instanceof Error) throw ctx.setupCompleted;
    return ctx.setupCompleted;
  },
}));

vi.mock('@/src/lib/settings/resolve', () => ({
  getSetting: async () => ctx.publicUrl,
}));

vi.mock('@/src/lib/settings', () => ({
  getDashboardSettings: async () => ctx.dashboard,
}));

import {
  extraTrustedOrigins,
  resetTrustedOriginsCache,
  sameOriginOf,
} from '@/src/lib/auth/trusted-origins';
import { config } from '@/src/lib/config';
import { isPublicOrigin } from '@/src/lib/http/public-url';

const SERVER_IP = 'http://15.204.117.249:3000';

function post(url: string, headers: Record<string, string>) {
  return new Request(url, { method: 'POST', headers });
}

beforeEach(() => {
  ctx.setupCompleted = false;
  ctx.setupChecks = 0;
  ctx.publicUrl = 'http://localhost:3000';
  ctx.dashboard = null;
  resetTrustedOriginsCache();
});

describe('sameOriginOf', () => {
  it('accepts an Origin naming the host the request was sent to', () => {
    const request = post(`${SERVER_IP}/api/auth/sign-in/username`, {
      host: '15.204.117.249:3000',
      origin: SERVER_IP,
    });
    expect(sameOriginOf(request)).toBe(SERVER_IP);
  });

  it('falls back to the Referer, reduced to its origin', () => {
    const request = post('http://10.0.0.5:3000/api/auth/sign-in/username', {
      host: '10.0.0.5:3000',
      referer: 'http://10.0.0.5:3000/login?next=%2F',
    });
    expect(sameOriginOf(request)).toBe('http://10.0.0.5:3000');
  });

  it('refuses a cross-site Origin', () => {
    const request = post(`${SERVER_IP}/api/auth/sign-in/username`, {
      host: '15.204.117.249:3000',
      origin: 'https://attacker.example',
    });
    expect(sameOriginOf(request)).toBeNull();
  });

  it('refuses the same host on another port', () => {
    const request = post(`${SERVER_IP}/api/auth/sign-in/username`, {
      host: '15.204.117.249:3000',
      origin: 'http://15.204.117.249:8080',
    });
    expect(sameOriginOf(request)).toBeNull();
  });

  it('refuses opaque, missing and non-http origins', () => {
    const url = `${SERVER_IP}/api/auth/sign-in/username`;
    const host = '15.204.117.249:3000';
    expect(sameOriginOf(post(url, { host, origin: 'null' }))).toBeNull();
    expect(sameOriginOf(post(url, { host }))).toBeNull();
    expect(sameOriginOf(post(url, { host, origin: 'file://15.204.117.249:3000' }))).toBeNull();
  });
});

describe('extraTrustedOrigins', () => {
  const signIn = () =>
    post(`${SERVER_IP}/api/auth/sign-in/username`, {
      host: '15.204.117.249:3000',
      origin: SERVER_IP,
    });

  it("trusts the browser's own address while setup is unfinished", async () => {
    expect(await extraTrustedOrigins(signIn())).toContain(SERVER_IP);
  });

  it('stops once setup is finished, and stops asking', async () => {
    ctx.setupCompleted = true;
    expect(await extraTrustedOrigins(signIn())).not.toContain(SERVER_IP);
    expect(await extraTrustedOrigins(signIn())).not.toContain(SERVER_IP);
    expect(ctx.setupChecks).toBe(1);
  });

  it('fails closed when the setup flag cannot be read', async () => {
    ctx.setupCompleted = new Error('database unavailable');
    expect(await extraTrustedOrigins(signIn())).not.toContain(SERVER_IP);
  });

  it('trusts the stored Public URL and BASE_URL together, before and after setup', async () => {
    ctx.publicUrl = 'https://proxy.example.com/';
    ctx.setupCompleted = true;
    const baseOrigin = new URL(config.baseUrl).origin;
    for (const origins of [await extraTrustedOrigins(signIn()), await extraTrustedOrigins()]) {
      expect(origins).toContain('https://proxy.example.com');
      expect(origins).toContain(baseOrigin);
    }
  });

  it('adds no request address without a request', async () => {
    expect(await extraTrustedOrigins()).not.toContain(SERVER_IP);
  });

  it('trusts the dashboard host, which is this app under a name of its own', async () => {
    // The dashboard domain differs from the Public URL by port alone.
    ctx.setupCompleted = true;
    ctx.dashboard = { enabled: true, domain: 'cpm.example.com', tls: false };
    expect(await extraTrustedOrigins()).toContain('http://cpm.example.com');

    ctx.dashboard = { enabled: true, domain: 'cpm.example.com', tls: true };
    expect(await extraTrustedOrigins()).toContain('https://cpm.example.com');
  });

  it('trusts nothing for a dashboard host that serves nothing', async () => {
    ctx.setupCompleted = true;
    ctx.dashboard = { enabled: false, domain: 'cpm.example.com', tls: false };
    expect(await extraTrustedOrigins()).not.toContain('http://cpm.example.com');

    // Anything but a hostname could carry a scheme, port or path into what is trusted.
    ctx.dashboard = { enabled: true, domain: 'cpm.example.com/evil', tls: false };
    expect(await extraTrustedOrigins()).toHaveLength(1);
  });
});

describe('isPublicOrigin', () => {
  it('accepts the stored Public URL and BASE_URL, and nothing else', async () => {
    ctx.publicUrl = 'https://proxy.example.com/';
    expect(await isPublicOrigin('https://proxy.example.com')).toBe(true);
    expect(await isPublicOrigin(new URL(config.baseUrl).origin)).toBe(true);
    expect(await isPublicOrigin('https://attacker.example')).toBe(false);
    // Trusted for signing in only: the forward-auth portal reads this list too.
    ctx.dashboard = { enabled: true, domain: 'cpm.example.com', tls: true };
    expect(await isPublicOrigin('https://cpm.example.com')).toBe(false);
    expect(await isPublicOrigin('https://proxy.example.com:8443')).toBe(false);
    expect(await isPublicOrigin(null)).toBe(false);
  });
});
