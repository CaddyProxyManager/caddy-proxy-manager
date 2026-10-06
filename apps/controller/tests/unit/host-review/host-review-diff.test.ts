/**
 * The review step's diff: what counts as a change, how a nested setting is listed, what is masked,
 * and what an undo may drop. The catalog must name every field, section and warning it can emit,
 * since those keys are composed at runtime.
 */
import { describe, expect, it } from 'bun:test';
import messages from '../../../messages/en.json';
import {
  HTTP_FIELDS,
  L4_FIELDS,
  diffHostFields,
  redactSecretText,
  revertedFields,
  withoutReverted,
} from '../../../src/lib/host-review/diff';
import { IMPACT_WARNINGS, MASKED_VALUE } from '../../../src/lib/host-review/types';
import { EDITOR_SECTIONS } from '../../../src/lib/proxy-hosts/editor-sections';
import { L4_EDITOR_SECTIONS } from '../../../src/lib/l4/editor-sections';
import { PROTECTIONS } from '../../../src/lib/proxy-hosts/protections';
import { countChangedFields } from '../../../src/components/host-review/useUnsavedChanges';

const BLANK = { name: '', domains: [], upstreams: [], sslForced: true, waf: null };

describe('diffHostFields', () => {
  it('lists changed scalars and lists, in editor order, and nothing else', () => {
    const before = { ...BLANK, name: 'app', domains: ['a.example.com'], upstreams: ['app:80'] };
    const after = { ...before, domains: ['a.example.com', 'b.example.com'], sslForced: false };
    expect(diffHostFields('http', before, after, BLANK)).toEqual([
      {
        field: 'domains',
        section: 'general',
        before: ['a.example.com'],
        after: ['a.example.com', 'b.example.com'],
        leaves: null,
        masked: false,
        revertible: true,
      },
      {
        field: 'sslForced',
        section: 'upstreams',
        before: true,
        after: false,
        leaves: null,
        masked: false,
        revertible: true,
      },
    ]);
  });

  it('reads absent, null, blank and empty as one "not set"', () => {
    const before = { ...BLANK, description: null, tags: [] };
    const after = { ...BLANK, description: '', tags: undefined };
    expect(diffHostFields('http', before, after, BLANK)).toEqual([]);
  });

  it('lists only the settings inside a nested field that changed', () => {
    const before = {
      ...BLANK,
      rateLimit: { enabled: true, mode: 'merge', zones: [{ window: '1m', maxEvents: 10 }] },
    };
    const after = {
      ...BLANK,
      rateLimit: { enabled: true, mode: 'override', zones: [{ window: '1m', maxEvents: 20 }] },
    };
    const [change] = diffHostFields('http', before, after, BLANK);
    expect(change).toMatchObject({ field: 'rateLimit', section: 'protection', before: null });
    expect(change.leaves).toEqual([
      { path: 'mode', before: 'merge', after: 'override' },
      { path: 'zones.0.maxEvents', before: 10, after: 20 },
    ]);
  });

  it('ignores a switched-off config the host never stored', () => {
    const after = { ...BLANK, waf: { enabled: false, waf_mode: 'merge' } };
    expect(diffHostFields('http', BLANK, after, BLANK)).toEqual([]);
  });

  it('masks a secret-looking setting on both sides, still reporting the change', () => {
    const before = { ...BLANK, loadBalancer: { policy: 'cookie', policyCookieSecret: 'old' } };
    const after = { ...BLANK, loadBalancer: { policy: 'cookie', policyCookieSecret: 'new' } };
    const [change] = diffHostFields('http', before, after, BLANK);
    expect(change.masked).toBe(true);
    expect(change.leaves).toEqual([
      { path: 'policyCookieSecret', before: MASKED_VALUE, after: MASKED_VALUE },
    ]);
  });

  it('masks health-check headers and probe bodies', () => {
    const check = (headers: Record<string, string>, requestBody: string) => ({
      ...BLANK,
      loadBalancer: { activeHealthCheck: { enabled: true, headers, requestBody } },
    });
    const before = check({ Authorization: 'Bearer old', 'X-Tenant': 'a' }, 'user=a&pw=1');
    const after = check({ Authorization: 'Bearer new', 'X-Tenant': 'b' }, 'user=a&pw=2');
    const [change] = diffHostFields('http', before, after, BLANK);
    expect(change.masked).toBe(true);
    expect(JSON.stringify(change.leaves)).not.toMatch(/Bearer|pw=|"a"|"b"/);
    expect(change.leaves?.map((leaf) => leaf.path)).toEqual([
      'activeHealthCheck.headers.Authorization',
      'activeHealthCheck.headers.X-Tenant',
      'activeHealthCheck.requestBody',
    ]);
  });

  it('masks cookie and bearer-named settings', () => {
    const [change] = diffHostFields(
      'http',
      { ...BLANK, forwardAuth: { sessionCookie: 'a', bearer: 'x' } },
      { ...BLANK, forwardAuth: { sessionCookie: 'b', bearer: 'y' } },
      BLANK,
    );
    expect(change.leaves?.every((leaf) => leaf.after === MASKED_VALUE)).toBe(true);
  });

  it('redacts credentials inside raw config rather than hiding the snippet', () => {
    const after = {
      ...BLANK,
      customCaddyfile: 'header_up Authorization "Bearer abc123"\nrespond /status "ok"',
    };
    const [change] = diffHostFields('http', BLANK, after, BLANK);
    expect(change.masked).toBe(true);
    expect(String(change.after)).not.toContain('abc123');
    expect(String(change.after)).toContain('respond /status "ok"');
  });

  it('keeps what a create cannot do without from being undone', () => {
    const after = { ...BLANK, name: 'app', domains: ['a.example.com'], sslForced: false };
    const changes = diffHostFields('http', null, after, BLANK);
    expect(changes.find((c) => c.field === 'name')?.revertible).toBe(false);
    expect(changes.find((c) => c.field === 'sslForced')?.revertible).toBe(true);
  });

  it('groups L4 fields by the L4 editor sections', () => {
    const before = { name: 'db', listenAddress: ':5432', accessListId: 'office' };
    const after = { ...before, listenAddress: ':5433', accessListId: null };
    expect(diffHostFields('l4', before, after, {}).map((c) => [c.field, c.section])).toEqual([
      ['listenAddress', 'listener'],
      ['accessListId', 'protection'],
    ]);
  });
});

