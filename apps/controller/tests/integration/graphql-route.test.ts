/**
 * The GraphQL endpoint over HTTP. The agent's signature needs a body clone taken *before* Yoga
 * parses it, which unit tests calling `graphql()` directly never exercised - Caddy never started
 * and ~100 e2e tests failed. Anything depending on the request itself belongs here.
 */
import { describe, it, expect } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => {
  return {
    default: ctx.db,
    sqlite: undefined,
    schema: schemaModule,
    nowIso: () => new Date().toISOString(),
    toIso: (value: string | Date | null | undefined): string | null => {
      if (!value) return null;
      return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
    },
  };
});

vi.mock('../../src/lib/audit', () => ({ logAuditEvent: vi.fn() }));

// A verified agent, so the subscription gets past the door. The signature itself belongs to
// agent/verify; what is under test here is that the body reaches it at all.
vi.mock('../../src/lib/agent/verify', () => ({
  verifyAgentRequest: async (_request: Request, body: string) => {
    // Asserted rather than ignored: an empty body here is exactly the failure this file exists
    // for, and it would otherwise look like a passing test.
    if (typeof body !== 'string' || body.length === 0) {
      return { ok: false, status: 401, error: 'Empty body reached the signature check' };
    }
    return { ok: true, agent: { id: 1, agentId: 'a1', name: 'edge' } };
  },
}));

vi.mock('../../src/lib/agent/desired-state', () => ({
  buildDesiredState: async () => ({
    l4Ports: [],
    caddyModules: [],
    services: { services: { clickhouse: false }, env: {} },
    fleetConfig: { clickhouse: null, analytics: false, geoip: null },
    caddyEnabled: true,
  }),
}));

import { OPTIONS, POST } from '../../src/app/api/graphql/route';
import { AGENT_OPERATIONS } from '@cpm/shared';
import { detach } from '../../src/lib/agent/registry';
import { createApiToken } from '../../src/lib/models/api-tokens';
import { users } from '../../src/lib/db/schema';

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://localhost:3000/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }) as never,
  );
}

describe('the endpoint over HTTP', () => {
  it('gives the agent signature check the body it was sent', async () => {
    const response = await post(
      { query: AGENT_OPERATIONS.events },
      { accept: 'text/event-stream' },
    );

    expect(response.status).toBe(200);

    // Read the opening frames rather than the whole body: a subscription is meant to stay open, so
    // `response.text()` would wait for a stream that never ends.
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let seen = '';
    while (!seen.includes('hello') && !seen.includes('errors')) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value;
    }
    await reader.cancel();
    detach('a1');

    // The bug, named: a clone taken after Yoga read the body fails exactly this way.
    expect(seen).not.toContain('Body is disturbed or locked');
    expect(seen).toContain('hello');
  });

  it('answers an unauthenticated query rather than redirecting it', async () => {
    // proxy.ts has to let this path through: a redirect to /login would hand a GraphQL client an
    // HTML page, and would take the agent protocol down with it.
    const response = await post({ query: '{ proxyHosts { id } }' });

    // A GraphQL error, not an HTML redirect. Which refusal belongs to api-auth; this only checks
    // the endpoint answered in its own protocol.
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('json');
    const payload = (await response.json()) as { errors?: { message: string }[] };
    expect(payload.errors?.length ?? 0).toBeGreaterThan(0);
    expect(payload.errors?.[0]?.message).toMatch(/Unauthorized|Forbidden/);
  });

  it('parses a document sent as an ordinary JSON body', async () => {
    // Guards the plumbing rather than the schema: if the body never reached Yoga this would be a
    // parse error instead of an auth error.
    const response = await post({ query: '{ __typename }' });

    const payload = (await response.json()) as { data?: { __typename: string } };
    expect(payload.data?.__typename).toBe('Query');
  });
});

describe('what the endpoint gives away', () => {
  type Payload = { data?: Record<string, unknown> | null; errors?: { message: string }[] };

  it('refuses introspection to a caller who does not authenticate', async () => {
    const response = await post({ query: '{ __schema { queryType { name } } }' });

    const payload = (await response.json()) as Payload;
    expect(payload.errors?.[0]?.message).toBe('Unauthorized');
    expect(payload.data ?? null).toBeNull();
  });

  it('answers introspection for a caller with a valid API token', async () => {
    const now = new Date().toISOString();
    const [user] = await ctx.db
      .insert(users)
      .values({
        email: 'introspection@example.com',
        name: 'Introspection',
        role: 'viewer',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const { rawToken } = await createApiToken('introspection', user.id);

    const response = await post(
      { query: '{ __schema { queryType { name } } }' },
      { authorization: `Bearer ${rawToken}` },
    );

    const payload = (await response.json()) as {
      data?: { __schema: { queryType: { name: string } } };
    };
    expect(payload.data?.__schema.queryType.name).toBe('Query');
  });

  it('does not suggest real field names in a validation error', async () => {
    // "Did you mean" would name the fields introspection is withholding.
    const response = await post({ query: '{ proxyHots { id } }' });

    const payload = (await response.json()) as Payload;
    expect(payload.errors?.[0]?.message).toContain('Cannot query field');
    expect(JSON.stringify(payload)).not.toContain('Did you mean');
  });

  it('grants no cross-origin access, credentialed or otherwise', async () => {
    const preflight = await OPTIONS(
      new Request('http://localhost:3000/api/graphql', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
      }) as never,
    );
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    const response = await post({ query: '{ __typename }' }, { origin: 'https://evil.example' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
