import { describe, it, expect } from 'bun:test';
import { vi } from '@/tests/helpers/vi';

const read = vi.hoisted(() => ({
  pages: [] as Array<{ lines: string[]; cursor: string | null; missing?: boolean } | null>,
  requests: [] as Array<{ source: string; cursor: string | null; limit: number }>,
}));

vi.mock('@/src/lib/users/permissions', () => ({
  requireCan: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/src/lib/agent/client', () => ({
  readAgentLog: vi.fn(async (_agent: string, request: (typeof read.requests)[number]) => {
    read.requests.push(request);
    return read.pages.length > 0 ? read.pages.shift()! : { lines: [], cursor: request.cursor };
  }),
}));

import { GET } from '@/src/app/api/logs/stream/route';

function request(query: Record<string, string>, headers: Record<string, string> = {}): any {
  const abort = new AbortController();
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    signal: abort.signal,
    abort,
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

describe('GET /api/logs/stream', () => {
  it('refuses an unknown source', async () => {
    const response = await GET(request({ agent: 'a', source: 'secrets' }));
    expect(response.status).toBe(400);
  });

  it('sends what the agent has, with the cursor as the frame id', async () => {
    read.requests.length = 0;
    read.pages = [{ lines: ['one', 'two'], cursor: '7:42' }];
    const req = request({ agent: 'a', source: 'access' });
    const response = await GET(req);
    const seen = await readUntil(response.body!.getReader(), '"lines"');
    req.abort.abort();
    expect(seen).toContain('id: 7:42');
    expect(seen).toContain('event: lines');
    expect(seen).toContain('"lines":["one","two"]');
  });

  it('resumes from Last-Event-ID instead of starting over', async () => {
    read.requests.length = 0;
    read.pages = [{ lines: [], cursor: '7:99' }];
    const req = request({ agent: 'a', source: 'access' }, { 'last-event-id': '7:50' });
    const response = await GET(req);
    await readUntil(response.body!.getReader(), 'event: lines');
    req.abort.abort();
    expect(read.requests[0]?.cursor).toBe('7:50');
  });

  it('says so when the agent cannot be read', async () => {
    read.pages = [null];
    const req = request({ agent: 'a', source: 'waf' });
    const response = await GET(req);
    const seen = await readUntil(response.body!.getReader(), 'event: problem');
    req.abort.abort();
    expect(seen).toContain('agentCannotRead');
  });
});
