/**
 * Errors a background job or a refused plugin stores are said in the reader's language from their
 * codes. The translator here marks what it rendered, so English passed through shows up unmarked.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../messages/en.json';
import { domainError, domainErrorMessage } from '@/src/lib/errors/domain-error';
import { extractErrorMessage } from '@/src/lib/errors/action-error';
import { attentionErrorText } from '@/src/lib/attention/error-text';
import { assertCrsPluginRulesLoadable } from '@/src/lib/waf/crs-plugins/registry';

const english = createTranslator({ locale: 'en', messages });
/** Every rendered message wrapped in brackets: a stand-in for another language. */
const marked = ((key: string, values?: Record<string, unknown>) =>
  `[${(english as unknown as (k: string, v?: unknown) => string)(key, values)}]`) as never;

function refusal(): unknown {
  try {
    assertCrsPluginRulesLoadable(
      ['SecRule ARGS "@rx x" "id:5,phase:1,deny"', 'Include x'],
      9000,
      9100,
    );
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
}

describe('a refused CRS plugin', () => {
  it('keeps its English for the API, each reason after its quoted line', () => {
    const error = refusal() as Error;
    expect(error.message).toContain(
      `"SecRule ARGS "@rx x" "id:5,phase:1,deny"" - ${domainErrorMessage('crsPluginRuleIdOutOfRange', { start: '9000', end: '9100' })}`,
    );
  });

  it("renders every reason from its code in the reader's language", () => {
    const text = extractErrorMessage(marked, refusal(), 'fallback');
    // The sentence, each detail line and each reason all came from the catalog.
    expect(text.startsWith('[The plugin cannot be loaded here')).toBe(true);
    expect(text).toContain('[a rule id is outside');
    expect(text).toContain('[not a directive a plugin may use');
    expect(text).toContain('["Include x" - [');
  });
});

describe('attention errors', () => {
  it('render a stored code, and fall back to the English without one', () => {
    const coded = domainError('applyCaddyConfigFailed');
    expect(
      attentionErrorText(marked, [
        { message: coded.message, code: { code: coded.code, params: {} } },
      ]),
    ).toBe(`[${coded.message}]`);
    expect(attentionErrorText(marked, [{ message: 'connect ECONNREFUSED', code: null }])).toBe(
      'connect ECONNREFUSED',
    );
  });

  it('name the GeoIP edition each failure is about', () => {
    const text = attentionErrorText(marked, [
      { message: 'HTTP 401', code: null, edition: 'GeoLite2-City' },
    ]);
    expect(text).toBe('[GeoLite2-City: HTTP 401]');
  });
});

describe('domainErrorMessage plurals', () => {
  it('renders the ICU plural forms the catalog uses, in English', () => {
    expect(
      domainErrorMessage('wafDirectivesInvalid', { count: 1, details: ['line 1: x'] }),
    ).toContain('has 1 problem Coraza');
    expect(
      domainErrorMessage('wafDirectivesInvalid', { count: 3, details: ['a', 'b', 'c'] }),
    ).toContain('has 3 problems Coraza');
    // What the real formatter would also say, so a translator can use either form.
    expect(domainErrorMessage('crsPluginRejected', { count: 1, details: ['x'] })).toContain(
      '1 directive is refused',
    );
    expect(domainErrorMessage('crsPluginRejected', { count: 2, details: ['x'] })).toContain(
      '2 directives are refused',
    );
  });
});
