/** Retention through the S3 store against a fake bucket that pages its listing as S3 does. */
import { describe, expect, it } from 'bun:test';
import {
  applyRetention,
  backupObjectName,
  expiredBackups,
} from '../../../src/lib/backup/retention';
import { LIST_PAGE, type S3Like, s3Store } from '../../../src/lib/backup/storage';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T12:00:00Z');

/** A bucket of keys; `list` answers at most `maxKeys`, with a continuation token past that. */
function fakeBucket(keys: string[]) {
  const objects = new Set(keys);
  const listCalls: (string | undefined)[] = [];
  const client = {
    async list(options: { prefix?: string; maxKeys?: number; continuationToken?: string }) {
      listCalls.push(options.continuationToken);
      const all = [...objects].filter((key) => key.startsWith(options.prefix ?? '')).sort();
      const start = options.continuationToken ? Number(options.continuationToken) : 0;
      const size = Math.min(options.maxKeys ?? 1000, LIST_PAGE);
      const page = all.slice(start, start + size);
      const more = start + size < all.length;
      return {
        contents: page.map((key) => ({ key, size: 1, lastModified: new Date(NOW).toISOString() })),
        isTruncated: more,
        nextContinuationToken: more ? String(start + size) : undefined,
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    write: async () => 0,
    file: () => {
      throw new Error('not used');
    },
  } as unknown as S3Like;
  return { client, objects, listCalls };
}

const daily = (days: number, prefix: string) =>
  Array.from({ length: days }, (_, i) => `${prefix}${backupObjectName(NOW - i * DAY)}`);

const config = {
  endpoint: '',
  region: '',
  bucket: 'b',
  accessKeyId: 'k',
  secretAccessKey: 's',
  virtualHostedStyle: false,
};

describe('retention', () => {
  it("deletes only the schedule's own backups, directly under its prefix", async () => {
    const prefix = 'cpm/nightly/';
    const strangers = [
      'cpm/nightly/notes.txt',
      'cpm/nightly/cpm-backup-2020-01-01-00-00-00.cpmbak.partial',
      'cpm/nightly/archive/cpm-backup-2020-01-01-00-00-00.cpmbak',
      'cpm/weekly/cpm-backup-2020-01-01-00-00-00.cpmbak',
      'cpm/nightly-other/cpm-backup-2020-01-01-00-00-00.cpmbak',
      'cpm-backup-2020-01-01-00-00-00.cpmbak',
    ];
    const bucket = fakeBucket([...daily(5, prefix), ...strangers]);
    const store = s3Store(config, { client: bucket.client, check: false });
    const deleted = await applyRetention(store, prefix, { keepLast: 2, keepDays: null }, NOW);
    expect(deleted).toHaveLength(3);
    for (const key of strangers) expect(bucket.objects.has(key)).toBe(true);
    expect(
      [...bucket.objects].filter((key) => key.startsWith(prefix) && key.endsWith('.cpmbak')),
    ).toEqual(expect.arrayContaining(daily(2, prefix)));
  });

  it('honours "last N", "N days", both (whichever keeps more) and neither', () => {
    const prefix = 's/';
    const objects = daily(10, prefix).map((key) => ({ key, size: 1, lastModified: null }));
    expect(expiredBackups(objects, prefix, { keepLast: 3, keepDays: null }, NOW)).toHaveLength(7);
    // Today and the four days before are younger than 4.5 days.
    expect(expiredBackups(objects, prefix, { keepLast: null, keepDays: 4.5 }, NOW)).toHaveLength(5);
    expect(expiredBackups(objects, prefix, { keepLast: 7, keepDays: 2 }, NOW)).toHaveLength(3);
    expect(expiredBackups(objects, prefix, { keepLast: 1, keepDays: 6 }, NOW)).toHaveLength(3);
    expect(expiredBackups(objects, prefix, { keepLast: null, keepDays: null }, NOW)).toEqual([]);
  });

  it('pages past a thousand keys', async () => {
    const prefix = 'big/';
    const bucket = fakeBucket(daily(2500, prefix));
    const store = s3Store(config, { client: bucket.client, check: false });
    expect(await store.list(prefix)).toHaveLength(2500);
    expect(bucket.listCalls).toEqual([undefined, '1000', '2000']);
    const deleted = await applyRetention(store, prefix, { keepLast: 10, keepDays: null }, NOW);
    expect(deleted).toHaveLength(2490);
    expect(bucket.objects.size).toBe(10);
  });
});
