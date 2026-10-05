/**
 * This checkout's controller with an older agent, then the agent upgraded in place:
 *
 *   bun run test:upgrade:agent --from ../cpm-main [--keep]     (from apps/controller)
 *
 * Needs Docker, and 3000, 80, 443 and 25500-25511 free on the host. Builds the older checkout's
 * agent, this one's agent and web, and runs them as the Compose project `cpm-upgrade` with
 * ./mixed-agent.compose.yml. Caddy is an image built elsewhere (CADDY_IMAGE, the released one by
 * default) in external mode, so neither agent ever rebuilds it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .scriptName('mixed-agent')
  .option('from', { type: 'string', demandOption: true, describe: 'older checkout (repo root)' })
  .option('keep', { type: 'boolean', default: false, describe: 'leave the stack running' })
  .strict()
  .help()
  .parseSync();

const REPO = resolve(import.meta.dir, '../../../..');
const PREVIOUS = resolve(argv.from);
if (!existsSync(resolve(PREVIOUS, 'docker/agent/Dockerfile'))) {
  throw new Error(`${argv.from} is not a checkout of this repository`);
}

const PROJECT = 'cpm-upgrade';
const BASE = 'http://localhost:3000';
const CADDY_IMAGE = process.env.CADDY_IMAGE || 'ghcr.io/caddyproxymanager/caddy:latest';
const IMAGES = {
  previousAgent: 'cpm-upgrade/agent:previous',
  agent: 'cpm-upgrade/agent:current',
  web: 'cpm-upgrade/web:current',
  backend: 'cpm-upgrade/backend:current',
};
const AGENT = 'caddy-proxy-manager-agent';
const CADDY = 'caddy-proxy-manager-caddy';
const WEB = 'caddy-proxy-manager-web';
const ECHO = 'cpm-upgrade-echo';
const ORIGIN = 'cpm-upgrade-origin';
const RANGE = { first: 25500, last: 25502 };
const LATER_RANGE = { first: 25510, last: 25511 };

function sh(args: string[], options: { env?: Record<string, string>; allowFail?: boolean } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${args.join(' ')} exited ${result.status}\n${output.slice(-3000)}`);
  }
  return { ok: result.status === 0, output: output.trim() };
}

function compose(args: string[], agentImage = IMAGES.previousAgent) {
  return sh(
    [
      'docker',
      'compose',
      '-p',
      PROJECT,
      '--env-file',
      'apps/controller/tests/e2e.env',
      '-f',
      'docker-compose.yml',
      '-f',
      'apps/controller/tests/upgrade/mixed-agent.compose.yml',
      ...args,
    ],
    {
      env: {
        CPM_UPGRADE_AGENT_IMAGE: agentImage,
        CPM_UPGRADE_WEB_IMAGE: IMAGES.web,
        CADDY_IMAGE,
      },
    },
  );
}

const failures: string[] = [];
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `\n       ${detail}`}`);
  if (!ok) failures.push(what);
}

async function until<T>(what: string, probe: () => Promise<T | null> | T | null, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value as T;
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const agentLog = () => sh(['docker', 'logs', AGENT], { allowFail: true }).output;
const webLog = () => sh(['docker', 'logs', WEB], { allowFail: true }).output;
const caddyId = () => sh(['docker', 'inspect', '-f', '{{.Id}}', CADDY], { allowFail: true }).output;
const l4Override = () =>
  sh(['docker', 'exec', AGENT, 'cat', '/data/docker-compose.l4-ports.yml'], { allowFail: true });

// ── HTTP ─────────────────────────────────────────────────────────────────────

let cookie = '';

async function signIn(): Promise<void> {
  const res = await fetch(`${BASE}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ username: 'upgradeadmin', password: 'Upgrade-Admin-Password-2026!' }),
  });
  if (!res.ok) throw new Error(`sign-in answered ${res.status}: ${await res.text()}`);
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 409) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return { status: res.status, text };
}

async function page(path: string): Promise<string> {
  return (await fetch(`${BASE}${path}`, { headers: { cookie } })).text();
}

/** Through Caddy on :80, as a client would arrive. */
async function viaCaddy(host: string, headers: Record<string, string> = {}) {
  return fetch('http://127.0.0.1/', { headers: { host, ...headers }, redirect: 'manual' });
}

