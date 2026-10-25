/**
 * Property-based: the guards on addresses the controller is told to talk to, or filter by. The
 * private and metadata ranges are enumerated here from the RFCs, so a miss in `outbound-url.ts`
 * shows up as a generated address it lets through.
 */
import { describe, expect, it } from 'bun:test';
import * as fc from 'fast-check';
import { ipVersion } from '../../../src/lib/http/ip-version';
import {
  isLocalHost,
  isMetadataHost,
  parseOutboundBaseUrl,
} from '../../../src/lib/http/outbound-url';
import { strictId } from '../../../src/lib/http/strict-id';
import { FUZZ_TIMEOUT_MS, fuzz } from '../../helpers/fuzz';

const octet = fc.nat({ max: 255 });
const hex4 = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'),
  minLength: 1,
  maxLength: 4,
});
const two = fc.tuple(octet, octet).map(([c, d]) => `${c}.${d}`);
const three = fc.tuple(octet, two).map(([b, rest]) => `${b}.${rest}`);

const linkLocalV4 = two.map((rest) => `169.254.${rest}`);
/** Loopback, RFC 1918, RFC 6598 and link-local. */
const privateV4 = fc.oneof(
  three.map((rest) => `10.${rest}`),
  three.map((rest) => `127.${rest}`),
  fc.tuple(fc.integer({ min: 16, max: 31 }), two).map(([b, rest]) => `172.${b}.${rest}`),
  two.map((rest) => `192.168.${rest}`),
  linkLocalV4,
  fc.tuple(fc.integer({ min: 64, max: 127 }), two).map(([b, rest]) => `100.${b}.${rest}`),
);
/** Documentation and well-known public blocks, which no private range overlaps. */
const publicV4 = fc
  .tuple(
    fc.constantFrom('8.8', '1.1', '203.0', '198.51', '93.184', '172.15', '172.32', '100.63'),
    two,
  )
  .map(([prefix, rest]) => `${prefix}.${rest}`);
const mappedPrivateV6 = privateV4.map((v4) => `::ffff:${v4}`);
const linkLocalV6 = fc
  .tuple(fc.constantFrom('8', '9', 'a', 'b'), hex4, hex4)
  .map(([n, a, b]) => `fe${n}0:${a}::${b}`);
const uniqueLocalV6 = fc
  .tuple(fc.constantFrom('c', 'd'), hex4, hex4)
  .map(([n, a, b]) => `f${n}00:${a}::${b}`);
const label = fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/);

