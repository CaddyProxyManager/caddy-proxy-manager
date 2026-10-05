/** Nothing checks error codes against the catalog at build time, so this does. */
import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import messages from '../../messages/en.json';
import { DomainError, domainError } from '@/src/lib/errors/domain-error';

const CODES = messages.errors as Record<string, string>;

/** Every `domainError("...")` literal in the source, found the way a reviewer would. */
function codesUsedInSource(): string[] {
  const roots = ['src/lib/models', 'src/lib', 'src/app'];
  const found = new Set<string>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') visit(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        for (const m of readFileSync(full, 'utf8').matchAll(/domainError\("([A-Za-z0-9_]+)"/g)) {
          found.add(m[1]);
        }
      }
    }
  };
  for (const root of new Set(roots)) {
    try {
      visit(root);
    } catch {
      // A root that does not exist is not a failure; the others still cover the tree.
    }
  }
  return [...found];
}

describe('domain error codes', () => {
  it('every code raised in the source has a message', () => {
    const used = codesUsedInSource();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((code) => !CODES[code])).toEqual([]);
  });

  it('carries the English sentence for callers with no locale', () => {
    const error = domainError('nameRequired');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.message).toBe(CODES.nameRequired);
    expect(error.code).toBe('nameRequired');
  });

  it('is an Error, so existing catch blocks and the REST layer keep working', () => {
    // /api/v1 returns error.message; that contract predates the catalog and must not change.
    expect(domainError('proxyHostNotFound')).toBeInstanceOf(Error);
  });

  it('interpolates params into the English wording', () => {
    const error = domainError('defaultResponseHeaderLineInvalid', { line: 'no colon here' });
    expect(error.message).toBe('Invalid response header line: no colon here');
    expect(error.params).toEqual({ line: 'no colon here' });
  });

  it('leaves braces inside a param value alone', () => {
    // The value is substituted, never re-scanned, so a header line holding `{x}` survives intact.
    const error = domainError('defaultResponseHeaderLineInvalid', { line: '{x}' });
    expect(error.message).toBe('Invalid response header line: {x}');
  });
});
