/**
 * Needs attention's runner: budgets, failures, ordering, the cap, and who sees which item. The
 * providers here are stand-ins; the real ones are covered through their pure helpers.
 */
import { describe, expect, it } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../messages/en.json';
import { collectAttention, visibleTo } from '@/src/lib/attention';
import type { AttentionProvider } from '@/src/lib/attention/providers';
import {
  ATTENTION_CODES,
  ATTENTION_LIMIT,
  type AttentionItem,
  attentionMessageValues,
  sortAttention,
} from '@/src/lib/attention/types';
import type { Access } from '@/src/lib/users/permissions';

function access(role: string, grants: { hosts?: number[]; agents?: number[] } = {}): Access {
  return {
    userId: 1,
    role,
    isAdmin: role === 'admin',
    isOperator: role === 'operator',
    grants: {
      proxyHosts: new Map((grants.hosts ?? []).map((id) => [id, 'view' as const])),
      l4ProxyHosts: new Map(),
      agents: new Map((grants.agents ?? []).map((id) => [id, 'view' as const])),
    },
  };
}

let counter = 0;
function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  counter += 1;
  return {
    id: `item-${counter}`,
    provider: 'traffic',
    code: 'serverErrorShare',
    severity: 'warning',
    values: {},
    href: null,
    at: null,
    scope: {},
    ...overrides,
  };
}

function provider(
  id: AttentionProvider['id'],
  run: AttentionProvider['run'],
  adminOnly = false,
): AttentionProvider {
  return { id, adminOnly, run };
}

describe('collectAttention', () => {
  it('skips a provider past its budget and keeps the rest', async () => {
    const slow = provider('ldap', () => new Promise(() => {}));
    const quick = provider('geoip', async () => ({ items: [item({ id: 'geo' })] }));
    const list = await collectAttention(access('admin'), {
      providers: [slow, quick],
      budgetMs: 20,
    });
    expect(list.items.map((i) => i.id)).toEqual(['geo']);
    expect(list.skipped).toEqual(['ldap']);
  });

  it('treats a failing provider as skipped, not as all clear', async () => {
    const broken = provider('agents', async () => {
      throw new Error('registry gone');
    });
    const list = await collectAttention(access('admin'), { providers: [broken], budgetMs: 50 });
    expect(list).toEqual({ items: [], skipped: ['agents'], truncated: 0 });
  });

  it('notes a provider that answered only in part, but keeps what it found', async () => {
    const partial = provider('certificates', async () => ({
      items: [item({ id: 'cert' })],
      partial: true,
    }));
    const list = await collectAttention(access('admin'), { providers: [partial] });
    expect(list.items.map((i) => i.id)).toEqual(['cert']);
    expect(list.skipped).toEqual(['certificates']);
  });

  it('sorts worst first, newest first within a severity, and caps the list', async () => {
    const many = Array.from({ length: ATTENTION_LIMIT + 5 }, (_, n) =>
      item({ id: `info-${n}`, severity: 'info' }),
    );
    const found = provider('traffic', async () => ({
      items: [
        ...many,
        item({ id: 'old-warning', at: '2026-01-01T00:00:00.000Z' }),
        item({ id: 'new-warning', at: '2026-02-01T00:00:00.000Z' }),
        item({ id: 'critical', severity: 'critical' }),
      ],
    }));
    const list = await collectAttention(access('admin'), { providers: [found] });
    expect(list.items.slice(0, 3).map((i) => i.id)).toEqual([
      'critical',
      'new-warning',
      'old-warning',
    ]);
    expect(list.items).toHaveLength(ATTENTION_LIMIT);
    expect(list.truncated).toBe(8);
  });

  it('gives an operator only what touches their granted hosts and agents', async () => {
    const mixed = provider('agents', async () => ({
      items: [
        item({ id: 'mine', scope: { proxyHosts: [3, 4] } }),
        item({ id: 'theirs', scope: { proxyHosts: [9] } }),
        item({ id: 'my-agent', scope: { agent: 7 } }),
        item({ id: 'fleet', scope: {} }),
      ],
    }));
    const list = await collectAttention(access('operator', { hosts: [4], agents: [7] }), {
      providers: [mixed],
    });
    expect(list.items.map((i) => i.id).sort()).toEqual(['mine', 'my-agent']);
  });

  it('does not run an administrators-only provider for an operator', async () => {
    let ran = false;
    const adminOnly = provider(
      'accounts',
      async () => {
        ran = true;
        return { items: [item()] };
      },
      true,
    );
    const list = await collectAttention(access('operator', { hosts: [1] }), {
      providers: [adminOnly],
    });
    expect(ran).toBe(false);
    expect(list.items).toEqual([]);
  });

  it('gives users and viewers nothing, without asking any provider', async () => {
    let ran = false;
    const any = provider('traffic', async () => {
      ran = true;
      return { items: [item()] };
    });
    for (const role of ['user', 'viewer']) {
      expect((await collectAttention(access(role), { providers: [any] })).items).toEqual([]);
    }
    expect(ran).toBe(false);
  });

  it("narrows to one host's items, from the providers that can name a host", async () => {
    let geoipRan = false;
    const traffic = provider('traffic', async () => ({
      items: [
        item({ id: 'h1', scope: { proxyHosts: [1] } }),
        item({ id: 'h2', scope: { proxyHosts: [2] } }),
      ],
    }));
    const geoip = provider('geoip', async () => {
      geoipRan = true;
      return { items: [item({ id: 'geo' })] };
    });
    const list = await collectAttention(access('admin'), {
      providers: [traffic, geoip],
      proxyHostId: 1,
    });
    expect(list.items.map((i) => i.id)).toEqual(['h1']);
    expect(geoipRan).toBe(false);
  });
});

