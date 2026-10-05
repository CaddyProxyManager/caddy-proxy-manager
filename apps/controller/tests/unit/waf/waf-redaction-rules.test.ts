/**
 * The credential rules a stored WAF event is redacted by, on ingest and again on read: headers
 * named like a token, secret or API key, and parameters named like a password or token.
 */
import { describe, expect, it } from 'bun:test';
import { isCredentialName, redactAuditEntry, redactQueryString } from '@cpm/shared';
import { redactStoredWafEvent } from '@/src/lib/models/waf-events';

describe('credential names', () => {
  it('covers the auth and cookie headers', () => {
    for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Set-Cookie']) {
      expect(isCredentialName(name)).toBe(true);
    }
  });

  it('covers any header holding token, secret, api-key or apikey', () => {
    for (const name of ['X-Upstream-Token', 'X-Client-Secret', 'X-Api-Key', 'MyApikey']) {
      expect(isCredentialName(name)).toBe(true);
    }
  });

  it('leaves ordinary headers alone', () => {
    for (const name of ['User-Agent', 'Accept', 'Host', 'Content-Type', 'X-Forwarded-For']) {
      expect(isCredentialName(name)).toBe(false);
    }
  });
});

describe('query and form redaction', () => {
  it('replaces credential-named parameters only', () => {
    expect(
      redactQueryString(
        '/login?user=sam&password=hunter2&new_passwd=x&access_token=t&api_key=k&apikey=k&secret=s&page=2',
      ),
    ).toBe(
      '/login?user=sam&password=[redacted]&new_passwd=[redacted]&access_token=[redacted]' +
        '&api_key=[redacted]&apikey=[redacted]&secret=[redacted]&page=2',
    );
  });

  it('redacts form fields in a body and the args map', () => {
    const redacted = redactAuditEntry({
      transaction: {
        request: {
          uri: '/login',
          body: 'user=sam&password=hunter2',
          args: { user: 'sam', password: 'hunter2' },
          headers: { 'x-upstream-token': ['t0k3n'] },
        },
      },
    });
    const request = redacted.transaction.request;
    expect(request.body).toBe('user=sam&password=[redacted]');
    expect(request.args).toEqual({ user: 'sam', password: '[redacted]' });
    expect(request.headers['x-upstream-token']).toEqual(['[redacted]']);
  });

  it('leaves a JSON body to the rules that matched it', () => {
    const body = '{"password":"x"}';
    expect(redactAuditEntry({ transaction: { request: { body } } }).transaction.request.body).toBe(
      body,
    );
  });

  it('tests a long run of = in linear time', () => {
    const body = `${'='.repeat(40_000)} `;
    const started = performance.now();
    expect(redactAuditEntry({ transaction: { request: { body } } }).transaction.request.body).toBe(
      body,
    );
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('replaces a body too long to parse', () => {
    const body = `password=${'x'.repeat(70_000)}`;
    expect(redactAuditEntry({ transaction: { request: { body } } }).transaction.request.body).toBe(
      '[redacted]',
    );
  });

  it('covers authentication and session-id names', () => {
    for (const name of ['X-Authentication', 'PHPSESSID', 'jsessionid', 'aspnet_sessionid']) {
      expect(isCredentialName(name)).toBe(true);
    }
  });

  it('redacts credential query parameters in URL-valued headers', () => {
    const redacted = redactAuditEntry({
      transaction: {
        request: {
          headers: {
            Referer: ['https://a.example.com/cb?code=abc&state=1'],
            Origin: 'https://a.example.com',
          },
        },
        response: { headers: { Location: ['/next?access_token=t'] } },
      },
    });
    expect(redacted.transaction.request.headers.Referer).toEqual([
      'https://a.example.com/cb?code=[redacted]&state=1',
    ]);
    expect(redacted.transaction.request.headers.Origin).toBe('https://a.example.com');
    expect(redacted.transaction.response.headers.Location).toEqual([
      '/next?access_token=[redacted]',
    ]);
  });
});

describe('redaction on read', () => {
  it('redacts a row stored before a rule covered it, keeping its key', () => {
    const event = {
      id: 1,
      key: '1700000000.0123456789abcdef0123',
      ts: 1_700_000_000,
      host: 'app.example.com',
      clientIp: '203.0.113.7',
      countryCode: null,
      method: 'GET',
      uri: '/?session_token=abc',
      ruleId: 942100,
      ruleMessage: 'SQLi',
      severity: 'CRITICAL',
      rawData: JSON.stringify({
        transaction: {
          request: {
            uri: '/?session_token=abc',
            headers: { 'x-service-secret': ['s3cr3t'], cookie: ['sid=1'] },
          },
        },
      }),
      blocked: true,
    };
    const read = redactStoredWafEvent(event);
    expect(read.key).toBe(event.key);
    expect(read.uri).toBe('/?session_token=[redacted]');
    expect(read.rawData).not.toContain('s3cr3t');
    expect(read.rawData).not.toContain('sid=1');
    expect(read.rawData).not.toContain('abc');
  });
});
