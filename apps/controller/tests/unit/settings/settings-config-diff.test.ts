/** Caddy adapts one way only, so the review is the pushed JSON: ordering and masking matter. */
import { describe, it, expect } from 'bun:test';
import { diffConfigDocuments } from '../../../src/lib/settings/config-diff';

describe('diffConfigDocuments', () => {
  it('reports no change for documents that differ only in key order', () => {
    const a = { apps: { http: { servers: {} } }, admin: { listen: ':2019' } };
    const b = { admin: { listen: ':2019' }, apps: { http: { servers: {} } } };

    const diff = diffConfigDocuments(a, b);

    expect(diff.unchanged).toBe(true);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
  });

  it('shows an appended array entry as an added line', () => {
    const before = { trusted_proxies: { ranges: ['10.0.0.0/8', '172.16.0.0/12'] } };
    const after = { trusted_proxies: { ranges: ['10.0.0.0/8', '172.16.0.0/12', '100.64.0.0/10'] } };

    const diff = diffConfigDocuments(before, after);

    expect(diff.unchanged).toBe(false);
    const added = diff.lines.filter((line) => line.kind === 'added');
    expect(added.some((line) => line.text.includes('100.64.0.0/10'))).toBe(true);
    // The previous last line gains a comma, as in any line diff over JSON - expected, not a bug.
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
  });

  it('pairs a changed scalar as one removal and one addition', () => {
    const diff = diffConfigDocuments(
      { propagation_timeout: '120s' },
      { propagation_timeout: '180s' },
    );

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.lines.find((line) => line.kind === 'removed')?.text).toContain('120s');
    expect(diff.lines.find((line) => line.kind === 'added')?.text).toContain('180s');
  });

  it('masks credentials in rendered lines while showing the change beside them', () => {
    // The ttl edit keeps lines on screen; a token-only change renders nothing (next test).
    const before = { dns: { api_token: 'secret-one', zone: 'example.com', ttl: 60 } };
    const after = { dns: { api_token: 'secret-two', zone: 'example.com', ttl: 120 } };

    const diff = diffConfigDocuments(before, after);
    const rendered = diff.lines.map((line) => line.text).join('\n');

    expect(rendered).not.toContain('secret-one');
    expect(rendered).not.toContain('secret-two');
    expect(rendered).toContain('********');
    expect(rendered).toContain('example.com');
  });

  it('reports a rotated credential as no change, because both sides mask to the same text', () => {
    // The diff shows only that something changed; the settings change list names the credential.
    const diff = diffConfigDocuments({ auth_key: 'old' }, { auth_key: 'new' });

    expect(diff.unchanged).toBe(true);
  });

  it('collapses long unchanged runs into a gap marker', () => {
    const filler = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`key${String(i).padStart(2, '0')}`, i]),
    );
    const diff = diffConfigDocuments({ ...filler, zzz: 1 }, { ...filler, zzz: 2 });

    const gaps = diff.lines.filter((line) => line.kind === 'gap');
    expect(gaps.length).toBeGreaterThan(0);
    expect(diff.lines.length).toBeLessThan(20);
  });

  it('numbers added and context lines against the staged document', () => {
    const diff = diffConfigDocuments({ a: 1 }, { a: 1, b: 2 });
    const numbered = diff.lines.filter((line) => line.kind !== 'removed' && line.kind !== 'gap');

    expect(numbered.every((line) => typeof line.line === 'number')).toBe(true);
    expect(diff.lines.filter((line) => line.kind === 'removed').every((l) => l.line === null)).toBe(
      true,
    );
  });

  it('handles a document going from empty to populated', () => {
    const diff = diffConfigDocuments({}, { apps: { http: {} } });

    expect(diff.unchanged).toBe(false);
    expect(diff.added).toBeGreaterThan(0);
  });
});
