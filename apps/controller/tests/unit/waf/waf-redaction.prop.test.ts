/**
 * Property-based: redaction never throws, never leaves a credential-named value behind, and a
 * second pass changes nothing, which is what lets the agent and the controller both run it.
 */
import { describe, expect, it } from 'bun:test';
import {
  isCredentialName,
  redactAuditEntry,
  redactFormEncoded,
  redactQueryString,
  redactWafEventRow,
  WAF_REDACTED,
  type WafEventRow,
} from '@cpm/shared';
import * as fc from 'fast-check';
import { FUZZ_TIMEOUT_MS, fuzz } from '../../helpers/fuzz';

const anyText = fc.string({ unit: 'grapheme', maxLength: 200 });
/** Nothing percent-encoded or `+`, so the name the redactor judges is the one written. */
const paramName = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/);
const paramValue = fc.string({ maxLength: 40 }).filter((v) => !v.includes('&'));
const formParams = fc.array(fc.tuple(paramName, fc.option(paramValue, { nil: undefined })), {
  maxLength: 8,
});
const headerName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,30}$/);
const headerValue = fc.oneof(anyText, fc.array(anyText, { maxLength: 3 }));
const headers = fc.dictionary(headerName, headerValue, { maxKeys: 10 });

const auditEntry = fc.record({
  transaction: fc.record(
    {
      request: fc.record(
        { uri: anyText, headers, body: anyText, args: headers },
        { requiredKeys: [] },
      ),
      response: fc.record({ headers }, { requiredKeys: [] }),
    },
    { requiredKeys: [] },
  ),
  messages: fc.array(
    fc.record(
      {
        message: anyText,
        error_message: anyText,
        data: fc.record({ msg: anyText, data: anyText }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    ),
    { maxLength: 4 },
  ),
});

describe('redactFormEncoded', () => {
  it(
    'keeps every parameter and its name, and replaces exactly the credential-named values',
    () => {
      fc.assert(
        fc.property(formParams, (params) => {
          const encoded = params.map(([n, v]) => (v === undefined ? n : `${n}=${v}`)).join('&');
          const expected = params
            .map(([n, v]) =>
              v === undefined ? n : `${n}=${isCredentialName(n) ? WAF_REDACTED : v}`,
            )
            .join('&');
          expect(redactFormEncoded(encoded)).toBe(expected);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'never throws and is idempotent on any text',
    () => {
      fc.assert(
        fc.property(anyText, (text) => {
          const once = redactFormEncoded(text);
          expect(redactFormEncoded(once)).toBe(once);
          expect(once.split('&').length).toBe(text.split('&').length);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('redactQueryString', () => {
  it(
    'leaves the path alone and is idempotent',
    () => {
      fc.assert(
        fc.property(anyText, (uri) => {
          const once = redactQueryString(uri);
          const query = uri.indexOf('?');
          if (query === -1) expect(once).toBe(uri);
          else expect(once.slice(0, query + 1)).toBe(uri.slice(0, query + 1));
          expect(redactQueryString(once)).toBe(once);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('redactAuditEntry', () => {
  it(
    'never throws and is idempotent on any JSON value',
    () => {
      fc.assert(
        fc.property(fc.jsonValue({ maxDepth: 4 }), (entry) => {
          const once = redactAuditEntry(entry);
          expect(JSON.stringify(redactAuditEntry(once))).toBe(JSON.stringify(once));
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    'leaves no credential-named header value in a request or response',
    () => {
      fc.assert(
        fc.property(auditEntry, (entry) => {
          const redacted = redactAuditEntry(entry);
          for (const part of ['request', 'response'] as const) {
            const section = redacted.transaction[part];
            for (const [name, value] of Object.entries(section?.headers ?? {})) {
              if (!isCredentialName(name)) continue;
              for (const v of Array.isArray(value) ? value : [value]) expect(v).toBe(WAF_REDACTED);
            }
          }
          const uri = entry.transaction.request?.uri;
          if (uri !== undefined) {
            expect(redacted.transaction.request?.uri).toBe(redactQueryString(uri));
          }
          expect(JSON.stringify(redactAuditEntry(redacted))).toBe(JSON.stringify(redacted));
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe('redactWafEventRow', () => {
  const row: fc.Arbitrary<WafEventRow> = fc.record({
    ts: fc.nat(),
    host: anyText,
    client_ip: anyText,
    country_code: fc.option(anyText),
    rule_id: fc.option(fc.nat()),
    rule_message: fc.option(anyText),
    severity: fc.option(anyText),
    raw_data: fc.option(
      fc.oneof(
        anyText,
        fc.json(),
        auditEntry.map((e) => JSON.stringify(e)),
      ),
    ),
    blocked: fc.boolean(),
    method: anyText,
    uri: anyText,
  });

  it(
    'keeps raw_data only when it is an audit entry, and is idempotent',
    () => {
      fc.assert(
        fc.property(row, (event) => {
          const once = redactWafEventRow(event);
          let object = false;
          try {
            const parsed: unknown = event.raw_data === null ? null : JSON.parse(event.raw_data);
            object = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
          } catch {
            // Not JSON.
          }
          expect(once.raw_data === null).toBe(!object);
          expect(redactWafEventRow(once)).toEqual(once);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
