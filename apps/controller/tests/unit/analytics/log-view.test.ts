import { describe, expect, it } from 'bun:test';
import {
  accessLine,
  isAcmeLine,
  isLineForHosts,
  isLogView,
  lineHosts,
} from '../../../src/lib/analytics/log-view';

describe('accessLine', () => {
  it('puts a JSON access entry on one readable line', () => {
    const line = JSON.stringify({
      ts: 1790000000.5,
      request: { client_ip: '203.0.113.9', method: 'GET', host: 'app.example.com', uri: '/a?b=1' },
      status: 404,
      duration: 0.0123,
    });
    expect(accessLine(line)).toBe(
      `${new Date(1790000000500).toISOString()} 203.0.113.9 GET app.example.com/a?b=1 -> 404 12ms`,
    );
  });

  it('leaves anything else as Caddy wrote it', () => {
    expect(accessLine('203.0.113.9 - - [26/Sep/2026] "GET / HTTP/1.1" 200')).toBeNull();
    expect(accessLine('{"msg":"no request here"}')).toBeNull();
  });
});

describe('isAcmeLine', () => {
  it("picks certificate work out of Caddy's log", () => {
    expect(isAcmeLine('{"logger":"tls.obtain","msg":"certificate obtained"}')).toBe(true);
    expect(isAcmeLine('{"logger":"http.acme_client","msg":"trying to solve challenge"}')).toBe(
      true,
    );
    expect(isAcmeLine('{"logger":"http.log.access","msg":"handled request"}')).toBe(false);
    expect(isAcmeLine('not json')).toBe(false);
  });
});

describe('isLogView', () => {
  it('accepts the four views and nothing else', () => {
    for (const view of ['access', 'waf', 'caddy', 'acme']) expect(isLogView(view)).toBe(true);
    expect(isLogView('../etc/passwd')).toBe(false);
  });
});

describe('lineHosts', () => {
  it('reads the site off an access, WAF or ACME line, without its port', () => {
    expect(
      lineHosts('access', JSON.stringify({ request: { host: 'App.Example.com:8443' } })),
    ).toEqual(['app.example.com']);
    const waf = { transaction: { request: { headers: { host: ['api.example.com'] } } } };
    expect(lineHosts('waf', JSON.stringify(waf))).toEqual(['api.example.com']);
    expect(lineHosts('acme', '{"logger":"tls.obtain","identifier":"app.example.com"}')).toEqual([
      'app.example.com',
    ]);
    expect(
      lineHosts('acme', '{"logger":"tls.issuance.acme","identifiers":["a.example","b.example"]}'),
    ).toEqual(['a.example', 'b.example']);
  });

  it('finds none in a line that names no site', () => {
    expect(lineHosts('caddy', '{"logger":"admin","host":"app.example.com"}')).toEqual([]);
    expect(lineHosts('access', 'GET / 200')).toEqual([]);
  });
});

describe('isLineForHosts', () => {
  const hosts = new Set(['app.example.com', 'www.example.com']);
  it("keeps only a line for one of the host's names", () => {
    expect(isLineForHosts('access', '{"request":{"host":"www.example.com"}}', hosts)).toBe(true);
    expect(isLineForHosts('access', '{"request":{"host":"other.example.com"}}', hosts)).toBe(false);
    expect(isLineForHosts('access', 'app.example.com in plain text', hosts)).toBe(false);
  });
});
