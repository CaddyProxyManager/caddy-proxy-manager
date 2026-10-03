/** L4 proxy host input validation, exercised without a database connection. */
import { describe, it, expect, beforeEach } from 'bun:test';
import { vi } from '@/tests/helpers/vi';
import { dbModuleMock } from '@/tests/helpers/db-module';
import type { TestDb } from '../helpers/db';

const ctx = vi.hoisted(() => ({ db: null as unknown as TestDb }));

const { createTestDb } = await import('../helpers/db');

// Hoisted: an async Bun mock factory never resolves and the file hangs.
ctx.db = await createTestDb();

vi.mock('../../src/lib/db', () => dbModuleMock(() => ctx.db));

vi.mock('../../src/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}));

import { createL4ProxyHost, type L4ProxyHostInput } from '../../src/lib/models/l4-proxy-hosts';
import * as schema from '../../src/lib/db/schema';

// A test user satisfies the FK on ownerUserId.

beforeEach(async () => {
  await ctx.db.delete(schema.l4ProxyHosts);
  await ctx.db.delete(schema.users).catch(() => {});
  await ctx.db.insert(schema.users).values({
    id: 1,
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin',
    provider: 'credentials',
    subject: 'test',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
});

// Through createL4ProxyHost, which calls validateL4Input.

describe('L4 proxy host create validation', () => {
  it('rejects empty name', async () => {
    const input: L4ProxyHostInput = {
      name: '',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow('Name is required');
  });

  it('rejects invalid protocol', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'sctp' as any,
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow("Protocol must be 'tcp' or 'udp'");
  });

  it('rejects empty listen address', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: '',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow('Listen address is required');
  });

  it('rejects listen address without port', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: '10.0.0.1',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/Listen address must be/);
  });

  it('rejects listen address with port 0', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':0',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/Listen address must be/);
  });

  it('rejects listen address with port > 65535', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':99999',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/Listen address must be/);
  });

  it('rejects empty upstreams', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: [],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(
      'At least one upstream must be specified',
    );
  });

  it('rejects upstream without port', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/must be in 'host:port'/);
  });

  it('accepts a bracketed IPv6 listen address', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: '[2001:db8::1]:5432',
      upstreams: ['[2001:db8::2]:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).resolves.toBeDefined();
  });

  it('rejects an unbracketed IPv6 listen address', async () => {
    // Splitting on the last colon would read `:1` as a port and open a listener.
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: '2001:db8::1',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/Listen address must be/);
  });

  it('rejects an unbracketed IPv6 upstream', async () => {
    // Contains a colon but names no port.
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['2001:db8::2'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/must be in 'host:port'/);
  });

  it('rejects brackets around something that is not an IPv6 address', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: '[example.com]:5432',
      upstreams: ['10.0.0.1:5432'],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(/Listen address must be/);
  });

  it('rejects TLS termination with UDP', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'udp',
      listenAddress: ':5353',
      upstreams: ['1.1.1.1:53'],
      tlsTermination: true,
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(
      'TLS termination is only supported with the TCP protocol',
    );
  });

  it('rejects TLS SNI matcher without values', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432'],
      matcherType: 'tls_sni',
      matcherValue: [],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow('Matcher value is required');
  });

  it('rejects HTTP host matcher without values', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':8080',
      upstreams: ['10.0.0.1:8080'],
      matcherType: 'http_host',
      matcherValue: [],
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow('Matcher value is required');
  });

  it('rejects invalid proxy protocol version', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432'],
      proxyProtocolVersion: 'v3' as any,
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow(
      "Proxy protocol version must be 'v1' or 'v2'",
    );
  });

  it('rejects invalid matcher type', async () => {
    const input: L4ProxyHostInput = {
      name: 'Test',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432'],
      matcherType: 'invalid' as any,
    };
    await expect(createL4ProxyHost(input, 1)).rejects.toThrow('Matcher type must be one of');
  });

  it('accepts valid TCP proxy with all options', async () => {
    const input: L4ProxyHostInput = {
      name: 'Full Featured',
      protocol: 'tcp',
      listenAddress: ':993',
      upstreams: ['localhost:143'],
      matcherType: 'tls_sni',
      matcherValue: ['mail.example.com'],
      tlsTermination: true,
      proxyProtocolVersion: 'v1',
      proxyProtocolReceive: true,
      enabled: true,
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result).toBeDefined();
    expect(result.name).toBe('Full Featured');
    expect(result.protocol).toBe('tcp');
    expect(result.listenAddress).toBe(':993');
    expect(result.upstreams).toEqual(['localhost:143']);
    expect(result.matcherType).toBe('tls_sni');
    expect(result.matcherValue).toEqual(['mail.example.com']);
    expect(result.tlsTermination).toBe(true);
    expect(result.proxyProtocolVersion).toBe('v1');
    expect(result.proxyProtocolReceive).toBe(true);
  });

  it('accepts valid UDP proxy', async () => {
    const input: L4ProxyHostInput = {
      name: 'DNS',
      protocol: 'udp',
      listenAddress: ':5353',
      upstreams: ['1.1.1.1:53'],
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result).toBeDefined();
    expect(result.protocol).toBe('udp');
  });

  it('accepts host:port format for listen address', async () => {
    const input: L4ProxyHostInput = {
      name: 'Bound',
      protocol: 'tcp',
      listenAddress: '0.0.0.0:5432',
      upstreams: ['10.0.0.1:5432'],
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result.listenAddress).toBe('0.0.0.0:5432');
  });

  it('accepts none matcher without matcherValue', async () => {
    const input: L4ProxyHostInput = {
      name: 'Catch All',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432'],
      matcherType: 'none',
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result.matcherType).toBe('none');
  });

  it('accepts proxy_protocol matcher without matcherValue', async () => {
    const input: L4ProxyHostInput = {
      name: 'PP Detect',
      protocol: 'tcp',
      listenAddress: ':8443',
      upstreams: ['10.0.0.1:443'],
      matcherType: 'proxy_protocol',
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result.matcherType).toBe('proxy_protocol');
  });

  it('trims whitespace from name and listenAddress', async () => {
    const input: L4ProxyHostInput = {
      name: '  Spacey Name  ',
      protocol: 'tcp',
      listenAddress: '  :5432  ',
      upstreams: ['10.0.0.1:5432'],
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result.name).toBe('Spacey Name');
    expect(result.listenAddress).toBe(':5432');
  });

  it('deduplicates upstreams', async () => {
    const input: L4ProxyHostInput = {
      name: 'Dedup',
      protocol: 'tcp',
      listenAddress: ':5432',
      upstreams: ['10.0.0.1:5432', '10.0.0.1:5432', '10.0.0.2:5432'],
    };
    const result = await createL4ProxyHost(input, 1);
    expect(result.upstreams).toEqual(['10.0.0.1:5432', '10.0.0.2:5432']);
  });
});
