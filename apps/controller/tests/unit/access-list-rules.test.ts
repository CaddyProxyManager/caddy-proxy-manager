import { describe, expect, it } from 'bun:test';
import {
  type AccessListRuntime,
  buildAccessListHandlers,
  normalizeCidr,
  sanitizeIpRules,
} from '../../src/lib/access-list-rules';

const account = { username: 'alice', passwordHash: '$2b$10$hash' };
const list = (over: Partial<AccessListRuntime>): AccessListRuntime => ({
  accounts: [],
  ipRules: [],
  ipDefault: 'deny',
  satisfy: 'all',
  passAuth: false,
  ...over,
});
const handlerNames = (handlers: Record<string, unknown>[]) => handlers.map((h) => h.handler);
type Route = { match?: { client_ip: { ranges: string[] } }[]; handle?: { handler: string }[] };
const routes = (handler: Record<string, unknown>) => handler.routes as Route[];

describe('normalizeCidr', () => {
  it('turns a bare address into a single-address range', () => {
    expect(normalizeCidr('10.0.0.5')).toBe('10.0.0.5/32');
    expect(normalizeCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });

  it('keeps a valid range and refuses the rest', () => {
    expect(normalizeCidr(' 192.168.0.0/16 ')).toBe('192.168.0.0/16');
    expect(normalizeCidr('::/0')).toBe('::/0');
    for (const bad of ['10.0.0.0/', '10.0.0.0/33', '::/129', 'example.com', '10.0.0.0/-1', '']) {
      expect(normalizeCidr(bad)).toBeNull();
    }
  });
});

describe('sanitizeIpRules', () => {
  it('keeps order and names the first bad rule', () => {
    expect(
      sanitizeIpRules([
        { action: 'deny', cidr: '10.0.0.9' },
        { action: 'allow', cidr: '10.0.0.0/8', note: ' office ' },
      ]),
    ).toEqual([
      { action: 'deny', cidr: '10.0.0.9/32', note: null },
      { action: 'allow', cidr: '10.0.0.0/8', note: 'office' },
    ]);
    expect(() => sanitizeIpRules([{ action: 'allow', cidr: 'nope' }])).toThrow();
    expect(() => sanitizeIpRules([{ action: 'maybe', cidr: '10.0.0.1' }])).toThrow();
  });
});

describe('buildAccessListHandlers', () => {
  it('fails closed on an empty list', () => {
    const handlers = buildAccessListHandlers(list({}));
    expect(handlers).toEqual([
      { handler: 'static_response', status_code: 403, body: 'Access denied' },
    ]);
  });

  it('asks for a password, and strips it before the upstream unless told not to', () => {
    expect(handlerNames(buildAccessListHandlers(list({ accounts: [account] })))).toEqual([
      'authentication',
      'headers',
    ]);
    expect(
      handlerNames(buildAccessListHandlers(list({ accounts: [account], passAuth: true }))),
    ).toEqual(['authentication']);
  });

  it('checks IP rules in order, then the default', () => {
    const [subroute] = buildAccessListHandlers(
      list({
        ipRules: [
          { action: 'deny', cidr: '10.0.0.9/32', note: null },
          { action: 'allow', cidr: '10.0.0.0/8', note: null },
          { action: 'deny', cidr: '10.1.0.0/16', note: null },
        ],
      }),
    );
    const [first, shadowed, fallback] = routes(subroute) as (Route & {
      match: { client_ip?: { ranges: string[] }; not?: { client_ip: { ranges: string[] } }[] }[];
    })[];
    expect(first.match[0].client_ip?.ranges).toEqual(['10.0.0.9/32']);
    // A later rule excludes everything above it, which is what makes the first match decide -
    // no route is terminal, since that would end the request instead of the subroute.
    expect(shadowed.match[0].not?.[0].client_ip.ranges).toEqual(['10.0.0.9/32', '10.0.0.0/8']);
    expect(fallback.match[0].not?.[0].client_ip.ranges).toEqual([
      '10.0.0.9/32',
      '10.0.0.0/8',
      '10.1.0.0/16',
    ]);
    expect(JSON.stringify(subroute)).not.toContain('terminal');
  });

  it('with a default of allow, lets unmatched addresses through', () => {
    const [subroute] = buildAccessListHandlers(
      list({
        ipRules: [{ action: 'deny', cidr: '203.0.113.0/24', note: null }],
        ipDefault: 'allow',
      }),
    );
    expect(routes(subroute)).toHaveLength(1);
  });

  it('under all, needs both an allowed address and the password', () => {
    const handlers = buildAccessListHandlers(
      list({ accounts: [account], ipRules: [{ action: 'allow', cidr: '10.0.0.0/8', note: null }] }),
    );
    expect(handlerNames(handlers)).toEqual(['subroute', 'authentication', 'headers']);
  });

  it('under any, lets an allowed address skip the password and asks everyone else', () => {
    const handlers = buildAccessListHandlers(
      list({
        accounts: [account],
        ipRules: [
          { action: 'allow', cidr: '10.0.0.0/8', note: null },
          { action: 'deny', cidr: '203.0.113.0/24', note: null },
        ],
        satisfy: 'any',
      }),
    );
    expect(handlerNames(handlers)).toEqual(['subroute', 'headers']);
    const [deny, fallback] = routes(handlers[0]);
    // Denied under "any" means "prove it with the password", not a flat refusal.
    expect(deny.handle?.[0].handler).toBe('authentication');
    expect(fallback.handle?.[0].handler).toBe('authentication');
  });
});
