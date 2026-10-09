import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

vi.mock('@/src/lib/users/permissions', () => ({
  requireCan: vi.fn().mockResolvedValue(undefined),
}));

import { GET } from '@/src/app/api/live/route';
import { publishLive, resetLiveBus } from '@/src/lib/live/bus';
import { requireCan } from '@/src/lib/users/permissions';

function request(topics: string, abort = new AbortController()): any {
  return {
    nextUrl: { searchParams: new URLSearchParams({ topics }) },
    signal: abort.signal,
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes(needle)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  return seen;
}

beforeEach(() => resetLiveBus());

describe('GET /api/live', () => {
  it('refuses a caller without the capability a topic needs', async () => {
    vi.mocked(requireCan).mockRejectedValueOnce(new Error('forbidden'));
    expect((await GET(request('analytics'))).status).toBe(403);
  });

  it('asks for each topic its own capability', async () => {
    vi.mocked(requireCan).mockClear();
    const abort = new AbortController();
    await GET(request('analytics,waf', abort));
    abort.abort();
    expect(vi.mocked(requireCan).mock.calls.map(([capability]) => capability)).toEqual([
      'analytics:read',
      'security:read',
    ]);
  });

  it('refuses a request for no known topic', async () => {
    expect((await GET(request('users,'))).status).toBe(400);
    expect((await GET(request(''))).status).toBe(400);
  });

  it('streams an invalidate for a topic it was asked for, and only that one', async () => {
    const abort = new AbortController();
    const response = await GET(request('analytics', abort));
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    await readUntil(reader, 'retry: 3000');

    publishLive('waf', 100_000);
    publishLive('analytics', 100_000);
    const seen = await readUntil(reader, 'invalidate');
    expect(seen).toContain('event: invalidate');
    expect(seen).toContain('"topic":"analytics"');
    expect(seen).not.toContain('"topic":"waf"');
    abort.abort();
  });
});
