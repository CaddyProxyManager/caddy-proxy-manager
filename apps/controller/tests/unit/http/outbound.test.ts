/**
 * The outbound client checks the address it connects to, inside the socket's own lookup. Bun's
 * docs do not mention `lookup` on `node:https`, so the first block is what keeps that honest
 * across Bun upgrades: everything else here builds on it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import http from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import {
  checkedLookup,
  OutboundError,
  outboundFetch,
  type ResolvedAddress,
  type Resolver,
  resolveCheckedAddress,
  resolveCheckedAddresses,
} from '@/src/lib/http/outbound';
import { createTestCa, type TestCa } from '../../helpers/certs';

const NAMES: Record<string, string[]> = {
  'hooks.test': ['127.0.0.1'],
  'other.test': ['127.0.0.1'],
  'acme-dns': ['127.0.0.1'],
  'meta.test': ['169.254.169.254'],
  'meta6.test': ['fd00:ec2::254'],
  'mixed.test': ['127.0.0.1', '169.254.169.254'],
  'lan.test': ['10.0.0.5', '192.168.1.20'],
};

const resolver: Resolver = async (hostname) => {
  if (hostname === 'slow.test') return new Promise<ResolvedAddress[]>(() => {});
  const answers = NAMES[hostname];
  if (!answers) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  return answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

let ca: TestCa;
let tlsServer: https.Server;
let tlsPort: number;
let plainServer: http.Server;
let plainPort: number;
let plainConnections = 0;
let silentServer: net.Server;
let silentPort: number;
const sockets = new Set<net.Socket>();

function track(server: net.Server) {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
}

function route(req: http.IncomingMessage, res: http.ServerResponse, scheme: 'http' | 'https') {
  const url = new URL(req.url ?? '/', 'http://x');
  const hops = Number(url.searchParams.get('hops') ?? 0);
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    switch (url.pathname) {
      case '/echo':
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            host: req.headers.host,
            method: req.method,
            body,
            encoding: req.headers['content-encoding'] ?? null,
            auth: req.headers.authorization ?? null,
            custom: req.headers['x-custom'] ?? null,
          }),
        );
        return;
      case '/chain':
        res.statusCode = 302;
        res.setHeader('location', hops > 0 ? `/chain?hops=${hops - 1}` : '/echo');
        res.end();
        return;
      case '/to-metadata':
        res.statusCode = 307;
        res.setHeader('location', url.searchParams.get('target') ?? '');
        res.end();
        return;
      case '/to-http':
        res.statusCode = 308;
        res.setHeader('location', `http://hooks.test:${plainPort}/echo`);
        res.end();
        return;
      case '/see-other':
        res.statusCode = 303;
        res.setHeader(
          'location',
          `${scheme}://other.test:${scheme === 'https' ? tlsPort : plainPort}/echo`,
        );
        res.end();
        return;
      case '/limited':
        res.statusCode = 429;
        res.setHeader('retry-after', '2');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ retry_after: 1.25 }));
        return;
      case '/big':
        res.end('x'.repeat(5000));
        return;
      case '/hang':
        return;
      default:
        res.statusCode = 404;
        res.end();
    }
  });
}

beforeAll(async () => {
  ca = createTestCa();
  const leaf = ca.issue('hooks.test');
  tlsServer = https.createServer(
    { cert: leaf.certificatePem, key: leaf.privateKeyPem },
    (req, res) => route(req, res, 'https'),
  );
  plainServer = http.createServer((req, res) => route(req, res, 'http'));
  plainServer.on('connection', () => {
    plainConnections++;
  });
  // Accepts the TCP connection and never starts TLS.
  silentServer = net.createServer(() => {});
  for (const server of [tlsServer, plainServer, silentServer]) track(server);
  await Promise.all(
    [tlsServer, plainServer, silentServer].map(
      (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
    ),
  );
  tlsPort = (tlsServer.address() as AddressInfo).port;
  plainPort = (plainServer.address() as AddressInfo).port;
  silentPort = (silentServer.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [tlsServer, plainServer, silentServer].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function failure(promise: Promise<unknown>): Promise<OutboundError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OutboundError);
    return error as OutboundError;
  }
  throw new Error('expected the request to fail');
}

function rawGet(
  host: string,
  lookup: net.LookupFunction,
): Promise<{ status?: number; body?: string; error?: string }> {
  return new Promise((resolve) => {
    const request = https.request(
      { host, port: tlsPort, path: '/echo', agent: false, ca: ca.certificatePem, lookup },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on('error', (error) =>
      resolve({ error: (error as NodeJS.ErrnoException).code ?? error.message }),
    );
    request.end();
  });
}

describe('https.request with a custom lookup (the gate)', () => {
  it('connects to the looked-up address and verifies the original name, all form', async () => {
    const forms: unknown[] = [];
    const lookup = checkedLookup(resolver);
    const spy = ((hostname: string, options: { all?: boolean }, callback: never) => {
      forms.push(Boolean(options?.all));
      return (lookup as unknown as (...args: unknown[]) => void)(hostname, options, callback);
    }) as unknown as net.LookupFunction;

    const ok = await rawGet('hooks.test', spy);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body ?? '{}').host).toBe(`hooks.test:${tlsPort}`);

    const wrongName = await rawGet('other.test', spy);
    expect(wrongName.status).toBeUndefined();
    expect(wrongName.error).toMatch(/ALTNAME|CERT/);
    expect(forms.length).toBeGreaterThan(0);
  });

  it('works through the single-address form', async () => {
    const lookup = checkedLookup(resolver) as unknown as (...args: unknown[]) => void;
    // Ask in the single form whatever the runtime asked, and answer in the form it asked for.
    const single = ((
      hostname: string,
      options: { all?: boolean },
      callback: (...args: unknown[]) => void,
    ) => {
      lookup(hostname, { family: 0 }, (error: Error | null, address: string, family: number) => {
        if (error) return callback(error);
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      });
    }) as unknown as net.LookupFunction;
    expect((await rawGet('hooks.test', single)).status).toBe(200);
    expect((await rawGet('other.test', single)).error).toMatch(/ALTNAME|CERT/);
  });

  it('answers both call forms directly, with options or none', async () => {
    const lookup = checkedLookup(resolver) as unknown as (...args: unknown[]) => void;
    const single = await new Promise<unknown[]>((resolve) =>
      lookup('lan.test', {}, (...args: unknown[]) => resolve(args)),
    );
    expect(single).toEqual([null, '10.0.0.5', 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup('lan.test', { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(all).toEqual([
      null,
      [
        { address: '10.0.0.5', family: 4 },
        { address: '192.168.1.20', family: 4 },
      ],
    ]);
    const bare = await new Promise<unknown[]>((resolve) =>
      lookup('hooks.test', (...args: unknown[]) => resolve(args)),
    );
    expect(bare).toEqual([null, '127.0.0.1', 4]);
    const refused = await new Promise<unknown[]>((resolve) =>
      lookup('meta.test', { all: true }, (...args: unknown[]) => resolve(args)),
    );
    expect(refused[0]).toBeInstanceOf(OutboundError);
  });
});

describe('outboundFetch', () => {
  it('sends a JSON POST with custom headers and reads status, headers and body', async () => {
    const response = await outboundFetch(`https://hooks.test:${tlsPort}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      body: JSON.stringify({ hello: 'world' }),
      ca: ca.certificatePem,
      resolve: resolver,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toMatchObject({
      host: `hooks.test:${tlsPort}`,
      method: 'POST',
      body: '{"hello":"world"}',
      custom: 'yes',
    });
  });

  it('sends a compressed body as given', async () => {
    const payload = Bun.gzipSync(new TextEncoder().encode('{"seq":1}\n'));
    const response = await outboundFetch(`http://hooks.test:${plainPort}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' },
      body: payload,
      resolve: resolver,
    });
    const echoed = (await response.json()) as { encoding: string; body: string };
    expect(echoed.encoding).toBe('gzip');
    expect(echoed.body.length).toBeGreaterThan(0);
  });

  it("exposes Retry-After and the body's retry_after on a 429", async () => {
    const response = await outboundFetch(`http://hooks.test:${plainPort}/limited`, {
      method: 'POST',
      resolve: resolver,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(await response.json()).toEqual({ retry_after: 1.25 });
  });

  it.each(['meta.test', 'meta6.test', 'mixed.test'])(
    'refuses %s before any byte is sent',
    async (name) => {
      const before = plainConnections;
      const error = await failure(
        outboundFetch(`http://${name}:${plainPort}/echo`, {
          method: 'POST',
          body: 'x',
          resolve: resolver,
        }),
      );
      expect(error.code).toBe('metadata');
      expect(plainConnections).toBe(before);
    },
  );

  it('refuses a metadata literal without resolving it', async () => {
    const error = await failure(
      outboundFetch('http://169.254.169.254/latest', { resolve: resolver }),
    );
    expect(error.code).toBe('metadata');
  });

  it('follows up to three redirects and refuses a fourth', async () => {
    const three = await outboundFetch(`http://hooks.test:${plainPort}/chain?hops=2`, {
      resolve: resolver,
    });
    expect(three.status).toBe(200);
    const four = await failure(
      outboundFetch(`http://hooks.test:${plainPort}/chain?hops=3`, { resolve: resolver }),
    );
    expect(four.code).toBe('too-many-redirects');
  });

  it('hands back the redirect itself when asked to', async () => {
    const response = await outboundFetch(`http://hooks.test:${plainPort}/chain?hops=0`, {
      redirect: 'manual',
      resolve: resolver,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/echo');
  });

  it.each([
    ['a name resolving to one', () => `http://meta.test:${plainPort}/echo`],
    ['a literal', () => 'http://169.254.169.254/latest/meta-data/'],
    ['a named metadata service', () => 'http://metadata.google.internal/'],
  ])('refuses a redirect to %s', async (_label, target) => {
    const before = plainConnections;
    const error = await failure(
      outboundFetch(
        `http://hooks.test:${plainPort}/to-metadata?target=${encodeURIComponent(target())}`,
        { resolve: resolver },
      ),
    );
    expect(error.code).toBe('metadata');
    expect(plainConnections).toBe(before + 1);
  });

  it('refuses a redirect from https to http', async () => {
    const error = await failure(
      outboundFetch(`https://hooks.test:${tlsPort}/to-http`, {
        ca: ca.certificatePem,
        resolve: resolver,
      }),
    );
    expect(error.code).toBe('insecure-redirect');
  });

  it('turns a POST into a GET on 303 and drops the credential across origins', async () => {
    const response = await outboundFetch(`http://hooks.test:${plainPort}/see-other`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' },
      body: 'payload',
      resolve: resolver,
    });
    expect(await response.json()).toMatchObject({ method: 'GET', body: '', auth: null });
  });

  it('refuses a certificate for another name', async () => {
    const error = await failure(
      outboundFetch(`https://other.test:${tlsPort}/echo`, {
        ca: ca.certificatePem,
        resolve: resolver,
      }),
    );
    expect(error.code).toBe('tls');
  });

  it('times out while connecting: TLS never starts, or the name never resolves', async () => {
    const tls = await failure(
      outboundFetch(`https://hooks.test:${silentPort}/`, {
        connectTimeoutMs: 300,
        ca: ca.certificatePem,
        resolve: resolver,
      }),
    );
    expect(tls.code).toBe('connect-timeout');
    const dns = await failure(
      outboundFetch(`http://slow.test:${plainPort}/`, { connectTimeoutMs: 300, resolve: resolver }),
    );
    expect(dns.code).toBe('connect-timeout');
  });

  it('times out on a server that never answers', async () => {
    const started = Date.now();
    const error = await failure(
      outboundFetch(`http://hooks.test:${plainPort}/hang`, { timeoutMs: 400, resolve: resolver }),
    );
    expect(error.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('caps the answer', async () => {
    const error = await failure(
      outboundFetch(`http://hooks.test:${plainPort}/big`, {
        maxResponseBytes: 1000,
        resolve: resolver,
      }),
    );
    expect(error.code).toBe('too-large');
  });

  it('allows a Compose service name on a private address', async () => {
    const response = await outboundFetch(`http://acme-dns:${plainPort}/echo`, {
      resolve: resolver,
    });
    expect(response.status).toBe(200);
  });

  it('refuses a protocol other than http and https', async () => {
    expect((await failure(outboundFetch('file:///etc/passwd'))).code).toBe('invalid');
  });
});

describe('resolveCheckedAddresses', () => {
  it('allows private ranges and single-label names', async () => {
    expect(await resolveCheckedAddresses('lan.test', resolver)).toEqual([
      { address: '10.0.0.5', family: 4 },
      { address: '192.168.1.20', family: 4 },
    ]);
    expect(await resolveCheckedAddress('acme-dns', resolver)).toEqual({
      address: '127.0.0.1',
      family: 4,
    });
    expect(await resolveCheckedAddress('10.1.2.3', resolver)).toEqual({
      address: '10.1.2.3',
      family: 4,
    });
    expect(await resolveCheckedAddress('[fd00::1]', resolver)).toEqual({
      address: 'fd00::1',
      family: 6,
    });
  });

  it('refuses metadata and link-local answers, and any name with one among its answers', async () => {
    for (const name of [
      'meta.test',
      'meta6.test',
      'mixed.test',
      '169.254.169.254',
      'fe80::1',
      'metadata.goog',
    ]) {
      expect((await failure(resolveCheckedAddresses(name, resolver))).code).toBe('metadata');
    }
  });

  it('reports a name that does not resolve', async () => {
    expect((await failure(resolveCheckedAddress('missing.test', resolver))).code).toBe('network');
  });
});
