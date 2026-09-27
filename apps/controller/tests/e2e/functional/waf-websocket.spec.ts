/**
 * Issue #195: routing upgrades around the WAF let any request claiming one skip inspection; since
 * coraza-caddy 2.6 passes the 101 hijack through, they go through it.
 * Upstream: traefik/whoami's /echo. Domain: func-waf-ws.test
 */
import { test, expect } from '@playwright/test';
import { createProxyHost } from '../../helpers/proxy-api';
import { httpGet, waitForRoute, wsEcho, wsHandshake } from '../../helpers/http';

const DOMAIN = 'func-waf-ws.test';

test.describe
  .serial('WAF + WebSocket (issue #195)', () => {
    test('setup: create proxy host with WAF enabled, websocket-capable upstream', async ({
      page,
    }) => {
      await createProxyHost(page, {
        name: 'Functional WAF WebSocket Test',
        domain: DOMAIN,
        upstream: 'whoami-server:80',
        enableWaf: true,
      });
      await waitForRoute(DOMAIN);
    });

    test('WebSocket upgrade through WAF returns 101 Switching Protocols (not mangled HTTP/0.9)', async () => {
      const res = await wsHandshake(DOMAIN, '/echo');
      // The bug gave statusCode 0 or a closed connection with a raw body.
      expect(res.statusCode, `handshake response: ${JSON.stringify(res.raw)}`).toBe(101);
      expect(res.statusLine).toMatch(/HTTP\/1\.1 101/);
      expect(res.headers.upgrade?.toLowerCase()).toBe('websocket');
      expect(res.headers.connection?.toLowerCase()).toContain('upgrade');
      expect(res.headers['sec-websocket-accept']).toBeTruthy();
    });

    test('frames round-trip over the upgraded connection', async () => {
      expect(await wsEcho(DOMAIN, '/echo', 'through-the-waf')).toBe('through-the-waf');
    });

    test('an attack claiming to be a WebSocket upgrade is still inspected', async () => {
      const res = await httpGet(DOMAIN, '/page?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E', {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
      });
      expect(res.status).toBe(403);
    });

    test('a real handshake carrying an attack is refused', async () => {
      const res = await wsHandshake(DOMAIN, '/echo?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
      expect(res.statusCode).toBe(403);
    });

    test('ordinary HTTP request through the same WAF host still passes', async () => {
      const res = await httpGet(DOMAIN, '/');
      expect(res.status).toBe(200);
    });

    test('WAF still blocks attacks on the same host', async () => {
      // CRS rule 941xxx.
      const res = await httpGet(DOMAIN, '/page?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
      expect(res.status).toBe(403);
    });
  });