describe('visibleTo', () => {
  it('shows an administrator everything and a scoped item only to its grant holders', () => {
    const fleet = item({ scope: {} });
    expect(visibleTo(access('admin'), fleet)).toBe(true);
    expect(visibleTo(access('operator', { hosts: [1] }), fleet)).toBe(false);
    expect(
      visibleTo(access('operator', { hosts: [1] }), item({ scope: { proxyHosts: [1] } })),
    ).toBe(true);
  });
});

describe('sortAttention', () => {
  it('keeps the input untouched', () => {
    const input = [item({ severity: 'info' }), item({ severity: 'critical' })];
    const before = input.map((i) => i.id);
    sortAttention(input);
    expect(input.map((i) => i.id)).toEqual(before);
  });
});

describe('the attention catalog', () => {
  const t = createTranslator({ locale: 'en', messages, namespace: 'attention' }) as unknown as (
    key: string,
    values?: Record<string, string | number | Date>,
  ) => string;

  /** One value of every shape a provider sends, so each message renders without a missing one. */
  const SAMPLE: AttentionItem['values'] = {
    name: 'example.com',
    days: 3,
    date: '2026-03-01T00:00:00.000Z',
    error: 'boom',
    scope: 'agent',
    agent: 'edge-1',
    since: '2026-02-01T10:00:00.000Z',
    problem: 'caddyBuild',
    detail: 'go build failed',
    host: 'app.example.com',
    errors: 12,
    share: 0.25,
    from: '2026-02-01T10:00:00.000Z',
    to: '2026-02-01T10:30:00.000Z',
    ongoing: 'yes',
    mitigated: 120,
    ratio: 4.5,
    path: '/wp-login.php',
    outcome: 'waf',
    requests: 80,
    stage: 'bind',
    email: 'sam@example.com',
    until: '2026-02-01T10:15:00.000Z',
    count: 2,
    version: '1.0.0',
  };

  it('has a title and a detail for every code, rendering with the values sent', () => {
    for (const code of ATTENTION_CODES) {
      const values = attentionMessageValues({ values: SAMPLE });
      const title = t(`items.${code}.title`, values);
      const detail = t(`items.${code}.detail`, values);
      expect({ code, ok: title.length > 0 && !title.startsWith('attention.') }).toEqual({
        code,
        ok: true,
      });
      expect(detail.length).toBeGreaterThan(0);
    }
  });

  it('has no item message that no code uses', () => {
    expect(Object.keys(messages.attention.items).sort()).toEqual([...ATTENTION_CODES].sort());
  });

  it('turns the date values into dates and leaves the rest alone', () => {
    const values = attentionMessageValues({
      values: { date: '2026-03-01T00:00:00.000Z', name: '2026-03-01T00:00:00.000Z' },
    });
    expect(values.date).toBeInstanceOf(Date);
    expect(values.name).toBe('2026-03-01T00:00:00.000Z');
  });
});
