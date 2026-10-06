/**
 * Only the leader downloads from MaxMind; the other replicas install its downloads from the
 * database. PostgreSQL only, since that is the only backend with other replicas.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));
const { createTestDb } = await import('../../helpers/db');
ctx.db = await createTestDb();
vi.mock('../../../src/lib/db', () => dbModuleMock(() => ctx.db));

import * as schema from '../../../src/lib/db/schema';
const { shareGeoipDatabase, syncGeoipDatabases } = await import('../../../src/lib/geoip/replicas');
const { geoipDatabasePath } = await import('../../../src/lib/agent/geoip');
const { cluster } = await import('../../../src/lib/cluster/state');
const { postgresClient } = await import('../../../src/lib/db/connection');

const bytes = (text: string) => new Uint8Array(Buffer.from(text));

describe.skipIf(postgresClient === null)('GeoIP databases across replicas', () => {
  let dir: string;

  beforeEach(async () => {
    ctx.db = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), 'cpm-geoip-'));
    vi.stubEnv('GEOIP_DIR', dir);
    cluster.started = true;
    cluster.leader = false;
  });

  afterEach(() => {
    cluster.started = false;
    cluster.leader = false;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs the leader's download, and leaves it alone once it matches", async () => {
    await shareGeoipDatabase('GeoLite2-Country', bytes('country v1'));
    await syncGeoipDatabases();
    expect(readFileSync(geoipDatabasePath('GeoLite2-Country'), 'utf8')).toBe('country v1');

    await shareGeoipDatabase('GeoLite2-Country', bytes('country v2'));
    await syncGeoipDatabases();
    expect(readFileSync(geoipDatabasePath('GeoLite2-Country'), 'utf8')).toBe('country v2');
  });

  it('as leader, stores a file it downloaded before it had replicas', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(geoipDatabasePath('GeoLite2-ASN'), 'asn from before');
    await syncGeoipDatabases();
    expect(await ctx.db.select().from(schema.geoipDatabases)).toEqual([]);

    cluster.leader = true;
    await syncGeoipDatabases();
    const [row] = await ctx.db.select().from(schema.geoipDatabases);
    expect(row.edition).toBe('GeoLite2-ASN');
    expect(Buffer.from(row.data).toString()).toBe('asn from before');
  });

  it('prefers the stored copy over a different file on this volume', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(geoipDatabasePath('GeoLite2-City'), 'stale city');
    await shareGeoipDatabase('GeoLite2-City', bytes('current city'));
    cluster.leader = true;
    await syncGeoipDatabases();
    expect(readFileSync(geoipDatabasePath('GeoLite2-City'), 'utf8')).toBe('current city');
  });
});
