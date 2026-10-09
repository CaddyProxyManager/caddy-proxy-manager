import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { logAttentionChanges } from '@/src/lib/attention/server-log';
import type { AttentionItem, AttentionList } from '@/src/lib/attention/types';

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    provider: 'geoip',
    code: 'geoipFailing',
    severity: 'warning',
    values: { error: 'download refused' },
    href: null,
    at: null,
    scope: {},
    ...overrides,
  };
}

const listOf = (...items: AttentionItem[]): AttentionList => ({ items, skipped: [], truncated: 0 });

let lines: string[];
const record = (line: unknown) => {
  lines.push(String(line));
};

beforeEach(() => {
  lines = [];
  spyOn(console, 'log').mockImplementation(record);
  spyOn(console, 'warn').mockImplementation(record);
});

afterEach(() => {
  (console.log as unknown as { mockRestore(): void }).mockRestore();
  (console.warn as unknown as { mockRestore(): void }).mockRestore();
});

describe('logAttentionChanges', () => {
  it('logs every open item in English the first time', () => {
    logAttentionChanges(listOf(item('geoip')), null);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('[attention] warning: ');
    expect(lines[0]).toContain('(geoip)');
    expect(lines[0]).not.toContain('attention.items');
  });

  it('logs an item once, not on every pass', () => {
    const seen = logAttentionChanges(listOf(item('geoip')), null);
    lines = [];
    logAttentionChanges(listOf(item('geoip')), seen);
    expect(lines).toEqual([]);
  });

  it('logs it again when its code changes, and once when it clears', () => {
    const certificate = item('certificate:3', {
      provider: 'certificates',
      code: 'certificateExpiring',
      values: { name: 'example.com', days: 5 },
    });
    let seen = logAttentionChanges(listOf(certificate), null);
    lines = [];
    seen = logAttentionChanges(
      listOf({
        ...certificate,
        code: 'certificateExpired',
        values: { name: 'example.com', date: '2026-10-01' },
      }),
      seen,
    );
    expect(lines).toHaveLength(1);
    lines = [];
    logAttentionChanges(listOf(), seen);
    expect(lines).toEqual(['[attention] cleared: certificateExpired (certificate:3)']);
  });

  it('does not call an item cleared when its provider was skipped', () => {
    const seen = logAttentionChanges(listOf(item('geoip')), null);
    lines = [];
    const next = logAttentionChanges({ items: [], skipped: ['geoip'], truncated: 0 }, seen);
    expect(lines).toEqual([]);
    expect(next.has('geoip')).toBe(true);
  });

  it('marks an acknowledged item', () => {
    logAttentionChanges(listOf(item('geoip')), null, () => true);
    expect(lines[0]).toEndWith('[acknowledged]');
  });
});
