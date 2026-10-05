/**
 * Regression (H5): login throttles were keyed on X-Real-IP, then the last X-Forwarded-For value -
 * headers any client reaching the controller directly can set to anything.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getClientIp } from '@/src/lib/http/client-ip';
import { PEER_ADDRESS_HEADER, installPeerAddressStamp } from '@/src/lib/http/peer-address';

const STAMPED = Symbol.for('cpm.peer-address-stamped');
const TRUSTED = ['127.0.0.0/8', '::1/128', '172.16.0.0/12'];
const originalEmit = Server.prototype.emit;

function setStamped(value: boolean) {
  (globalThis as Record<symbol, unknown>)[STAMPED] = value;
}

afterEach(() => {
  Server.prototype.emit = originalEmit;
  setStamped(false);
});

describe('getClientIp without a stamped peer (vinext dev/start)', () => {
  it('takes the right-most X-Forwarded-For hop and never X-Real-IP', async () => {
    const headers = new Headers({
      'x-real-ip': '6.6.6.6',
      'x-forwarded-for': '6.6.6.6, 203.0.113.9',
    });
    expect(await getClientIp(headers, TRUSTED)).toBe('203.0.113.9');
    expect(await getClientIp(new Headers({ 'x-real-ip': '6.6.6.6' }), TRUSTED)).toBeNull();
    expect(await getClientIp(new Headers({ 'x-forwarded-for': 'garbage' }), TRUSTED)).toBeNull();
  });

  it('ignores a client-sent peer header, since nothing overwrote it', async () => {
    const headers = new Headers({ [PEER_ADDRESS_HEADER]: '198.51.100.1' });
    expect(await getClientIp(headers, TRUSTED)).toBeNull();
  });
});

describe('getClientIp with a stamped peer', () => {
  it('uses an untrusted peer as-is, whatever X-Forwarded-For claims', async () => {
    setStamped(true);
    const headers = new Headers({
      [PEER_ADDRESS_HEADER]: '198.51.100.7',
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '1.2.3.4',
    });
    expect(await getClientIp(headers, TRUSTED)).toBe('198.51.100.7');
  });

  it('walks X-Forwarded-For past trusted hops when the peer is a trusted proxy', async () => {
    setStamped(true);
    const viaCaddy = new Headers({
      [PEER_ADDRESS_HEADER]: '::ffff:172.18.0.5',
      'x-forwarded-for': '6.6.6.6, 203.0.113.9, 172.20.0.2',
    });
    expect(await getClientIp(viaCaddy, TRUSTED)).toBe('203.0.113.9');

    const noHeader = new Headers({ [PEER_ADDRESS_HEADER]: '172.18.0.5' });
    expect(await getClientIp(noHeader, TRUSTED)).toBe('172.18.0.5');
  });

  it('is null when the stamped peer is not an address', async () => {
    setStamped(true);
    expect(await getClientIp(new Headers({ [PEER_ADDRESS_HEADER]: '' }), TRUSTED)).toBeNull();
  });
});

describe('installPeerAddressStamp', () => {
  it('overwrites a forged peer header with the socket address', async () => {
    installPeerAddressStamp(Server);
    const server = createServer((req, res) => {
      res.end(String(req.headers[PEER_ADDRESS_HEADER]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { [PEER_ADDRESS_HEADER]: '6.6.6.6' },
      });
      expect(await response.text()).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    } finally {
      server.close();
    }
  });
});
