/**
 * An uploaded MaxMind database, the offline path: one the reader opens as the edition it claims is
 * installed and served to agents; anything else is refused before it replaces the file on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_ID_HEADER,
  AGENT_NONCE_HEADER,
  AGENT_SIGNATURE_HEADER,
  AGENT_TIMESTAMP_HEADER,
  signatureBase,
} from '@cpm/shared';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import { createTestDb, type TestDb } from '@/tests/helpers/db';
import { buildMmdb } from '@/tests/helpers/mmdb';
import { nextIntlServerMock } from '@/tests/helpers/next-intl';

const ctx = vi.hoisted(() => ({
  db: null as unknown as TestDb,
  pushes: 0,
  session: { user: { id: '7' } } as { user: { id: string } } | null,
}));

// A Bun mock factory must be synchronous; an async one never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('@/src/lib/db', () => dbModuleMock(() => ctx.db));
// The route words its refusals through next-intl, which needs a request scope.
vi.mock('next-intl/server', () => nextIntlServerMock());
vi.mock('@/src/lib/agent/fleet-config', () => ({
  currentFleetConfig: async () => ({ clickhouse: null, analytics: false, geoip: null }),
  pushFleetConfig: async () => {
    ctx.pushes += 1;
  },
}));

const permissions = await import('@/src/lib/users/permissions');
vi.mock('@/src/lib/users/permissions', () => ({
  ...permissions,
  requireCan: async () => {
    if (!ctx.session) throw new permissions.ForbiddenError();
    return ctx.session;
  },
}));

const schema = await import('@/src/lib/db/schema');
const { encryptSecret } = await import('@/src/lib/secrets');
const { logAuditEvent } = await import('@/src/lib/audit');
const { getGeoipDownloadState } = await import('@/src/lib/geoip/updater');
const { readUploadedDatabase, uploadGeoipDatabase } = await import('@/src/lib/geoip/upload');
const { POST } = await import('@/src/app/api/geoip/upload/route');
const agentRoute = await import('@/src/app/api/agent/geoip/[edition]/route');

const AGENT_ID = 'agent-under-test';
const SECRET = 'c'.repeat(64);
const EDITION = 'GeoLite2-Country';
let dir: string;

function agentRequest(edition: string): Request {
  const path = `/api/agent/geoip/${edition}`;
  const timestamp = Date.now();
  const nonce = randomBytes(16).toString('hex');
  const emptyBody = new Bun.CryptoHasher('sha256').update('').digest('hex');
  return new Request(`http://controller.local${path}`, {
    headers: {
      [AGENT_ID_HEADER]: AGENT_ID,
      [AGENT_TIMESTAMP_HEADER]: String(timestamp),
      [AGENT_NONCE_HEADER]: nonce,
      [AGENT_SIGNATURE_HEADER]: createHmac('sha256', SECRET)
        .update(signatureBase('GET', path, timestamp, emptyBody, nonce))
        .digest('hex'),
    },
  });
}

type AgentGet = (
  request: Request,
  context: { params: Promise<{ edition: string }> },
) => Promise<Response>;

function served(edition: string): Promise<Response> {
  return (agentRoute.GET as unknown as AgentGet)(agentRequest(edition), {
    params: Promise.resolve({ edition }),
  });
}

function uploadRequest(form: FormData, origin = 'http://localhost:3000'): Request {
  return new Request('http://localhost:3000/api/geoip/upload', {
    method: 'POST',
    headers: { Origin: origin, Host: 'localhost:3000' },
    body: form,
  });
}

type Post = (request: Request) => Promise<Response>;
const post = POST as unknown as Post;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cpm-geoip-upload-'));
  process.env.GEOIP_DIR = dir;
  ctx.pushes = 0;
  ctx.session = { user: { id: '7' } };
  vi.mocked(logAuditEvent).mockClear();
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

afterEach(() => {
  delete process.env.GEOIP_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('uploading a GeoIP database', () => {
  it('installs a valid file, records its build, tells the agents and serves it to them', async () => {
    const bytes = buildMmdb({ databaseType: EDITION, buildEpoch: new Date('2026-09-29') });

    expect(await uploadGeoipDatabase(EDITION, bytes, 7)).toEqual({ build: '2026-09-29' });

    expect(new Uint8Array(readFileSync(join(dir, `${EDITION}.mmdb`)))).toEqual(bytes);
    expect((await getGeoipDownloadState()).builds[EDITION]).toBe('2026-09-29');
    expect(ctx.pushes).toBe(1);
    expect(vi.mocked(logAuditEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'geoip_uploaded', userId: 7 }),
    );

    const response = await served(EDITION);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('refuses a corrupt file, and keeps the one already installed', async () => {
    writeFileSync(join(dir, `${EDITION}.mmdb`), 'the database already here');
    const valid = buildMmdb({ databaseType: EDITION });
    // The metadata intact, so only opening it finds the tree pointing nowhere.
    const corrupt = new Uint8Array(valid);
    corrupt.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);

    for (const bytes of [corrupt, new Uint8Array(randomBytes(4096)), valid.subarray(0, 20)]) {
      let refused: unknown = null;
      try {
        await uploadGeoipDatabase(EDITION, bytes, 7);
      } catch (error) {
        refused = error;
      }
      expect((refused as { code?: string } | null)?.code).toBe('geoipUploadInvalid');
    }
    expect(readFileSync(join(dir, `${EDITION}.mmdb`), 'utf-8')).toBe('the database already here');
    expect(ctx.pushes).toBe(0);
  });

  it('refuses another edition than the one it is uploaded as', () => {
    let refused: unknown = null;
    try {
      readUploadedDatabase(EDITION, buildMmdb({ databaseType: 'GeoLite2-City' }));
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({
      code: 'geoipUploadWrongEdition',
      params: { edition: EDITION, type: 'GeoLite2-City' },
    });
    expect(existsSync(join(dir, `${EDITION}.mmdb`))).toBe(false);
  });
});

describe('POST /api/geoip/upload', () => {
  it('takes an edition and a file', async () => {
    const form = new FormData();
    form.set('edition', 'GeoLite2-ASN');
    form.set('file', new Blob([buildMmdb({ databaseType: 'GeoLite2-ASN' })]), 'asn.mmdb');

    const response = await post(uploadRequest(form));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ edition: 'GeoLite2-ASN' });
    expect(existsSync(join(dir, 'GeoLite2-ASN.mmdb'))).toBe(true);
  });

  it('answers 400 for a corrupt file or a missing edition, and 403 without the permission', async () => {
    const corrupt = new FormData();
    corrupt.set('edition', EDITION);
    corrupt.set('file', new Blob(['not a database']), 'x.mmdb');
    const refused = await post(uploadRequest(corrupt));
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain(EDITION);

    const unnamed = new FormData();
    unnamed.set('file', new Blob([buildMmdb({ databaseType: EDITION })]), 'x.mmdb');
    expect((await post(uploadRequest(unnamed))).status).toBe(400);

    ctx.session = null;
    const form = new FormData();
    form.set('edition', EDITION);
    form.set('file', new Blob([buildMmdb({ databaseType: EDITION })]), 'x.mmdb');
    expect((await post(uploadRequest(form))).status).toBe(403);
    expect(existsSync(join(dir, `${EDITION}.mmdb`))).toBe(false);
  });

  it('refuses a request from another origin', async () => {
    const form = new FormData();
    form.set('edition', EDITION);
    form.set('file', new Blob([buildMmdb({ databaseType: EDITION })]), 'x.mmdb');
    expect((await post(uploadRequest(form, 'https://elsewhere.example'))).status).toBe(403);
  });
});
