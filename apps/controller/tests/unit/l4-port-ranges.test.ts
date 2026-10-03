import { describe, it, expect } from 'bun:test';
import {
  isReservedL4ListenAddress,
  reservedL4Port,
  splitHostPortRange,
  splitL4UpstreamHost,
} from '@/src/lib/caddy-utils';
import { checkL4PortPlan, type L4PortClaim } from '@/src/lib/l4-port-plan';
import { DomainError } from '@/src/lib/domain-error';

describe('splitHostPortRange', () => {
  it('reads a single port as a range of one', () => {
    expect(splitHostPortRange(':5432')).toEqual({ host: '', start: 5432, end: 5432 });
    expect(splitHostPortRange('my-host:5432')).toEqual({ host: 'my-host', start: 5432, end: 5432 });
  });

  it('reads a range in every listen form', () => {
    expect(splitHostPortRange(':5000-5010')).toEqual({ host: '', start: 5000, end: 5010 });
    expect(splitHostPortRange('10.0.0.1:5000-5010')).toEqual({
      host: '10.0.0.1',
      start: 5000,
      end: 5010,
    });
    expect(splitHostPortRange('[2001:db8::1]:5000-5010')).toEqual({
      host: '2001:db8::1',
      start: 5000,
      end: 5010,
    });
    expect(splitHostPortRange(' my-host:1-65535 ')).toEqual({
      host: 'my-host',
      start: 1,
      end: 65535,
    });
  });

  it('refuses a backwards, empty or out-of-range range', () => {
    for (const value of [
      ':5010-5000',
      ':5000-5000',
      ':5000-',
      ':-5000',
      ':0-10',
      ':5000-65536',
      ':5000-5010-5020',
      ':5000-50x',
      '2001:db8::1-5',
      'my-host',
      'my-host-5000',
    ]) {
      expect(splitHostPortRange(value)).toBeNull();
    }
  });
});

describe('reserved ports inside a range', () => {
  it('finds the first reserved port the range covers', () => {
    expect(reservedL4Port({ host: '', start: 2000, end: 3100 }, null)).toBe(2019);
    expect(reservedL4Port({ host: '', start: 9000, end: 9100 }, null)).toBe(9090);
    expect(reservedL4Port({ host: '', start: 5000, end: 5100 }, null)).toBeNull();
  });

  it('counts the metrics port when it is enabled', () => {
    expect(reservedL4Port({ host: '', start: 5000, end: 5100 }, 5050)).toBe(5050);
    expect(isReservedL4ListenAddress(':5000-5100', 5050)).toBe(true);
    expect(isReservedL4ListenAddress(':5000-5100', null)).toBe(false);
    expect(isReservedL4ListenAddress(':400-500', null)).toBe(true);
  });
});

describe('splitL4UpstreamHost', () => {
  it('takes a bare host, an IPv4 address or a bracketed IPv6 one', () => {
    expect(splitL4UpstreamHost('srcds')).toBe('srcds');
    expect(splitL4UpstreamHost('game-1.internal')).toBe('game-1.internal');
    expect(splitL4UpstreamHost('10.0.0.1')).toBe('10.0.0.1');
    expect(splitL4UpstreamHost('[2001:db8::1]')).toBe('2001:db8::1');
  });

  it('refuses anything carrying a port, a placeholder or an unbracketed IPv6 literal', () => {
    for (const value of [
      'srcds:27015',
      '[2001:db8::1]:1',
      '2001:db8::1',
      '{env.X}',
      '',
      '-a',
      'a b',
    ]) {
      expect(splitL4UpstreamHost(value)).toBeNull();
    }
  });
});

function claim(overrides: Partial<L4PortClaim>): L4PortClaim {
  return { id: null, protocol: 'tcp', listenAddress: ':5000', agentIds: [], ...overrides };
}

function codeOf(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof DomainError ? `${error.code} ${JSON.stringify(error.params)}` : 'other';
  }
}

