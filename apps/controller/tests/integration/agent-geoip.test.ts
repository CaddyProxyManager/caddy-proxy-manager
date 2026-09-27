/**
 * Every refusal is a 404, not a 401, so nothing learns the route exists, or which agent ids are
 * real, without already holding a secret. Mostly what these tests are about.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import {
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  signatureBase,
} from '@cpm/shared';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');
const schemaModule = await import('../../src/lib/db/schema');

// Hoisted: a Bun mock factory must be synchronous, and an async one hangs the file.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => ({
  default: ctx.db,
  schema: schemaModule,
  nowIso: () => new Date().toISOString(),
  toIso: (value: string | Date | null | undefined): string | null => {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  },
}));

import * as schema from '../../src/lib/db/schema';
const { encryptSecret } = await import('../../src/lib/secret');

const AGENT_ID = 'agent-under-test';
const SECRET = 'a'.repeat(64);
const EDITION = 'GeoLite2-Country';
const PATH = `/api/agent/geoip/${EDITION}`;

let dir: string;
type RouteHandler = (
  request: Request,
  context: { params: Promise<{ edition: string }> },
) => Promise<Response>;
let GET: RouteHandler;

function signedRequest(
  overrides: {
    agentId?: string;
    secret?: string;
    timestamp?: number;
    path?: string;
    etag?: string;
    signed?: boolean;
  } = {},
): Request {
  const path = overrides.path ?? PATH;
  const timestamp = overrides.timestamp ?? Date.now();
  const emptyBody = new Bun.CryptoHasher('sha256').update('').digest('hex');
  const headers: Record<string, string> = {};

  if (overrides.signed !== false) {
    headers[AGENT_ID_HEADER] = overrides.agentId ?? AGENT_ID;
    headers[AGENT_TIMESTAMP_HEADER] = String(timestamp);
    // Two requests signed in the same millisecond would otherwise be refused as a replay.
    const nonce = randomBytes(16).toString('hex');
    headers[AGENT_NONCE_HEADER] = nonce;
    headers[AGENT_SIGNATURE_HEADER] = createHmac('sha256', overrides.secret ?? SECRET)
      .update(signatureBase('GET', path, timestamp, emptyBody, nonce))
      .digest('hex');
  }
  if (overrides.etag) headers['if-none-match'] = overrides.etag;

  return new Request(`http://controller.local${path}`, { headers });
}

function call(request: Request, edition = EDITION): Promise<Response> {
  return GET(request, { params: Promise.resolve({ edition }) });
}

beforeEach(async () => {
  dir = join(tmpdir(), `geoip-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${EDITION}.mmdb`), 'not really an mmdb, but a real file');
  process.env.GEOIP_DIR = dir;

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

  // The handler takes a NextRequest; a plain Request carries everything it reads.
  GET = (await import('../../src/app/api/agent/geoip/[edition]/route'))
    .GET as unknown as RouteHandler;
});

afterEach(() => {
  delete process.env.GEOIP_DIR;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

describe('serving a GeoIP database to an agent', () => {
  it('returns the file to an agent that signed correctly', async () => {
    const response = await call(signedRequest());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('not really an mmdb');
  });

  it('answers 304 when the agent already has this copy', async () => {
    // Without this, every daily check would move tens of megabytes to discover nothing changed.
    const first = await call(signedRequest());
    const etag = first.headers.get('etag') as string;
    expect(etag).toBeTruthy();

    const second = await call(signedRequest({ etag }));
    expect(second.status).toBe(304);
  });

  it('is 404, not 401, to an unsigned caller', async () => {
    const response = await call(signedRequest({ signed: false }));
    expect(response.status).toBe(404);
  });

  it('is 404 to a caller signing with the wrong secret', async () => {
    const response = await call(signedRequest({ secret: 'b'.repeat(64) }));
    expect(response.status).toBe(404);
  });

  it('is 404 for an agent id that was never paired', async () => {
    const response = await call(signedRequest({ agentId: 'someone-else' }));
    expect(response.status).toBe(404);
  });

  it('is 404 once the agent is disabled', async () => {
    await ctx.db.update(schema.agents).set({ enabled: false });
    const response = await call(signedRequest());
    expect(response.status).toBe(404);
  });

  it('refuses a signature lifted from another edition', async () => {
    // The path is in the signed material, so a capture for one database is not a token for another.
    const stolen = signedRequest({ path: '/api/agent/geoip/GeoLite2-ASN' });
    const response = await call(
      new Request(`http://controller.local${PATH}`, { headers: stolen.headers }),
    );
    expect(response.status).toBe(404);
  });

  it('refuses a stale signature', async () => {
    const response = await call(signedRequest({ timestamp: Date.now() - 10 * 60_000 }));
    expect(response.status).toBe(404);
  });

  it('is 404 for an edition that is not a real one', async () => {
    // The name becomes a path on this filesystem, so it is checked before anything else.
    const response = await call(signedRequest({ path: '/api/agent/geoip/x' }), '../../etc/passwd');
    expect(response.status).toBe(404);
  });

  it('is 404 for a real edition this controller does not have', async () => {
    const response = await call(
      signedRequest({ path: '/api/agent/geoip/GeoLite2-City' }),
      'GeoLite2-City',
    );
    expect(response.status).toBe(404);
  });
});

// The suite's beforeEach puts a GeoLite2-Country.mmdb on disk.
const geoip = await import('../../src/lib/agent/geoip');
const registry = await import('../../src/lib/settings/registry');
const { saveSettings, clearStoredSetting } = await import('../../src/lib/settings/resolve');

describe('the GeoIP toggle', () => {
  beforeEach(async () => {
    await clearStoredSetting(registry.geoipEnabled.key);
    await clearStoredSetting(registry.geoipAccountId.key);
    await clearStoredSetting(registry.geoipLicenseKey.key);
  });

  it('infers "on" from the databases being present when nothing is stored', async () => {
    // The upgrade path: never opening Settings must not read as turning GeoIP off.
    await expect(geoip.geoipEnabled()).resolves.toBe(true);
    await expect(geoip.geoipFleetConfig()).resolves.toMatchObject({
      editions: ['GeoLite2-Country'],
    });
  });

  it('infers "on" from a stored subscription before the first download finishes', async () => {
    process.env.GEOIP_DIR = join(tmpdir(), `geoip-empty-${randomBytes(6).toString('hex')}`);
    mkdirSync(process.env.GEOIP_DIR, { recursive: true });
    await saveSettings({
      [registry.geoipAccountId.key]: '123456',
      [registry.geoipLicenseKey.key]: 'a-licence-key',
    });

    await expect(geoip.geoipEnabled()).resolves.toBe(true);
    // An edition it cannot fetch would turn the agent's daily sync into a daily 404.
    await expect(geoip.geoipFleetConfig()).resolves.toBeNull();
  });

  it('stops offering the databases once it is switched off', async () => {
    await saveSettings({ [registry.geoipEnabled.key]: false });

    await expect(geoip.geoipEnabled()).resolves.toBe(false);
    // Deliberately ignored: an agent told about it would keep recording countries.
    expect(geoip.installedGeoipEditions()).toEqual(['GeoLite2-Country']);
    await expect(geoip.geoipFleetConfig()).resolves.toBeNull();
  });

  it('lets a stored value override the inference in both directions', async () => {
    await saveSettings({ [registry.geoipEnabled.key]: true });
    await expect(geoip.geoipEnabled()).resolves.toBe(true);

    await saveSettings({ [registry.geoipEnabled.key]: false });
    await expect(geoip.geoipEnabled()).resolves.toBe(false);
  });
});
