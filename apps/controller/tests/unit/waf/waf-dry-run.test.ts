/**
 * src/lib/waf/dry-run.ts, with the agent's `caddy validate` replaced at its seam. The refusal
 * below is verbatim from the Caddy image validating a document this module built.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { DomainError } from '../../../src/lib/errors/domain-error';
import {
  type CaddyValidator,
  assertWafLoads,
  buildValidationDocument,
  dryRunWaf,
  parseValidationRefusal,
  setCaddyValidator,
} from '../../../src/lib/waf/dry-run';

const REFUSAL = [
  '{"level":"info","ts":1790231564.387018,"logger":"http","msg":"servers shutting down with eternal grace period"}',
  'Error: loading http app module: provision http: server candidate_1: setting up route handlers: route 0: loading handler modules: position 0: loading module \'waf\': provision http.handlers.waf: invalid WAF config from string: failed to compile the directive "secaction": duplicated rule id 942100',
].join('\n');

const on = (custom_directives: string) => ({
  enabled: true,
  mode: 'On' as const,
  load_owasp_crs: true,
  custom_directives,
});

let restore: CaddyValidator | null = null;
function answer(fn: CaddyValidator): string[] {
  const seen: string[] = [];
  restore = setCaddyValidator(async (config) => {
    seen.push(config);
    return fn(config);
  });
  return seen;
}

afterEach(() => {
  if (restore) setCaddyValidator(restore);
  restore = null;
});

describe('buildValidationDocument', () => {
  it('gives each handler a server of its own, with nothing else to provision', () => {
    const doc = JSON.parse(buildValidationDocument([{ handler: 'waf' }, { handler: 'waf', x: 1 }]));
    expect(doc.admin).toEqual({ disabled: true });
    expect(Object.keys(doc.apps)).toEqual(['http']);
    expect(doc.apps.http.servers.candidate_1).toEqual({
      listen: ['127.0.0.1:20001'],
      automatic_https: { disable: true },
      routes: [{ handle: [{ handler: 'waf', x: 1 }] }],
    });
  });
});

describe('parseValidationRefusal', () => {
  it('names the candidate and keeps only what Coraza said', () => {
    expect(parseValidationRefusal(REFUSAL)).toEqual({
      index: 1,
      detail:
        'invalid WAF config from string: failed to compile the directive "secaction": duplicated rule id 942100',
    });
  });

  it("is null for a refusal that is not the WAF's", () => {
    expect(
      parseValidationRefusal('Error: loading http app module: unknown module: http.handlers.nope'),
    ).toBeNull();
  });

  it('caps a long reason and drops control characters', () => {
    const parsed = parseValidationRefusal(
      `Error: provision http.handlers.waf: \u0007${'x'.repeat(600)}`,
    );
    expect(parsed?.detail.startsWith('x')).toBe(true);
    expect(parsed?.detail.length).toBe(403);
  });
});

describe('dryRunWaf', () => {
  it('compiles nothing for WAFs that emit no handler, and asks nobody', async () => {
    const seen = answer(async () => ({ status: 200, text: '' }));
    const outcome = await dryRunWaf(
      [
        { target: { kind: 'global' }, waf: null },
        { target: { kind: 'dashboard' }, waf: { ...on(''), enabled: false } },
        { target: { kind: 'host', name: 'a' }, waf: { ...on(''), mode: 'Off' } },
      ],
      new Map(),
      new Map(),
    );
    expect(outcome).toEqual({ status: 'accepted' });
    expect(seen).toEqual([]);
  });

  it('sends each distinct WAF once and blames the one Caddy named', async () => {
    const seen = answer(async () => ({ status: 422, text: REFUSAL }));
    const outcome = await dryRunWaf(
      [
        { target: { kind: 'global' }, waf: on('') },
        { target: { kind: 'host', name: 'same-as-global' }, waf: on('') },
        { target: { kind: 'host', name: 'broken' }, waf: on('SecAction "id:942100,pass"') },
      ],
      new Map(),
      new Map(),
    );
    expect(Object.keys(JSON.parse(seen[0]).apps.http.servers)).toEqual([
      'candidate_0',
      'candidate_1',
    ]);
    expect(outcome).toMatchObject({ status: 'refused', target: { kind: 'host', name: 'broken' } });
  });

  it("skips without an agent, on a failure to ask, and on a refusal that is not the WAF's", async () => {
    const candidates = [{ target: { kind: 'global' as const }, waf: on('') }];
    answer(async () => null);
    expect(await dryRunWaf(candidates, new Map(), new Map())).toEqual({
      status: 'skipped',
      reason: 'noAgent',
    });
    setCaddyValidator(async () => {
      throw new Error('agent went away');
    });
    expect(await dryRunWaf(candidates, new Map(), new Map())).toEqual({
      status: 'skipped',
      reason: 'unavailable',
    });
    setCaddyValidator(async () => ({
      status: 422,
      text: 'Error: unknown module: http.handlers.waf',
    }));
    expect(await dryRunWaf(candidates, new Map(), new Map())).toEqual({
      status: 'skipped',
      reason: 'notWaf',
    });
  });
});

describe('assertWafLoads', () => {
  it('throws a domain error naming the host', async () => {
    answer(async () => ({ status: 422, text: REFUSAL.replace('candidate_1', 'candidate_0') }));
    const error = await assertWafLoads([{ target: { kind: 'host', name: 'shop' }, waf: on('x') }], {
      presets: new Map(),
      plugins: new Map(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('wafDryRunRejectedHost');
    expect((error as DomainError).params.name).toBe('shop');
    expect((error as DomainError).status).toBe(400);
  });

  it('lets the save through when Caddy accepts or nothing can ask', async () => {
    answer(async () => ({ status: 200, text: 'Valid configuration' }));
    await assertWafLoads([{ target: { kind: 'global' }, waf: on('') }], {
      presets: new Map(),
      plugins: new Map(),
    });
    setCaddyValidator(async () => null);
    await assertWafLoads([{ target: { kind: 'global' }, waf: on('') }], {
      presets: new Map(),
      plugins: new Map(),
    });
  });
});
