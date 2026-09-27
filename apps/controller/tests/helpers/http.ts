/**
 * Low-level HTTP helper for functional tests. Sends requests directly to Caddy on port 80 with a
 * custom Host header, bypassing DNS so test domains need not be resolvable.
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function httpGet(
  domain: string,
  path = '/',
  extraHeaders: Record<string, string> = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 80,
        path,
        method: 'GET',
        headers: { Host: domain, ...extraHeaders },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers as HttpResponse['headers'],
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Poll until the route responds with a status other than 502/503/504 - what Caddy returns while a
 * config reload is in flight or the upstream is not wired up yet.
 */
export async function waitForRoute(domain: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(domain);
      lastStatus = res.status;
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) return;
    } catch {
      // Connection refused - Caddy not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Route for "${domain}" not ready after ${timeoutMs}ms (last status: ${lastStatus})`,
  );
}

/** Poll until the route returns `expectedStatus` - a 302 to the portal, for forward auth. */
export async function waitForStatus(
  domain: string,
  expectedStatus: number,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(domain);
      lastStatus = res.status;
      if (res.status === expectedStatus) return;
    } catch {
      // Connection refused - not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Route for "${domain}" did not return ${expectedStatus} after ${timeoutMs}ms (last status: ${lastStatus})`,
  );
}

/**
 * Poll until a route's response body contains a substring. Needed for error-page tests: with the
 * upstream down the status stays 502 either side of the reload, so only the body shows the apply.
 */
export async function waitForBody(
  domain: string,
  substring: string,
  path = '/',
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  let lastBody = '';
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(domain, path);
      lastStatus = res.status;
      lastBody = res.body;
      if (res.body.includes(substring)) return;
    } catch {
      // Connection refused - Caddy not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `Body for "${domain}${path}" never contained "${substring}" within ${timeoutMs}ms ` +
      `(last status: ${lastStatus}, body: ${JSON.stringify(lastBody.slice(0, 200))})`,
  );
}

export interface WsHandshakeResult {
  /** First line of the HTTP response, e.g. "HTTP/1.1 101 Switching Protocols". */
  statusLine: string;
  /** Parsed numeric status code, or 0 if the response had no parseable HTTP status line. */
  statusCode: number;
  headers: Record<string, string>;
  /** Raw response head (everything before the body), latin1-decoded. */
  raw: string;
}

/**
 * A raw WebSocket upgrade handshake over a plain TCP socket, returning the parsed response head. At
 * socket level on purpose: #195's symptom was a corrupt "HTTP/0.9" response with no status line.
 */
export function wsHandshake(
  domain: string,
  path = '/echo',
  extraHeaders: Record<string, string> = {},
): Promise<WsHandshakeResult> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(80, '127.0.0.1');
    let buf = Buffer.alloc(0);

    const finish = () => {
      const idx = buf.indexOf('\r\n\r\n');
      const head = idx === -1 ? buf.toString('latin1') : buf.subarray(0, idx).toString('latin1');
      const lines = head.split('\r\n');
      const statusLine = lines[0] ?? '';
      const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const ci = line.indexOf(':');
        if (ci > 0) headers[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
      }
      socket.destroy();
      resolve({ statusLine, statusCode: match ? parseInt(match[1], 10) : 0, headers, raw: head });
    };

    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `WebSocket handshake to "${domain}${path}" timed out (raw: ${JSON.stringify(buf.toString('latin1').slice(0, 200))})`,
        ),
      );
    }, 10_000);

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${domain}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
          '',
          '',
        ].join('\r\n'),
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.indexOf('\r\n\r\n') !== -1) {
        clearTimeout(timer);
        finish();
      }
    });

    // Server closed without a complete header block - the mangled-response case.
    socket.on('end', () => {
      clearTimeout(timer);
      finish();
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Opens a WebSocket, sends one text frame and returns the text of the first frame back - a 101
 * alone doesn't prove the hijacked connection carries frames.
 */
export function wsEcho(domain: string, path: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(80, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `no echo from "${domain}${path}" (raw: ${JSON.stringify(buf.toString('latin1').slice(0, 200))})`,
        ),
      );
    }, 10_000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    socket.on('connect', () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: ${domain}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });

    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const statusLine = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(statusLine)) return done(() => reject(new Error(statusLine)));
        upgraded = true;
        buf = buf.subarray(end + 4);
        // Client frames must be masked (RFC 6455 5.3); short text frames only.
        const payload = Buffer.from(message);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
        socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
      }
      // Server frames are unmasked; the echo is short enough for a 7-bit length.
      if (buf.length >= 2 && buf.length >= 2 + (buf[1] & 0x7f)) {
        const text = buf.subarray(2, 2 + (buf[1] & 0x7f)).toString('utf8');
        done(() => resolve(text));
      }
    });

    socket.on('error', (err) => done(() => reject(err)));
  });
}

/** Turns off Force HTTPS in the open host dialog, so the spec can talk plain HTTP to the host. */
export async function turnOffForceHttps(page: Page): Promise<void> {
  const toggle = page.getByRole('dialog').getByRole('switch', { name: 'Force HTTPS' });
  await toggle.scrollIntoViewIfNeeded();
  if (await toggle.isChecked()) await toggle.click();
  await expect(toggle).not.toBeChecked();
}

/** Inject hidden form fields into #create-host-form before submitting. */
export async function injectFormFields(page: Page, fields: Record<string, string>): Promise<void> {
  await page.evaluate((f) => {
    const form = document.getElementById('create-host-form');
    if (!form) throw new Error('create-host-form not found');
    for (const [name, value] of Object.entries(f)) {
      const existing = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (existing) {
        existing.value = value;
      } else {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
    }
  }, fields);
}
