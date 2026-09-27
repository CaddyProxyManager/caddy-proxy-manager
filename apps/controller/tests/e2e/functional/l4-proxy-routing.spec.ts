/**
 * Functional: L4 (TCP/UDP) proxy routing - raw connections and datagrams through Caddy to echo
 * containers. Ports TCP 15432/15433, UDP 15353; upstreams tcp-echo:9000, udp-echo:9001.
 */
import { test, expect } from '@playwright/test';
import { createL4ProxyHost, ensureL4ProxyHost } from '../../helpers/l4-proxy-api';
import { tcpSend, waitForTcpEcho, tcpConnect, udpSend, waitForUdpRoute } from '../../helpers/tcp';

const TCP_PORT = 15432;
const TCP_PORT_2 = 15433;
const UDP_PORT = 15353;

test.describe
  .serial('L4 TCP Proxy Routing', () => {
    test('setup: create TCP proxy host pointing at tcp-echo', async ({ page }) => {
      // Shared with agent.spec.ts, which needs this port and may run first.
      await ensureL4ProxyHost(page, {
        name: 'L4 TCP Echo Test',
        protocol: 'tcp',
        listenAddress: `:${TCP_PORT}`,
        upstream: 'tcp-echo:9000',
      });
      await waitForTcpEcho('127.0.0.1', TCP_PORT);
    });

    test('routes TCP traffic to the upstream echo server', async () => {
      const res = await tcpSend('127.0.0.1', TCP_PORT, 'hello from test\n');
      expect(res.connected).toBe(true);
      expect(res.data).toContain('hello from test');
    });

    test('TCP connection is accepted on the L4 port', async () => {
      const connected = await tcpConnect('127.0.0.1', TCP_PORT);
      expect(connected).toBe(true);
    });

    test('unused TCP port does not echo data back', async () => {
      // Docker accepts the TCP connection at the container level even without a Caddy listener,
      // but no data should be proxied/echoed back since there's no L4 host configured on this port.
      const res = await tcpSend('127.0.0.1', TCP_PORT_2, 'probe', 2000);
      expect(res.data).not.toContain('probe');
    });

    test('disabled TCP proxy host stops proxying data', async ({ page }) => {
      await page.goto('/l4-proxy-hosts');
      const row = page.locator('tr', { hasText: 'L4 TCP Echo Test' });
      await row.getByRole('switch').click();
      await page.waitForTimeout(3_000);

      // Docker still accepts the TCP connection, but Caddy should not proxy/echo data
      const res = await tcpSend('127.0.0.1', TCP_PORT, 'should-not-echo\n', 2000);
      expect(res.data).not.toContain('should-not-echo');

      // Re-enable and wait for the route to actually carry data again - the
      // port keeps accepting connections throughout, so only an echo proves it.
      await row.getByRole('switch').click();
      await waitForTcpEcho('127.0.0.1', TCP_PORT);
    });
  });

test.describe
  .serial('L4 Multiple TCP Hosts', () => {
    test('setup: create second TCP proxy host on different port', async ({ page }) => {
      await createL4ProxyHost(page, {
        name: 'L4 TCP Echo Test 2',
        protocol: 'tcp',
        listenAddress: `:${TCP_PORT_2}`,
        upstream: 'tcp-echo:9000',
      });
      await waitForTcpEcho('127.0.0.1', TCP_PORT_2);
    });

    test('both TCP ports route traffic independently', async () => {
      // Ensure both ports actually proxy (port 1 was toggled off/on earlier).
      await waitForTcpEcho('127.0.0.1', TCP_PORT);
      await waitForTcpEcho('127.0.0.1', TCP_PORT_2);
      const res1 = await tcpSend('127.0.0.1', TCP_PORT, 'port1\n');
      const res2 = await tcpSend('127.0.0.1', TCP_PORT_2, 'port2\n');
      expect(res1.connected).toBe(true);
      expect(res2.connected).toBe(true);
      expect(res1.data).toContain('port1');
      expect(res2.data).toContain('port2');
    });
  });

test.describe
  .serial('L4 UDP Proxy Routing', () => {
    test('setup: create UDP proxy host pointing at udp-echo', async ({ page }) => {
      await createL4ProxyHost(page, {
        name: 'L4 UDP Echo Test',
        protocol: 'udp',
        listenAddress: `:${UDP_PORT}`,
        upstream: 'udp-echo:9001',
      });
      // UDP listeners may take longer to start than TCP - use a longer timeout
      await waitForUdpRoute('127.0.0.1', UDP_PORT, 30_000);
    });

    test('routes UDP datagrams to the upstream echo server', async () => {
      const res = await udpSend('127.0.0.1', UDP_PORT, 'hello udp');
      expect(res.received).toBe(true);
      expect(res.data).toContain('hello udp');
    });

    test('sends multiple UDP datagrams independently', async () => {
      const res1 = await udpSend('127.0.0.1', UDP_PORT, 'datagram-1');
      const res2 = await udpSend('127.0.0.1', UDP_PORT, 'datagram-2');
      expect(res1.received).toBe(true);
      expect(res2.received).toBe(true);
      expect(res1.data).toContain('datagram-1');
      expect(res2.data).toContain('datagram-2');
    });

    test('disabled UDP proxy host stops responding', async ({ page }) => {
      await page.goto('/l4-proxy-hosts');
      const row = page.locator('tr', { hasText: 'L4 UDP Echo Test' });
      await row.getByRole('switch').click();
      await page.waitForTimeout(3_000);

      const res = await udpSend('127.0.0.1', UDP_PORT, 'should-fail', 2000);
      expect(res.received).toBe(false);

      await row.getByRole('switch').click();
      await page.waitForTimeout(2_000);
    });
  });
