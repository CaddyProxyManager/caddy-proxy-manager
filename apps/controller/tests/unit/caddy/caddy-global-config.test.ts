/** Addition only: each refusal is something CPM rebuilds per apply and would silently fight. */
import { afterEach, describe, expect, it } from 'bun:test';

import { type CaddyAdminTransport, setCaddyAdminTransport } from '@/src/lib/caddy/admin';
import {
  assertGlobalCaddyConfigLoads,
  GLOBAL_CADDYFILE_MAX_LENGTH,
  mergeGlobalConfig,
  withGlobalCaddyConfig,
} from '@/src/lib/caddy/global-config';

const cpm = () => ({
  admin: { listen: ':2019' },
  logging: { logs: { waf_rules: { level: 'ERROR' } } },
  apps: {
    http: {
      servers: { cpm: { listen: [':80', ':443'], routes: [] }, metrics: { listen: [':9090'] } },
    },
    tls: { automation: { policies: [] }, certificates: { load_pem: [] } },
    layer4: { servers: { l4_0: { listen: ['udp/:5353'] } } },
  },
});

describe('mergeGlobalConfig', () => {
  it('adds apps CPM does not build, as they are', () => {
    const { document, refused } = mergeGlobalConfig(cpm(), {
      apps: { events: { subscriptions: [] }, pki: { certificate_authorities: {} } },
    });
    expect(refused).toEqual([]);
    expect((document.apps as Record<string, unknown>).events).toEqual({ subscriptions: [] });
    expect((document.apps as Record<string, unknown>).pki).toBeDefined();
  });

  it('adds a server on a free port under a name of its own', () => {
    const extra = { listen: [':8080'], routes: [{ handle: [{ handler: 'static_response' }] }] };
    const { document, refused } = mergeGlobalConfig(cpm(), {
      apps: { http: { servers: { srv0: extra } } },
    });
    expect(refused).toEqual([]);
    const servers = (document.apps as { http: { servers: Record<string, unknown> } }).http.servers;
    expect(servers.global_srv0).toEqual(extra);
    expect(servers.cpm).toBeDefined();
  });

  it.each([
    [':443'],
    ['0.0.0.0:80'],
    ['tcp/[::]:9090'],
    [':9000-9100'],
    ['udp/:5353'],
    ['not an address'],
  ])('refuses a server whose listen address %s collides or cannot be read', (address) => {
    const { refused } = mergeGlobalConfig(cpm(), {
      apps: { http: { servers: { srv0: { listen: [address] } } } },
    });
    expect(refused).toEqual(['apps.http.servers.srv0']);
  });

  it('accepts a unix socket, which claims no port', () => {
    const { refused } = mergeGlobalConfig(cpm(), {
      apps: { http: { servers: { srv0: { listen: ['unix//run/extra.sock'] } } } },
    });
    expect(refused).toEqual([]);
  });

  it('adds logs under new names and refuses the ones CPM writes', () => {
    const { document, refused } = mergeGlobalConfig(cpm(), {
      logging: { logs: { default: { level: 'DEBUG' }, http_access: {}, waf_rules: {} } },
    });
    expect(refused).toEqual(['logging.logs.http_access', 'logging.logs.waf_rules']);
    expect((document.logging as { logs: Record<string, unknown> }).logs.default).toEqual({
      level: 'DEBUG',
    });
  });

  it.each([
    [{ admin: { listen: ':3000' } }, 'admin'],
    [{ storage: { module: 'file_system', root: '/tmp' } }, 'storage'],
    [{ apps: { tls: { automation: { policies: [{ issuers: [] }] } } } }, 'apps.tls.automation'],
    [{ apps: { tls: { certificates: { load_files: [] } } } }, 'apps.tls.certificates'],
    [{ apps: { http: { http_port: 8080 } } }, 'apps.http.http_port'],
    [{ apps: { http: { https_port: 8443 } } }, 'apps.http.https_port'],
    [{ apps: { layer4: { servers: {} } } }, 'apps.layer4'],
    [{ apps: { tailscale: {} } }, 'apps.tailscale'],
  ])('refuses %j by name', (adapted, path) => {
    expect(mergeGlobalConfig(cpm(), adapted).refused).toEqual([path]);
  });

  it('refuses tls automation even while CPM has none', () => {
    const base = cpm();
    delete (base.apps as Record<string, unknown>).tls;
    expect(
      mergeGlobalConfig(base, { apps: { tls: { automation: { on_demand: {} } } } }).refused,
    ).toEqual(['apps.tls.automation']);
  });

  it('adds tls settings CPM leaves unset', () => {
    const { document, refused } = mergeGlobalConfig(cpm(), {
      apps: { tls: { session_tickets: { disabled: true } } },
    });
    expect(refused).toEqual([]);
    const tls = (document.apps as { tls: Record<string, unknown> }).tls;
    expect(tls.session_tickets).toEqual({ disabled: true });
    expect(tls.automation).toEqual({ policies: [] });
  });

  it('never changes the document it was given', () => {
    const base = cpm();
    const before = JSON.stringify(base);
    mergeGlobalConfig(base, {
      logging: { logs: { extra: {} } },
      apps: { http: { servers: { srv0: { listen: [':8080'] } } }, events: {} },
    });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('withGlobalCaddyConfig', () => {
  let previous: CaddyAdminTransport | null = null;
  const answer = (status: number, body: unknown) => {
    previous = setCaddyAdminTransport(async () => ({
      status,
      text: JSON.stringify(body),
      headers: {},
    }));
  };
  afterEach(() => {
    if (previous) setCaddyAdminTransport(previous);
    previous = null;
  });

  it('merges what Caddy adapted', async () => {
    answer(200, { result: { apps: { events: {} } } });
    const merged = await withGlobalCaddyConfig(cpm(), '{\n  events\n}');
    expect((merged.apps as Record<string, unknown>).events).toEqual({});
  });

  it('keeps the document whole when the Caddyfile does not adapt', async () => {
    answer(400, { error: 'unknown directive' });
    const base = cpm();
    expect(await withGlobalCaddyConfig(base, 'nonsense')).toBe(base);
  });

  it('keeps the document whole when any part is refused, rather than apply half', async () => {
    answer(200, { result: { admin: { listen: ':1' }, apps: { events: {} } } });
    const base = cpm();
    expect(await withGlobalCaddyConfig(base, 'x')).toBe(base);
  });

  it('asks nothing for an empty Caddyfile', async () => {
    let asked = false;
    previous = setCaddyAdminTransport(async () => {
      asked = true;
      return { status: 200, text: '{}', headers: {} };
    });
    const base = cpm();
    expect(await withGlobalCaddyConfig(base, '  \n')).toBe(base);
    expect(asked).toBe(false);
  });
});

describe('assertGlobalCaddyConfigLoads', () => {
  it('refuses an oversized Caddyfile before asking Caddy anything', async () => {
    await expect(
      assertGlobalCaddyConfigLoads('#'.repeat(GLOBAL_CADDYFILE_MAX_LENGTH + 1)),
    ).rejects.toMatchObject({ code: 'globalCaddyfileTooLong' });
  });

  it('refuses control characters other than tabs and line breaks', async () => {
    await expect(
      assertGlobalCaddyConfigLoads(`{\n\tdebug\n}${String.fromCharCode(27)}`),
    ).rejects.toMatchObject({ code: 'globalCaddyfileControlCharacter' });
  });

  it('accepts an empty one, which switches the feature off', async () => {
    await expect(assertGlobalCaddyConfigLoads('')).resolves.toBeUndefined();
  });
});
