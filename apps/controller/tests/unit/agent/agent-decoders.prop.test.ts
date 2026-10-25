/**
 * Property-based: whatever shape an agent sends, a decoder either returns a bounded value or throws
 * AgentDecodeError, and what it returns decodes to itself. Any other exception is a crash the
 * caller would not catch. FUZZ_RUNS raises the count.
 */
import { describe, expect, it } from 'bun:test';
import {
  AGENT_CAPABILITIES,
  AgentDecodeError,
  decodeAgentStatus,
  decodeCaddyAdminResponse,
  decodeCertificateFileListing,
  decodeCertificateFileResults,
  decodeCertificateFileSources,
  decodeCertificateFiles,
  decodeCertificateList,
  decodeCommandResults,
  decodeLogReadResponse,
} from '@cpm/shared';
import * as fc from 'fast-check';
import { FUZZ_TIMEOUT_MS, fuzz } from '../../helpers/fuzz';

function returnsOrRefuses(decode: (value: unknown) => unknown, value: unknown): boolean {
  try {
    decode(value);
    return true;
  } catch (error) {
    return error instanceof AgentDecodeError;
  }
}

const OPERATION_STATES = ['idle', 'pending', 'applying', 'applied', 'failed'] as const;
const BUILD_STATES = ['idle', 'pending', 'building', 'applied', 'failed'] as const;

const short = fc.string({ maxLength: 256 });
const message = fc.string({ maxLength: 4096 });
const isoDate = fc.date({ noInvalidDate: true }).map((d) => d.toISOString());

const operation = (states: readonly string[]) =>
  fc.record(
    {
      state: fc.constantFrom(...states),
      message,
      appliedAt: isoDate,
      triggeredAt: isoDate,
      error: message,
    },
    { requiredKeys: ['state'] },
  );

/** A status an agent of any supported version could send, unknown capabilities included. */
const validStatus = fc.record(
  {
    agentId: short,
    version: short,
    mode: fc.constantFrom('standalone', 'managed'),
    composeProject: short,
    l4Ports: fc.record({
      applied: fc.array(short, { maxLength: 50 }),
      status: operation(OPERATION_STATES),
    }),
    caddyBuild: fc.record({
      applied: fc.oneof(
        fc.constant(null),
        fc.array(fc.string({ maxLength: 1024 }), { maxLength: 50 }),
      ),
      status: operation(BUILD_STATES),
    }),
    services: fc.record({
      applied: fc.oneof(
        fc.constant(null),
        fc.record({ clickhouse: fc.boolean(), crowdsec: fc.boolean() }, { requiredKeys: [] }),
      ),
      status: operation(OPERATION_STATES),
    }),
    analytics: fc.record({ enabled: fc.boolean(), accessLogPresent: fc.boolean() }),
    capabilities: fc.array(fc.oneof(fc.constantFrom(...AGENT_CAPABILITIES), short), {
      maxLength: 64,
    }),
  },
  {
    requiredKeys: [
      'agentId',
      'version',
      'mode',
      'composeProject',
      'l4Ports',
      'caddyBuild',
      'services',
      'analytics',
    ],
  },
);

const STATUS_KEYS = new Set([
  'agentId',
  'version',
  'mode',
  'composeProject',
  'l4Ports',
  'caddyBuild',
  'services',
  'analytics',
  'logAccess',
  'capabilities',
]);

const validResponse = fc.record({
  status: fc.integer({ min: 100, max: 599 }),
  text: fc.string({ maxLength: 2000 }),
  headers: fc.dictionary(short, message, { maxKeys: 128 }),
});

describe('agent decoders under arbitrary input', () => {
  it.each([
    ['decodeAgentStatus', decodeAgentStatus],
    ['decodeCaddyAdminResponse', (v: unknown) => decodeCaddyAdminResponse(v)],
    ['decodeCommandResults', decodeCommandResults],
    ['decodeCertificateFileSources', decodeCertificateFileSources],
    ['decodeCertificateFileResults', decodeCertificateFileResults],
  ])(
    '%s returns or throws AgentDecodeError on any value',
    (_name, decode) => {
      fc.assert(
        fc.property(fc.oneof(fc.anything(), fc.jsonValue()), (value) => {
          expect(returnsOrRefuses(decode, value)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it.each([
    ['decodeCertificateList', decodeCertificateList],
    ['decodeCertificateFiles', decodeCertificateFiles],
    ['decodeLogReadResponse', decodeLogReadResponse],
    ['decodeCertificateFileListing', decodeCertificateFileListing],
  ])(
    '%s returns or throws AgentDecodeError on any text',
    (_name, decode) => {
      fc.assert(
        fc.property(fc.oneof(fc.string({ unit: 'grapheme' }), fc.json()), (text) => {
          expect(returnsOrRefuses(decode as (v: unknown) => unknown, text)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('decodeAgentStatus on a well-formed status', () => {
  it(
    'accepts it, keeps only the capabilities it knows, and is idempotent',
    () => {
      fc.assert(
        fc.property(validStatus, (status) => {
          const decoded = decodeAgentStatus(status);
          for (const capability of decoded.capabilities ?? []) {
            expect(AGENT_CAPABILITIES).toContain(capability);
          }
          expect(decodeAgentStatus(decoded)).toEqual(decoded);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'drops every field it does not know',
    () => {
      fc.assert(
        fc.property(
          validStatus,
          fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue({ maxDepth: 2 })),
          (status, extras) => {
            // The valid fields win, so an extra key can shadow nothing.
            const decoded = decodeAgentStatus({ ...extras, ...status }) as Record<string, unknown>;
            for (const key of Object.keys(decoded)) expect(STATUS_KEYS).toContain(key);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('decodeCaddyAdminResponse on a well-formed response', () => {
  it(
    'is idempotent and keeps every header',
    () => {
      fc.assert(
        fc.property(validResponse, (response) => {
          const decoded = decodeCaddyAdminResponse(response);
          expect(Object.keys(decoded.headers).length).toBe(Object.keys(response.headers).length);
          expect(decodeCaddyAdminResponse(decoded)).toEqual(decoded);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('decodeCommandResults', () => {
  it(
    'answers once per entry carrying a string id and skips the rest, whatever the bodies',
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              fc.anything(),
              fc.record({
                id: fc.string({ maxLength: 300 }),
                ok: fc.anything(),
                response: fc.oneof(fc.anything(), validResponse),
                error: fc.anything(),
                code: fc.anything(),
              }),
            ),
            { maxLength: 256 },
          ),
          (entries) => {
            const expected = entries.filter(
              (entry): entry is { id: string } =>
                !!entry &&
                typeof entry === 'object' &&
                !Array.isArray(entry) &&
                typeof (entry as { id?: unknown }).id === 'string' &&
                (entry as { id: string }).id.length <= 256,
            );
            const decoded = decodeCommandResults(entries);
            expect(decoded.map((r) => r.id)).toEqual(expected.map((e) => e.id));
            for (const result of decoded) {
              expect('malformed' in result || typeof result.ok === 'boolean').toBe(true);
            }
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
