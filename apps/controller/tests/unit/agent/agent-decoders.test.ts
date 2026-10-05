/** What an agent sends is checked, bounded and stripped before the controller acts on it. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  AgentDecodeError,
  decodeAgentStatus,
  decodeCertificateFileListing,
  decodeCertificateFileResults,
  decodeCertificateFileSources,
  decodeCertificateFiles,
  decodeCertificateList,
  decodeCommandResults,
  decodeLogReadResponse,
} from '@cpm/shared';
import {
  attach,
  dispatchCaddyAdmin,
  resetRegistry,
  settleResults,
} from '../../../src/lib/agent/registry';

const status = {
  agentId: 'a1',
  version: '3.3.0',
  mode: 'managed',
  composeProject: 'cpm',
  l4Ports: { applied: ['5353:5353/udp'], status: { state: 'applied', appliedAt: '2026-09-27' } },
  caddyBuild: { applied: null, status: { state: 'idle' } },
  services: { applied: { clickhouse: true }, status: { state: 'applied' } },
  analytics: { enabled: true, accessLogPresent: true },
  capabilities: ['caddy-validate', 'certificates', 'from-the-future'],
};

const cert = {
  issuerKey: 'acme-v02.api.letsencrypt.org-directory',
  name: 'app.example.com',
  names: ['app.example.com'],
  issuer: "Let's Encrypt",
  notBefore: '2026-09-01T00:00:00Z',
  notAfter: '2026-11-30T00:00:00Z',
  fingerprint: 'ab'.repeat(32),
};

describe('agent status', () => {
  it('passes a well-formed status, keeping only fields and capabilities it knows', () => {
    const decoded = decodeAgentStatus({ ...status, injected: { a: 1 } });
    expect(decoded).not.toHaveProperty('injected');
    expect(decoded.capabilities).toEqual(['caddy-validate', 'certificates']);
    // An older agent knows no crowdsec, which reads as not running rather than as a bad status.
    expect(decoded.services.applied).toEqual({ clickhouse: true, crowdsec: false });
  });

  it('keeps crowdsec from an agent that runs it', () => {
    const decoded = decodeAgentStatus({
      ...status,
      services: { applied: { clickhouse: false, crowdsec: true }, status: { state: 'applied' } },
    });
    expect(decoded.services.applied).toEqual({ clickhouse: false, crowdsec: true });
  });

  it.each([
    ['a missing section', { ...status, l4Ports: undefined }],
    ['a wrong type', { ...status, analytics: { enabled: 'yes', accessLogPresent: true } }],
    ['an unknown state', { ...status, caddyBuild: { applied: null, status: { state: 'x' } } }],
    [
      'an oversized list',
      { ...status, l4Ports: { ...status.l4Ports, applied: Array(5000).fill('1:1') } },
    ],
    ['an oversized string', { ...status, version: 'v'.repeat(10_000) }],
    ['not an object', 'status'],
  ])('refuses %s', (_, value) => {
    expect(() => decodeAgentStatus(value)).toThrow(AgentDecodeError);
  });
});

describe('command results', () => {
  it('refuses anything but a bounded list', () => {
    expect(() => decodeCommandResults({ id: 'x' })).toThrow(AgentDecodeError);
    expect(() => decodeCommandResults(Array(300).fill({ id: 'x' }))).toThrow(AgentDecodeError);
  });

  it('keeps a readable id around a body it cannot read, and drops entries with no id', () => {
    expect(
      decodeCommandResults([
        { id: 'a1:1', ok: true, response: { status: 200, text: '{}', headers: {} } },
        { id: 'a1:2', ok: true, response: { status: 'fine', text: 1 } },
        { id: 'a1:3', ok: false, error: 'nope', code: 'NOT_A_CODE' },
        { id: 42, ok: true },
        null,
      ]),
    ).toEqual([
      { id: 'a1:1', ok: true, response: { status: 200, text: '{}', headers: {} } },
      { id: 'a1:2', malformed: true },
      { id: 'a1:3', malformed: true },
    ]);
  });
});

describe('command replies', () => {
  beforeEach(() => resetRegistry());
  afterEach(() => resetRegistry());

  it('fails a waiter at once on a malformed reply instead of holding it to the timeout', async () => {
    // Its own id: other suites attach 'a1', and the registry is a module singleton.
    const agentId = `decoder-${crypto.randomUUID()}`;
    const { events } = attach({
      agentId,
      agentRowId: 1,
      name: 'edge',
      controllerId: 'c',
      controllerName: 'CPM',
      initialState: {} as Parameters<typeof attach>[0]['initialState'],
    });
    const pending = dispatchCaddyAdmin(agentId, { path: '/config/', method: 'GET' });
    let commandId = '';
    // next(), not for-await: leaving that loop would close the stream and fail the waiter itself.
    for (let step = await events.next(); !step.done; step = await events.next()) {
      if (step.value.type === 'command') {
        commandId = (step.value.command as { id: string }).id;
        break;
      }
    }
    settleResults(agentId, decodeCommandResults([{ id: commandId, ok: true, response: null }]));
    // Against a sentinel, not the wall clock, which a loaded parallel run can blow through.
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5000)),
    ]);
    expect(outcome).toBe('Malformed agent reply');
  });
});

describe('certificate and log replies', () => {
  it('reads a certificate list, and refuses one that is not a list of certificates', () => {
    expect(decodeCertificateList(JSON.stringify([cert]))).toEqual([cert]);
    expect(() => decodeCertificateList(JSON.stringify({ certificates: [cert] }))).toThrow(
      AgentDecodeError,
    );
    expect(() => decodeCertificateList(JSON.stringify([{ ...cert, notAfter: 'soon' }]))).toThrow(
      AgentDecodeError,
    );
    expect(() => decodeCertificateList('not json')).toThrow(AgentDecodeError);
  });

  it('reads certificate files, leaving out a key that was not sent', () => {
    expect(decodeCertificateFiles('{"certificatePem":"PEM"}')).toEqual({ certificatePem: 'PEM' });
    expect(() => decodeCertificateFiles('{"certificatePem":7}')).toThrow(AgentDecodeError);
  });

  it('bounds a log page', () => {
    expect(decodeLogReadResponse('{"lines":["a"],"cursor":null}')).toEqual({
      lines: ['a'],
      cursor: null,
    });
    const tooMany = JSON.stringify({ lines: Array(1001).fill('x'), cursor: null });
    expect(() => decodeLogReadResponse(tooMany)).toThrow(AgentDecodeError);
    expect(() => decodeLogReadResponse('{"lines":"a","cursor":null}')).toThrow(AgentDecodeError);
  });
});

describe('certificates from files', () => {
  const fingerprint = 'a'.repeat(64);

  it('reads results, full or fingerprint-only, and refuses a chain without its key', () => {
    const results = [
      { id: 3, ok: true, fingerprint, certificatePem: 'CERT', keyPem: 'KEY', extra: 1 },
      { id: 4, ok: true, fingerprint },
      { id: 5, ok: false, error: 'key-mismatch' },
    ];
    expect(decodeCertificateFileResults(results)).toEqual([
      { id: 3, ok: true, fingerprint, certificatePem: 'CERT', keyPem: 'KEY' },
      { id: 4, ok: true, fingerprint },
      { id: 5, ok: false, error: 'key-mismatch' },
    ]);
    for (const bad of [
      [{ id: 3, ok: true, fingerprint, certificatePem: 'CERT' }],
      [{ id: 3, ok: true, fingerprint: 'not-hex' }],
      [{ id: -1, ok: true, fingerprint }],
      [{ id: 3, ok: false, error: 'a sentence an agent made up' }],
      [{ id: 3, ok: 'yes' }],
      [{ id: 3, ok: true, fingerprint, certificatePem: 'x'.repeat(1024 * 1024 + 1), keyPem: 'K' }],
      Array.from({ length: 501 }, (_, id) => ({ id, ok: true, fingerprint })),
      { results: [] },
    ]) {
      expect(() => decodeCertificateFileResults(bad)).toThrow(AgentDecodeError);
    }
  });

  it('reads a listing, and refuses a path outside the directory or a key with content', () => {
    const certificate = {
      path: 'live/example.com/fullchain.pem',
      kind: 'certificate' as const,
      names: ['example.com'],
      notAfter: '2026-12-01T00:00:00.000Z',
      fingerprint: 'AB:CD',
    };
    const key = { path: 'live/example.com/privkey.pem', kind: 'key', keyPem: 'never forwarded' };
    expect(decodeCertificateFileListing(JSON.stringify([certificate, key]))).toEqual([
      certificate,
      { path: 'live/example.com/privkey.pem', kind: 'key' },
    ]);
    for (const path of ['../etc/shadow', '/etc/shadow', 'a/../b']) {
      expect(() => decodeCertificateFileListing(JSON.stringify([{ path, kind: 'key' }]))).toThrow(
        AgentDecodeError,
      );
    }
  });

  it('checks the shape of what the controller asks an agent to read', () => {
    const source = { id: 1, certPath: 'a/cert.pem', keyPath: 'a/key.pem' };
    expect(decodeCertificateFileSources([{ ...source, extra: true }])).toEqual([source]);
    expect(() => decodeCertificateFileSources([{ ...source, id: '1' }])).toThrow(AgentDecodeError);
    expect(() => decodeCertificateFileSources({})).toThrow(AgentDecodeError);
  });
});
