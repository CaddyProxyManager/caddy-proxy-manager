/**
 * The MaxMind endpoint is a third party's, so the request shape and parsing are pinned: Basic auth,
 * one repeated query parameter per edition, and one malformed row must not lose the others.
 */
import { describe, it, expect } from 'bun:test';
import { editionsBehind, fetchGeoipMetadata } from '../../../src/lib/geoip/update-check';

function respond(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('fetchGeoipMetadata', () => {
  it('asks for every edition and authenticates with the account id and licence key', async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get('authorization');
      return new Response(JSON.stringify({ databases: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchGeoipMetadata(['GeoLite2-Country', 'GeoLite2-ASN'], '12345', 'key', fetchImpl);

    expect(seenUrl).toContain('edition_id=GeoLite2-Country');
    expect(seenUrl).toContain('edition_id=GeoLite2-ASN');
    expect(seenAuth as string | null).toBe(`Basic ${Buffer.from('12345:key').toString('base64')}`);
  });

  it('maps each edition to the date MaxMind built it', async () => {
    const fetchImpl = respond({
      databases: [
        { edition_id: 'GeoLite2-Country', date: '2026-09-08', md5: 'abc' },
        { edition_id: 'GeoLite2-ASN', date: '2026-09-05', md5: 'def' },
      ],
    });

    const available = await fetchGeoipMetadata(['GeoLite2-Country'], 'a', 'b', fetchImpl);

    expect(available).toEqual({
      'GeoLite2-Country': '2026-09-08',
      'GeoLite2-ASN': '2026-09-05',
    });
  });

  it('skips a malformed row rather than losing the whole answer', async () => {
    const fetchImpl = respond({
      databases: [
        { edition_id: 'GeoLite2-Country', date: '2026-09-08' },
        { edition_id: 'GeoLite2-ASN' },
        { date: '2026-09-01' },
        null,
      ],
    });

    expect(await fetchGeoipMetadata(['GeoLite2-Country'], 'a', 'b', fetchImpl)).toEqual({
      'GeoLite2-Country': '2026-09-08',
    });
  });

  it('tolerates a response with no databases key at all', async () => {
    expect(await fetchGeoipMetadata(['GeoLite2-Country'], 'a', 'b', respond({}))).toEqual({});
  });

  it('names bad credentials specifically, since that is the common failure', async () => {
    const fetchImpl = respond({ code: 'AUTHORIZATION_INVALID' }, 401);

    await expect(fetchGeoipMetadata(['GeoLite2-Country'], 'a', 'b', fetchImpl)).rejects.toThrow(
      /rejected the account ID or licence key/,
    );
  });

  it('reports any other HTTP status', async () => {
    await expect(
      fetchGeoipMetadata(['GeoLite2-Country'], 'a', 'b', respond({}, 503)),
    ).rejects.toThrow(/HTTP 503/);
  });

  it('does not call out at all when nothing is installed', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;

    expect(await fetchGeoipMetadata([], 'a', 'b', fetchImpl)).toEqual({});
    expect(called).toBe(false);
  });
});

describe('editionsBehind', () => {
  const installed = (edition: string, day: string) => ({
    edition,
    updatedAt: new Date(`${day}T09:00:00Z`),
  });

  it('reports an edition MaxMind built after our copy was written', () => {
    expect(
      editionsBehind({ 'GeoLite2-Country': '2026-09-08' }, [
        installed('GeoLite2-Country', '2026-09-01'),
      ]),
    ).toEqual(['GeoLite2-Country']);
  });

  it('reports nothing when the copy on disk is current', () => {
    expect(
      editionsBehind({ 'GeoLite2-Country': '2026-09-08' }, [
        installed('GeoLite2-Country', '2026-09-08'),
      ]),
    ).toEqual([]);
  });

  it('does not count a database downloaded the same day it was built', () => {
    // The file is written hours after the build stamp; a naive compare calls every download stale.
    expect(
      editionsBehind({ 'GeoLite2-Country': '2026-09-08' }, [
        { edition: 'GeoLite2-Country', updatedAt: new Date('2026-09-08T00:30:00Z') },
      ]),
    ).toEqual([]);
  });

  it('ignores an edition MaxMind said nothing about', () => {
    expect(editionsBehind({}, [installed('GeoLite2-City', '2020-01-01')])).toEqual([]);
  });

  it('ignores an unparseable date rather than reporting a false positive', () => {
    expect(
      editionsBehind({ 'GeoLite2-Country': 'not-a-date' }, [
        installed('GeoLite2-Country', '2020-01-01'),
      ]),
    ).toEqual([]);
  });

  it('reports only the editions that are actually behind', () => {
    expect(
      editionsBehind({ 'GeoLite2-Country': '2026-09-08', 'GeoLite2-ASN': '2026-09-08' }, [
        installed('GeoLite2-Country', '2026-09-01'),
        installed('GeoLite2-ASN', '2026-09-08'),
      ]),
    ).toEqual(['GeoLite2-Country']);
  });
});
