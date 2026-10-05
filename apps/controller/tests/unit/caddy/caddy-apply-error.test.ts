import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import {
  CaddyApplyError,
  describeCaddyRejection,
  logCaddyApplyFailure,
} from '@/src/lib/caddy/apply-error';

describe('Caddy apply error redaction', () => {
  it('logs safe metadata without raw messages, response bodies, URLs, or stacks', () => {
    const sensitiveDetail = 'http://caddy:2019 raw-response-secret-sentinel';
    const failure = Object.assign(new Error(sensitiveDetail), { code: 'ECONNREFUSED' });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const errorId = logCaddyApplyFailure('Caddy admin request failed', failure, {
      status: 502,
    });

    expect(errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(sensitiveDetail);
    expect(consoleSpy).toHaveBeenCalledWith(
      'Caddy apply failure',
      expect.objectContaining({
        errorId,
        context: 'Caddy admin request failed',
        errorType: 'Error',
        code: 'ECONNREFUSED',
        status: 502,
      }),
    );
    consoleSpy.mockRestore();
  });

  // The rejection fails the whole document, so without the cause every host silently freezes.
  it('names known config rejections without echoing the response body', () => {
    const body = JSON.stringify({
      error:
        "loading new config: ... position 1: loading module 'waf': provision http.handlers.waf: " +
        'request body limit should be at most 1GiB (host secret-internal.example)',
    });
    const reason = describeCaddyRejection(body);

    expect(reason).toBe("a WAF request body limit exceeds Coraza's maximum of 1 GiB");
    expect(reason).not.toContain('secret-internal.example');
  });

  it('recognises the in-memory/request limit mismatch', () => {
    expect(describeCaddyRejection('request body limit should be at least the memory limit')).toBe(
      'a WAF in-memory body limit is larger than its request body limit',
    );
  });

  it('returns null for rejections it cannot explain', () => {
    expect(
      describeCaddyRejection('{"error":"unrelated failure for host secret.example"}'),
    ).toBeNull();
  });

  it('never constructs an exception from Caddy response text', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/caddy/index.ts'), 'utf8');
    const error = new CaddyApplyError('Caddy rejected configuration', 'CADDY_REJECTED');

    expect(error.message).toBe('Caddy rejected configuration');
    expect(source).not.toMatch(/(?:throw new Error|console\.error)[^\n]*response\.text/);
    expect(source).toContain('responseBytes: Buffer.byteLength(response.text)');
  });
});
