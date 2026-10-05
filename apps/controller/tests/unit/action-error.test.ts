/**
 * The params case guards a real miss: DomainError.params were dropped, which would render
 * placeholders raw, and no code took params yet to catch it.
 */
import { describe, expect, it } from 'bun:test';
import { actionError, extractErrorMessage } from '@/src/lib/errors/action-error';
import { DomainError, domainError } from '@/src/lib/errors/domain-error';

/** Resolves nothing; records what it was handed. */
function translator(seen?: { key?: string; values?: Record<string, string | number> }) {
  const t = (key: string, values?: Record<string, string | number>) => {
    if (seen) {
      seen.key = key;
      seen.values = values;
    }
    return `translated:${key}${values ? `:${JSON.stringify(values)}` : ''}`;
  };
  return t as unknown as Parameters<typeof extractErrorMessage>[0];
}

describe('extractErrorMessage', () => {
  it('translates a DomainError by its code', () => {
    const seen: { key?: string } = {};
    const message = extractErrorMessage(translator(seen), domainError('nameRequired'), 'fallback');
    expect(seen.key).toBe('errors.nameRequired');
    expect(message).toContain('errors.nameRequired');
  });

  it('passes the error params through to the translator', () => {
    const seen: { values?: Record<string, string | number> } = {};
    const error = new DomainError('nameRequired', { count: 3, name: 'x' }, 'English');
    extractErrorMessage(translator(seen), error, 'fallback');
    expect(seen.values).toEqual({ count: 3, name: 'x' });
  });

  it('list-formats a list param with the formatter it is given', () => {
    const seen: { values?: Record<string, string | number> } = {};
    const error = domainError('caCertificateInUse', { names: ['a', 'b', 'c'] });
    const format = {
      list: (value: Iterable<string>) => [...value].join(' / '),
    } as unknown as NonNullable<Parameters<typeof extractErrorMessage>[3]>;
    extractErrorMessage(translator(seen), error, 'fallback', format);
    expect(seen.values).toEqual({ names: 'a / b / c' });
  });

  it('joins a list param as the English does when no formatter is given', () => {
    const seen: { values?: Record<string, string | number> } = {};
    const error = domainError('caCertificateInUse', { names: ['a', 'b'] });
    extractErrorMessage(translator(seen), error, 'fallback');
    expect(seen.values).toEqual({ names: 'a, b' });
  });

  it('keeps the English sentence on an ordinary Error, which carries no code', () => {
    expect(extractErrorMessage(translator(), new Error('Upstream refused'), 'fallback')).toBe(
      'Upstream refused',
    );
  });

  it("falls back to the caller's wording for something that is not an Error", () => {
    expect(extractErrorMessage(translator(), 'not an error', 'fallback')).toBe('fallback');
  });
});

describe('actionError', () => {
  it('reports the message as a failed action state', () => {
    const state = actionError(translator(), new Error('Boom'), 'fallback');
    expect(state).toEqual({ status: 'error', message: 'Boom' });
  });
});