function echoes(port: number): Promise<boolean> {
  return new Promise((done) => {
    let got = '';
    const timer = setTimeout(() => done(false), 4000);
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open: (s) => void s.write(`ping ${port}\n`),
        data: (s, data) => {
          got += data.toString();
          if (got.includes('\n')) {
            clearTimeout(timer);
            s.end();
            done(true);
          }
        },
        error: () => done(false),
        close: () => done(got.length > 0),
      },
    }).catch(() => done(false));
  });
}

const ports = (range: { first: number; last: number }) =>
  Array.from({ length: range.last - range.first + 1 }, (_, i) => range.first + i);

async function rangeEchoes(range: { first: number; last: number }) {
  return (await Promise.all(ports(range).map(echoes))).every(Boolean);
}

type L4State = { diff: { needsApply: boolean }; status: { state: string; appliedAt?: string } };

async function l4State(): Promise<L4State> {
  return JSON.parse((await api('GET', '/api/l4-ports')).text) as L4State;
}

/** Until the agent records it: restarted before that, it applies again, rightly recreating Caddy. */
async function applyL4Ports(): Promise<void> {
  const before = (await l4State()).status.appliedAt ?? '';
  await api('POST', '/api/l4-ports', {});
  await until(
    'the agent to record the ports',
    async () => {
      const { diff, status } = await l4State();
      return status.state === 'applied' && (status.appliedAt ?? '') > before && !diff.needsApply;
    },
    180_000,
  );
}

// ── The run ──────────────────────────────────────────────────────────────────

function preflight(): void {
  const names = sh(['docker', 'ps', '-a', '--format', '{{.Names}}']).output.split('\n');
  const taken = names.filter((name) => name.startsWith('caddy-proxy-manager-'));
  if (taken.length > 0) {
    throw new Error(
      `Containers named ${taken.join(', ')} exist: another stack (the e2e suite, or a real one) ` +
        'would collide with this one. Stop it first.',
    );
  }
}

function build(): void {
  console.log('Building images…');
  const agentArgs = ['--build-arg', 'PUID=10002', '--build-arg', 'PGID=10002'];
  sh([
    'docker',
    'build',
    '-q',
    '-f',
    resolve(PREVIOUS, 'docker/agent/Dockerfile'),
    ...agentArgs,
    '-t',
    IMAGES.previousAgent,
    PREVIOUS,
  ]);
  sh([
    'docker',
    'build',
    '-q',
    '-f',
    'docker/agent/Dockerfile',
    ...agentArgs,
    '-t',
    IMAGES.agent,
    '.',
  ]);
  sh(['docker', 'build', '-q', '-f', 'docker/web/Dockerfile', '-t', IMAGES.web, '.']);
  sh(['docker', 'build', '-q', '-t', IMAGES.backend, 'docker-tests/images/backend']);
  if (!sh(['docker', 'image', 'inspect', CADDY_IMAGE], { allowFail: true }).ok) {
    sh(['docker', 'pull', CADDY_IMAGE]);
  }
}