describe('isLocalHost', () => {
  it(
    'is true for every private, loopback and link-local address, bracketed or mapped',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            privateV4,
            mappedPrivateV6,
            mappedPrivateV6.map((v6) => `[${v6}]`),
            linkLocalV6,
            uniqueLocalV6,
            fc.constant('::1'),
            label,
            label.map((l) => `${l}.localhost`),
          ),
          (host) => {
            expect(isLocalHost(host)).toBe(true);
            expect(isLocalHost(host.toUpperCase())).toBe(true);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'is false for a public address or a dotted name',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            publicV4,
            publicV4.map((v4) => `::ffff:${v4}`),
            fc.tuple(label, label).map(([a, b]) => `${a}.${b}`),
            fc.tuple(hex4, hex4).map(([a, b]) => `2001:db8:${a}::${b}`),
          ),
          (host) => {
            expect(isLocalHost(host)).toBe(false);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('isMetadataHost', () => {
  it(
    'is true for link-local in every spelling the URL parser can produce',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            linkLocalV4,
            linkLocalV4.map((v4) => `::ffff:${v4}`),
            // The URL class writes a mapped address in hex: 169.254 is a9fe.
            fc
              .tuple(octet, octet)
              .map(([c, d]) => `::ffff:a9fe:${((c << 8) | d).toString(16).padStart(4, '0')}`),
            linkLocalV6,
            linkLocalV6.map((v6) => `[${v6}]`),
          ),
          (host) => {
            expect(isMetadataHost(host)).toBe(true);
            expect(isMetadataHost(host.toUpperCase())).toBe(true);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'is false for public addresses and private ones outside link-local',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            publicV4,
            privateV4.filter((v4) => !v4.startsWith('169.254.')),
            uniqueLocalV6.filter((v6) => v6 !== 'fd00:ec2::254'),
            fc.tuple(label, label).map(([a, b]) => `${a}.${b}`),
          ),
          (host) => {
            expect(isMetadataHost(host)).toBe(false);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('parseOutboundBaseUrl', () => {
  it(
    'never throws, and what it accepts is a bare https or local http origin it accepts again',
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.string({ unit: 'grapheme', maxLength: 200 }),
            fc.webUrl({ withQueryParameters: true, withFragments: true }),
            fc.webUrl({ validSchemes: ['http', 'https'] }),
            fc
              .tuple(fc.constantFrom('http', 'https'), fc.oneof(privateV4, publicV4, linkLocalV4))
              .map(([scheme, host]) => `${scheme}://${host}/`),
          ),
          (raw) => {
            const parsed = parseOutboundBaseUrl(raw);
            if (parsed.problem !== undefined) {
              expect(['invalid', 'https', 'metadata']).toContain(parsed.problem);
              return;
            }
            const url = new URL(parsed.url);
            expect(parsed.url.endsWith('/')).toBe(false);
            expect(['http:', 'https:']).toContain(url.protocol);
            expect(url.username + url.password + url.search + url.hash).toBe('');
            expect(isMetadataHost(url.hostname)).toBe(false);
            if (url.protocol === 'http:') expect(isLocalHost(url.hostname)).toBe(true);
            expect(parseOutboundBaseUrl(parsed.url)).toEqual({ url: parsed.url });
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'names the problem: metadata before scheme, scheme before acceptance',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom('http', 'https'),
          fc.oneof(
            linkLocalV4.map((h) => ({ host: h, expected: 'metadata' })),
            publicV4.map((h) => ({ host: h, expected: 'https' })),
            privateV4
              .filter((h) => !h.startsWith('169.254.'))
              .map((h) => ({ host: h, expected: 'ok' })),
          ),
          (scheme, { host, expected }) => {
            const parsed = parseOutboundBaseUrl(`${scheme}://${host}/`);
            if (expected === 'metadata') expect(parsed.problem).toBe('metadata');
            else if (scheme === 'https' || expected === 'ok') {
              expect(parsed).toEqual({ url: `${scheme}://${host}` });
            } else expect(parsed.problem).toBe('https');
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('strictId', () => {
  it(
    'reads every safe integer back, whatever surrounds it',
    () => {
      fc.assert(
        fc.property(
          fc.maxSafeNat(),
          fc.stringMatching(/^[ \t\n]{0,3}$/),
          fc.stringMatching(/^[ \t\n]{0,3}$/),
          (n, before, after) => {
            expect(strictId(`${before}${n}${after}`)).toBe(n);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'returns a number only for a string that is exactly its digits',
    () => {
      fc.assert(
        fc.property(fc.option(fc.string({ unit: 'grapheme', maxLength: 30 })), (value) => {
          const id = strictId(value ?? undefined);
          if (id === undefined) return;
          const trimmed = (value ?? '').trim();
          expect(trimmed).toMatch(/^\d+$/);
          expect(Number(trimmed)).toBe(id);
          expect(Number.isSafeInteger(id)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('ipVersion', () => {
  it(
    'tells the families apart and refuses a zone id',
    () => {
      fc.assert(
        fc.property(fc.ipV4(), fc.ipV6(), label, (v4, v6, zone) => {
          expect(ipVersion(v4)).toBe(4);
          expect(ipVersion(v6)).toBe(6);
          expect(ipVersion(`${v6}%${zone}`)).toBe(0);
          expect(ipVersion(zone)).toBe(0);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