describe('checkL4PortPlan', () => {
  it('lets hosts share a port on the exact same listen address', () => {
    expect(codeOf(() => checkL4PortPlan([claim({})], [claim({ id: 1 })]))).toBeNull();
  });

  it('refuses a range over another listen address on the same port', () => {
    expect(
      codeOf(() => checkL4PortPlan([claim({ listenAddress: ':4990-5010' })], [claim({ id: 1 })])),
    ).toBe('l4ListenPortInUse {"port":5000}');
    expect(
      codeOf(() =>
        checkL4PortPlan(
          [claim({ listenAddress: '0.0.0.0:5005-5020' })],
          [claim({ id: 1, listenAddress: ':5000-5010' })],
        ),
      ),
    ).toBe('l4ListenPortInUse {"port":5005}');
  });

  it('allows what cannot collide: another protocol, distinct addresses, disjoint agents', () => {
    const other = claim({ id: 1, listenAddress: '10.0.0.1:5000-5010', agentIds: [1] });
    for (const mine of [
      claim({ listenAddress: '10.0.0.1:5005', protocol: 'udp', agentIds: [1] }),
      claim({ listenAddress: '10.0.0.2:5005', agentIds: [1] }),
      claim({ listenAddress: '10.0.0.1:5005', agentIds: [2] }),
      claim({ listenAddress: '10.0.0.1:5011-5020', agentIds: [1] }),
    ]) {
      expect(codeOf(() => checkL4PortPlan([mine], [other]))).toBeNull();
    }
    // An unpinned host lands on every agent, and a wildcard on every address.
    expect(codeOf(() => checkL4PortPlan([claim({ listenAddress: ':5005' })], [other]))).toBe(
      'l4ListenPortInUse {"port":5005}',
    );
  });

  it('checks the changed hosts against each other', () => {
    expect(
      codeOf(() =>
        checkL4PortPlan(
          [
            claim({ id: 1, listenAddress: ':5000-5010' }),
            claim({ id: 2, listenAddress: '[::]:5010' }),
          ],
          [],
        ),
      ),
    ).toBe('l4ListenPortInUse {"port":5010}');
  });

  it('leaves an older clash between unchanged hosts alone', () => {
    const others = [
      claim({ id: 1, listenAddress: ':5000' }),
      claim({ id: 2, listenAddress: '0.0.0.0:5000' }),
    ];
    expect(
      codeOf(() => checkL4PortPlan([claim({ id: 3, listenAddress: ':6000' })], others)),
    ).toBeNull();
  });

  it('caps what one agent publishes, counting TCP and UDP apart', () => {
    const others = [
      claim({ id: 1, listenAddress: ':10000-10999' }),
      claim({ id: 2, listenAddress: ':10000-10999', protocol: 'udp' }),
    ];
    expect(codeOf(() => checkL4PortPlan([claim({ listenAddress: ':20000' })], others))).toBe(
      'l4AgentPortLimit {"max":2000}',
    );
    // The same ports again add nothing.
    expect(
      codeOf(() => checkL4PortPlan([claim({ listenAddress: ':10000-10999' })], others)),
    ).toBeNull();
  });

  it('counts per agent: hosts pinned to different agents do not add up', () => {
    const others = [
      claim({ id: 1, listenAddress: ':10000-10999', agentIds: [1] }),
      claim({ id: 2, listenAddress: ':11000-11999', agentIds: [2] }),
    ];
    expect(
      codeOf(() =>
        checkL4PortPlan([claim({ listenAddress: ':20000-20500', agentIds: [3] })], others),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        checkL4PortPlan([claim({ listenAddress: ':20000-20500', agentIds: [1] })], others),
      ),
    ).toBeNull();
    expect(
      codeOf(() =>
        checkL4PortPlan([claim({ listenAddress: ':20000-21000', agentIds: [2] })], others),
      ),
    ).toBe('l4AgentPortLimit {"max":2000}');
    // Unpinned, it lands on both.
    expect(codeOf(() => checkL4PortPlan([claim({ listenAddress: ':20000-21000' })], others))).toBe(
      'l4AgentPortLimit {"max":2000}',
    );
  });
});