async function withPreviousAgent(): Promise<void> {
  console.log('\nThis controller, the previous agent');
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'web', 'agent']);
  await until(
    'Caddy to start',
    () =>
      sh(['docker', 'inspect', '-f', '{{.State.Running}}', CADDY], { allowFail: true }).output ===
      'true',
  );
  const network = `${PROJECT}_caddy-network`;
  sh([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    ECHO,
    '--network',
    network,
    IMAGES.backend,
    'tcp',
    '9000',
  ]);
  sh([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    ORIGIN,
    '--network',
    network,
    IMAGES.backend,
    'http',
    '8080',
  ]);
  await signIn();

  // A range, which the previous agent's pattern refuses: it must get the ports one by one.
  await api('POST', '/api/v1/l4-proxy-hosts', {
    name: 'Range',
    protocol: 'tcp',
    listenAddress: `:${RANGE.first}-${RANGE.last}`,
    upstreams: [`${ECHO}:9000`],
  });
  await applyL4Ports();
  const override = await until('the L4 port override', () => {
    const file = l4Override();
    return file.ok && file.output.includes(`"${RANGE.last}:${RANGE.last}"`) ? file.output : null;
  });
  check(
    ports(RANGE).every((port) => override.includes(`"${port}:${port}"`)) &&
      !/"\d+-\d+:/.test(override),
    'the previous agent was sent the range one port at a time',
    override,
  );
  check(await until('the range to echo', () => rangeEchoes(RANGE), 60_000), 'every port relays');

  const before = agentLog();
  const refused = await api('POST', '/api/v1/certificates', {
    source: 'agent-file',
    name: 'From files',
    sourceAgentId: 1,
    sourceCertPath: 'site/fullchain.pem',
    sourceKeyPath: 'site/privkey.pem',
  });
  check(refused.status === 409, 'a certificate from files is refused for it', refused.text);
  // An unknown kind reaches the previous agent's admin-path check, or times out on an older one.
  check(
    !/certificate-files|admin path/.test(agentLog().slice(before.length)),
    'and it is sent no certificate-files command',
  );
  check((await page('/certificates')).includes('\\"fileAgents\\":[]'), 'the picker lists no agent');

  await api('POST', '/api/v1/proxy-hosts', {
    name: 'Compressed',
    domains: ['comp.test'],
    upstreams: [`${ORIGIN}:8080`],
    sslForced: false,
  });
  await api('POST', '/api/v1/proxy-hosts', {
    name: 'Maintenance',
    domains: ['maint.test'],
    upstreams: [`${ORIGIN}:8080`],
    sslForced: false,
    maintenance: { enabled: true, retryAfter: 120, bypassCidrs: [], body: null },
  });
  await api('POST', '/api/v1/proxy-hosts', {
    name: 'Rate limited',
    domains: ['rl.test'],
    upstreams: [`${ORIGIN}:8080`],
    sslForced: false,
    rateLimit: {
      enabled: true,
      zones: [{ paths: [], maxEvents: 2, window: '1m', key: 'ip', ipv6Prefix: null }],
    },
  });
  await hostsServe('through the previous agent');

  await api('PUT', '/api/v1/settings/crowdsec', {
    enabled: true,
    mode: 'managed',
    onlineApi: false,
    managedAppsec: false,
    apiUrl: '',
    apiKey: '',
    appsecUrl: '',
    appsecFailOpen: false,
    tickerInterval: '60s',
  });
  await Bun.sleep(5000);
  const running = sh(['docker', 'ps', '--format', '{{.Names}}']).output;
  check(!running.includes('caddy-proxy-manager-crowdsec'), 'managed CrowdSec is not started by it');
  check(
    (await page('/settings/crowdsec')).includes('Not running on'),
    'Settings shows the managed CrowdSec as not running',
  );
  await hostsServe('with managed CrowdSec saved');
}

async function hostsServe(when: string): Promise<void> {
  const pad = 'a'.repeat(3000);
  const compressed = await until('compression', async () => {
    const res = await viaCaddy('comp.test', { 'x-pad': pad, 'accept-encoding': 'gzip' });
    return res.status === 200 ? res : null;
  });
  check(compressed.headers.get('content-encoding') === 'gzip', `compression applies ${when}`);
  const maint = await viaCaddy('maint.test');
  check(
    maint.status === 503 && maint.headers.get('retry-after') === '120',
    `maintenance applies ${when}`,
  );
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await viaCaddy('rl.test')).status);
  // The module is absent from the image: the host serves, unlimited, and the log says why.
  check(
    statuses.every((status) => status === 200) && webLog().includes('Skipping rate limiting'),
    `a rate-limited host still serves ${when}, without the module`,
    statuses.join(' '),
  );
}

