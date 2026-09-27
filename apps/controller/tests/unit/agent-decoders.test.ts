/** What an agent sends is checked, bounded and stripped before the controller acts on it. */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  AgentDecodeError,
  decodeAgentStatus,
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
} from '../../src/lib/agent/registry';

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
    expect(decoded.services.applied).toEqual({ clickhouse: true });
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
  afterEach(() => resetRegistry());

  it('fails a waiter at once on a malformed reply instead of holding it to the timeout', async () => {
    const sent: { id: string }[] = [];
    const { events } = attach({
      agentId: 'a1',
      agentRowId: 1,
      name: 'edge',
      controllerId: 'c',
      controllerName: 'CPM',
      initialState: {} as Parameters<typeof attach>[0]['initialState'],
    });
    const pending = dispatchCaddyAdmin('a1', { path: '/config/', method: 'GET' });
    // next(), not for-await: leaving that loop would close the stream and fail the waiter itself.
    for (let step = await events.next(); !step.done; step = await events.next()) {
      if (step.value.type === 'command') {
        sent.push(step.value.command as { id: string });
        break;
      }
    }
    const started = Date.now();
    settleResults('a1', decodeCommandResults([{ id: sent[0].id, ok: true, response: null }]));
    await expect(pending).rejects.toThrow('Malformed agent reply');
    expect(Date.now() - started).toBeLessThan(1000);
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
