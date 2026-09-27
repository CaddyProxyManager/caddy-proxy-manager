/**
 * Low-level TCP and UDP helpers for L4 proxy functional tests: raw TCP connections and UDP
 * datagrams to Caddy's L4 proxy ports, plus reading the responses.
 */
import net from 'node:net';
import dgram from 'node:dgram';

export interface TcpResponse {
  data: string;
  connected: boolean;
}

/**
 * The default window is generous: the echo backends are amd64 images, and under emulation on arm64
 * they can miss a tighter deadline, surfacing as a "connected but empty echo" failure.
 */
export function tcpSend(
  host: string,
  port: number,
  payload: string,
  timeoutMs = 10_000,
): Promise<TcpResponse> {
  return new Promise((resolve, reject) => {
    let data = '';
    let connected = false;
    const socket = net.createConnection({ host, port }, () => {
      connected = true;
      socket.write(payload);
    });

    socket.setTimeout(timeoutMs);

    socket.on('data', (chunk) => {
      data += chunk.toString();
    });

    socket.on('end', () => {
      resolve({ data, connected });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ data, connected });
    });

    socket.on('error', (err) => {
      if (connected) {
        resolve({ data, connected });
      } else {
        reject(err);
      }
    });
  });
}

/** Test whether a TCP port is accepting connections. */
export function tcpConnect(host: string, port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Poll until a TCP port actually *proxies* data, not merely accepts a socket: Docker's publisher
 * accepts connections whether or not Caddy has a listener behind it, so a socket opens well before
 * a new route is live. Only safe against echo upstreams, which is what the L4 suite proxies to.
 */
export async function waitForTcpEcho(
  host: string,
  port: number,
  probe = 'ready-probe',
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // tcpSend rejects when the socket errors before connecting (ECONNREFUSED while caddy is
      // recreated) - exactly the window this waits through, so keep polling.
      const res = await tcpSend(host, port, `${probe}\n`, 2_000);
      if (res.data.includes(probe)) return;
    } catch {
      /* not accepting connections yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `TCP port ${host}:${port} never echoed a probe within ${timeoutMs}ms (it may not be accepting connections, or Caddy may not be proxying yet)`,
  );
}

// ── UDP helpers ──────────────────────────────────────────────────────────────

export interface UdpResponse {
  data: string;
  received: boolean;
}

/** Send a UDP datagram and wait for a response. */
export function udpSend(
  host: string,
  port: number,
  payload: string,
  timeoutMs = 5_000,
): Promise<UdpResponse> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let received = false;
    let data = '';

    const timer = setTimeout(() => {
      socket.close();
      resolve({ data, received });
    }, timeoutMs);

    socket.on('message', (msg) => {
      received = true;
      data += msg.toString();
      clearTimeout(timer);
      socket.close();
      resolve({ data, received });
    });

    socket.on('error', () => {
      clearTimeout(timer);
      socket.close();
      resolve({ data, received });
    });

    socket.send(payload, port, host);
  });
}

/** Poll until a UDP port responds to a test datagram. */
export async function waitForUdpRoute(
  host: string,
  port: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await udpSend(host, port, 'ping', 2000);
    if (res.received) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`UDP port ${host}:${port} not ready after ${timeoutMs}ms`);
}