describe('redactSecretText', () => {
  it('hides JSON values under secret-looking keys', () => {
    const json = '{"headers": {"Authorization": ["Bearer xyz"]}, "api_key": "k-1", "path": "/x"}';
    const out = redactSecretText(json);
    expect(out).not.toContain('xyz');
    expect(out).not.toContain('k-1');
    expect(out).toContain('"path": "/x"');
  });

  it('hides bcrypt hashes and word-value pairs', () => {
    const hash = `$2a$14$${'a'.repeat(53)}`;
    const out = redactSecretText(`basic_auth {\n  admin ${hash}\n}\ntoken s3cr3t`);
    expect(out).not.toContain(hash);
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('basic_auth {');
  });

  it('leaves text without secrets alone', () => {
    const text = 'respond /health "ok" 200';
    expect(redactSecretText(text)).toBe(text);
  });
});

describe('withoutReverted', () => {
  it('drops the undone fields, and nothing a create needs', () => {
    const input: Record<string, unknown> = {
      name: 'app',
      domains: ['a'],
      sslForced: false,
      bogus: 1,
    };
    expect(withoutReverted('http', input, ['sslForced', 'nope'], false)).toEqual({
      name: 'app',
      domains: ['a'],
      bogus: 1,
    });
    expect(withoutReverted('http', input, ['name', 'sslForced'], true)).toEqual({
      name: 'app',
      domains: ['a'],
      bogus: 1,
    });
  });

  it('reads the undo entries a form carries', () => {
    const form = new FormData();
    form.append('revertField', 'domains');
    form.append('revertField', 'waf');
    expect(revertedFields(form)).toEqual(['domains', 'waf']);
  });
});

describe('countChangedFields', () => {
  it('counts each field whose values differ, either side missing included', () => {
    const baseline = new Map([
      ['name', '["app"]'],
      ['domains', '["a"]'],
      ['tag', '["x"]'],
    ]);
    const current = new Map([
      ['name', '["app"]'],
      ['domains', '["b"]'],
      ['upstreams', '["u"]'],
    ]);
    expect(countChangedFields(baseline, current)).toBe(3);
    expect(countChangedFields(baseline, baseline)).toBe(0);
  });
});

describe('hostReview catalog', () => {
  const review = messages.hostReview as unknown as {
    fields: Record<string, string>;
    sections: { http: Record<string, string>; l4: Record<string, string> };
    warnings: Record<string, string>;
    protections: Record<string, string>;
  };

  it('labels every field either editor can list', () => {
    const fields = [...Object.keys(HTTP_FIELDS), ...Object.keys(L4_FIELDS)];
    expect(fields.filter((field) => !review.fields[field])).toEqual([]);
  });

  it('labels every section, and every field sits in one', () => {
    expect(EDITOR_SECTIONS.filter((s) => !review.sections.http[s])).toEqual([]);
    expect(L4_EDITOR_SECTIONS.filter((s) => !review.sections.l4[s])).toEqual([]);
    for (const spec of Object.values(HTTP_FIELDS)) expect(EDITOR_SECTIONS).toContain(spec.section);
    for (const spec of Object.values(L4_FIELDS)) expect(L4_EDITOR_SECTIONS).toContain(spec.section);
  });

  it('words every warning and every protection one can name', () => {
    expect(IMPACT_WARNINGS.filter((code) => !review.warnings[code])).toEqual([]);
    expect(PROTECTIONS.filter((p) => !review.protections[p])).toEqual([]);
  });
});
