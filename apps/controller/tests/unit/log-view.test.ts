import { describe, expect, it } from 'bun:test';
import { accessLine, isAcmeLine, isLogView } from '../../src/lib/log-view';

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
