/**
 * A signed request is good once: inside the clock-skew window a replayed subscription POST would
 * attach a second stream and replace the real agent's in the registry.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import {
  AGENT_CLOCK_SKEW_MS,
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  signatureBase,
} from '@cpm/shared';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Out of the factory: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../src/lib/db/schema';
const { encryptSecret } = await import('../../src/lib/secret');
const { verifyAgentRequest, resetReplayCache } = await import('../../src/lib/agent/verify');

const AGENT_ID = 'f'.repeat(32);
const SECRET = 'e'.repeat(64);
const PATH = '/api/graphql';
const BODY = '{"query":"subscription AgentEvents { agentEvents }"}';

function bodyHash(body: string): string {
  return new Bun.CryptoHasher('sha256').update(body).digest('hex');
}

/** Headers as an agent signs them. `nonce: null` signs the way agents before rc.4 did. */
function signedHeaders(
  options: { nonce?: string | null; timestamp?: number } = {},
): Record<string, string> {
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce === undefined ? randomBytes(16).toString('hex') : options.nonce;
  const headers: Record<string, string> = {
    [AGENT_ID_HEADER]: AGENT_ID,
    [AGENT_TIMESTAMP_HEADER]: String(timestamp),
    [AGENT_SIGNATURE_HEADER]: createHmac('sha256', SECRET)
      .update(signatureBase('POST', PATH, timestamp, bodyHash(BODY), nonce ?? undefined))
      .digest('hex'),
  };
  if (nonce !== null) headers[AGENT_NONCE_HEADER] = nonce;
  return headers;
}

/** A fresh request object with these bytes, as a replay arrives. */
function arriving(headers: Record<string, string>): Request {
  return new Request(`http://controller.test${PATH}`, { method: 'POST', headers, body: BODY });
}

beforeEach(async () => {
  resetReplayCache();
  await ctx.db.delete(schema.agents);
  const now = new Date().toISOString();
  await ctx.db.insert(schema.agents).values({
    name: 'edge',
    agentId: AGENT_ID,
    secret: encryptSecret(SECRET),
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
});

describe('replay protection', () => {
  it('accepts a signed request once and refuses the same bytes again', async () => {
    const headers = signedHeaders();
    expect((await verifyAgentRequest(arriving(headers), BODY)).ok).toBe(true);
    expect((await verifyAgentRequest(arriving(headers), BODY)).ok).toBe(false);
  });

  it('accepts two requests signed in the same millisecond with different nonces', async () => {
    const timestamp = Date.now();
    expect((await verifyAgentRequest(arriving(signedHeaders({ timestamp })), BODY)).ok).toBe(true);
    expect((await verifyAgentRequest(arriving(signedHeaders({ timestamp })), BODY)).ok).toBe(true);
  });

  it('still refuses a replay once the window has passed, on the timestamp alone', async () => {
    const timestamp = Date.now();
    const headers = signedHeaders({ timestamp });
    expect((await verifyAgentRequest(arriving(headers), BODY, timestamp)).ok).toBe(true);

    const later = timestamp + AGENT_CLOCK_SKEW_MS + 1;
    expect((await verifyAgentRequest(arriving(headers), BODY, later)).ok).toBe(false);
  });

  it('refuses a replay of a request from an agent that signs without a nonce', async () => {
    // Agents before rc.4. Their replay is byte-identical, so the signature is the nonce.
    const headers = signedHeaders({ nonce: null });
    expect((await verifyAgentRequest(arriving(headers), BODY)).ok).toBe(true);
    expect((await verifyAgentRequest(arriving(headers), BODY)).ok).toBe(false);
  });

  it('cannot be dodged by stripping the nonce, which is under the signature', async () => {
    const headers = signedHeaders();
    delete headers[AGENT_NONCE_HEADER];
    expect((await verifyAgentRequest(arriving(headers), BODY)).ok).toBe(false);
  });

  it('refuses a nonce that is not 32 hex characters', async () => {
    const headers = signedHeaders({ nonce: 'not-a-nonce' });
    expect((await verifyAgentRequest(arriving(headers), BODY)).ok).toBe(false);
  });

  it('gives one request the same verdict however often it is checked', async () => {
    // A GraphQL document naming two agent fields verifies its one request twice.
    const request = arriving(signedHeaders());
    expect((await verifyAgentRequest(request, BODY)).ok).toBe(true);
    expect((await verifyAgentRequest(request, BODY)).ok).toBe(true);
  });
});
