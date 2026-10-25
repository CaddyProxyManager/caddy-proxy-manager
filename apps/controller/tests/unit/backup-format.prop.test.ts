/**
 * Property-based: a backup opens to what was sealed, with any passphrase spelling that normalizes
 * the same and any order of header keys, and refuses every single-character change elsewhere.
 * Each open costs a scrypt, so the run count stays small.
 */
import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import { openBackup, sealBackup } from '../../src/lib/backup/format';
import { FUZZ_RUNS, FUZZ_TIMEOUT_MS } from '../helpers/fuzz';

const runs = { numRuns: Math.min(FUZZ_RUNS, 12) };
const timeout = Math.max(FUZZ_TIMEOUT_MS, 180_000);

const passphrase = fc.string({ unit: 'grapheme', minLength: 12, maxLength: 40 });
const row = fc.dictionary(fc.string({ maxLength: 12 }), fc.jsonValue({ maxDepth: 2 }), {
  maxKeys: 6,
});
const payload = fc.record({
  tables: fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.array(row, { maxLength: 4 }),
    {
      maxKeys: 4,
    },
  ),
});

type Split = { magic: string; header: Record<string, unknown>; body: string };

function split(file: Buffer): Split {
  const text = file.toString('utf8');
  const first = text.indexOf('\n');
  const second = text.indexOf('\n', first + 1);
  return {
    magic: text.slice(0, first),
    header: JSON.parse(text.slice(first + 1, second)),
    body: text.slice(second + 1),
  };
}

function join({ magic, header, body }: Split): Buffer {
  return Buffer.from(`${magic}\n${JSON.stringify(header)}\n${body}`, 'utf8');
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

describe('sealBackup and openBackup', () => {
  it(
    'round-trip any payload, counting its rows, under any normalization of the passphrase',
    async () => {
      await fc.assert(
        fc.asyncProperty(payload, passphrase, async (tables, pass) => {
          const file = await sealBackup(tables, pass, { appVersion: '4.0.0' });
          const opened = await openBackup(file, pass.normalize('NFD'));
          expect(JSON.stringify(opened.tables)).toBe(JSON.stringify(tables.tables));
          expect(opened.header.counts).toEqual(
            Object.fromEntries(Object.entries(tables.tables).map(([n, r]) => [n, r.length])),
          );
        }),
        runs,
      );
    },
    timeout,
  );

  it(
    'authenticate the header by its fields, not the order they were written in',
    async () => {
      const pass = 'correct horse battery staple';
      const file = await sealBackup({ tables: { a: [{ id: 1 }], b: [] } }, pass, {
        appVersion: '4.0.0',
      });
      const parts = split(file);
      const keys = Object.keys(parts.header);
      await fc.assert(
        fc.asyncProperty(fc.shuffledSubarray(keys, { minLength: keys.length }), async (order) => {
          const header = Object.fromEntries(order.map((k) => [k, parts.header[k]]));
          const opened = await openBackup(join({ ...parts, header }), pass);
          expect(opened.tables).toEqual({ a: [{ id: 1 }], b: [] });
        }),
        runs,
      );
    },
    timeout,
  );

  it(
    'refuse a header field, a body character or a passphrase that differs',
    async () => {
      const pass = 'correct horse battery staple';
      const file = await sealBackup(
        { tables: { a: [{ id: 1, name: 'x'.repeat(200) }], b: [] } },
        pass,
        { appVersion: '4.0.0' },
      );
      const parts = split(file);
      // Only whole base64 groups: a change to the padding bits of a trailing group decodes alike.
      const groups = Math.floor(parts.body.length / 4) * 4;
      const tampered = fc.oneof(
        fc
          .tuple(fc.nat({ max: groups - 1 }), fc.constantFrom(...BASE64))
          .filter(([at, c]) => parts.body[at] !== c)
          .map(([at, c]) => ({
            file: join({
              ...parts,
              body: `${parts.body.slice(0, at)}${c}${parts.body.slice(at + 1)}`,
            }),
            pass,
          })),
        fc.constantFrom('appVersion', 'createdAt').map((field) => ({
          file: join({ ...parts, header: { ...parts.header, [field]: `${parts.header[field]}!` } }),
          pass,
        })),
        fc.constantFrom('a', 'b', 'c').map((table) => ({
          file: join({
            ...parts,
            header: {
              ...parts.header,
              counts: { ...(parts.header.counts as Record<string, number>), [table]: 7 },
            },
          }),
          pass,
        })),
        fc.string({ unit: 'grapheme', minLength: 1, maxLength: 3 }).map((suffix) => ({
          file,
          pass: pass + suffix,
        })),
      );
      await fc.assert(
        fc.asyncProperty(tampered, async ({ file: broken, pass: attempt }) => {
          await expect(openBackup(broken, attempt)).rejects.toThrow();
        }),
        runs,
      );
    },
    timeout,
  );
});