async function upgradeAgent(): Promise<void> {
  console.log('\nThe agent upgraded in place');
  const caddy = caddyId();
  compose(['up', '-d', '--no-build', '--no-deps', 'agent'], IMAGES.agent);
  await until('the upgraded agent to attach', () => agentLog().includes('attached'));
  // Its startup restore and first reconcile, which is where a recreate would come from.
  await until(
    'Caddy to run again',
    () =>
      sh(['docker', 'inspect', '-f', '{{.State.Running}}', CADDY], { allowFail: true }).output ===
      'true',
  );
  await Bun.sleep(15_000);
  const log = agentLog();
  check(caddyId() === caddy, 'Caddy is started again, not recreated', log);
  check(!/republishing|could not start Caddy/.test(log), 'no port republish or failed start', log);
  check(await until('the range to echo', () => rangeEchoes(RANGE), 60_000), 'every port relays');
  await hostsServe('after the upgrade');

  // Only an agent listing l4-port-ranges is sent a range as written.
  await api('POST', '/api/v1/l4-proxy-hosts', {
    name: 'Later range',
    protocol: 'tcp',
    listenAddress: `:${LATER_RANGE.first}-${LATER_RANGE.last}`,
    upstreams: [`${ECHO}:9000`],
  });
  await applyL4Ports();
  const later = `"${LATER_RANGE.first}-${LATER_RANGE.last}:${LATER_RANGE.first}-${LATER_RANGE.last}"`;
  const override = await until('the new range in the override', () => {
    const file = l4Override();
    return file.ok && file.output.includes(later) ? file.output : null;
  });
  check(override.includes(later), 'the upgraded agent is sent ranges as ranges', override);
  check(
    await until(
      'both ranges to echo',
      async () => (await rangeEchoes(RANGE)) && (await rangeEchoes(LATER_RANGE)),
      60_000,
    ),
    'every port of both ranges relays',
  );
  const crowdsec = await until(
    'managed CrowdSec to start',
    () =>
      sh(['docker', 'ps', '--format', '{{.Names}}']).output.includes(
        'caddy-proxy-manager-crowdsec',
      ),
    180_000,
  );
  check(crowdsec, 'the upgraded agent starts the managed CrowdSec it now knows');
}

/** The agent stops Caddy on its way down; coming back up must start that container, not a new one. */
async function restartAgent(): Promise<{ recreated: boolean; log: string }> {
  const caddy = caddyId();
  // Counted, not sliced: the log comes back as stdout then stderr, so its length is no position.
  const attaches = () => agentLog().split('attached to').length;
  const before = attaches();
  sh(['docker', 'restart', AGENT]);
  await until('the agent to attach again', () => attaches() > before);
  await until(
    'Caddy to run again',
    () =>
      sh(['docker', 'inspect', '-f', '{{.State.Running}}', CADDY], { allowFail: true }).output ===
      'true',
  );
  await Bun.sleep(15_000);
  const log = sh(['docker', 'logs', '--since', '60s', AGENT], { allowFail: true }).output;
  return { recreated: caddyId() !== caddy, log };
}

async function restartsQuietly(): Promise<void> {
  console.log(`\nThe upgraded agent restarted`);
  const withPorts = await restartAgent();
  check(!withPorts.recreated, 'with L4 ports published, Caddy is not recreated', withPorts.log);
  check(await until('the range to echo', () => rangeEchoes(RANGE), 60_000), 'every port relays');

  const hosts = JSON.parse((await api('GET', '/api/v1/l4-proxy-hosts')).text) as { id: number }[];
  for (const host of hosts) await api('DELETE', `/api/v1/l4-proxy-hosts/${host.id}`);
  await applyL4Ports();
  await until('the empty port set to apply', () => {
    const file = l4Override();
    return file.ok && file.output.includes('services: {}');
  });
  const without = await restartAgent();
  check(!without.recreated, 'with no L4 ports, Caddy is not recreated', without.log);
}

function teardown(): void {
  sh(['docker', 'rm', '-f', ECHO, ORIGIN], { allowFail: true });
  compose([
    '--profile',
    'caddy',
    '--profile',
    'clickhouse',
    '--profile',
    'crowdsec',
    'down',
    '-v',
    '--remove-orphans',
  ]);
  sh(['docker', 'image', 'rm', ...Object.values(IMAGES)], { allowFail: true });
}

preflight();
build();
try {
  await withPreviousAgent();
  await upgradeAgent();
  await restartsQuietly();
} catch (error) {
  failures.push(String(error));
  console.error(error);
  console.error(`\nagent log:\n${agentLog().slice(-4000)}`);
} finally {
  if (!argv.keep) teardown();
}
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
