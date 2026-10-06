/**
 * Two controllers on one database, behind HAProxy, with the bundled agent and a real Caddy:
 *
 *   bun run test:ha [--keep]     (from apps/controller)
 *
 * Needs Docker, and 80, 3000, 3101 and 3102 free on the host. Builds this checkout's web and agent
 * and runs them as the Compose project `cpm-ha` with ./ha.compose.yml. Each controller is driven
 * through its own port with an API token, so work can be sent to the one that does not hold the
 * agent's stream; then that one is stopped, and the agent has to find the other.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .scriptName('ha')
  .option('keep', { type: 'boolean', default: false, describe: 'leave the stack running' })
  .option('build', { type: 'boolean', default: true, describe: 'build the images (--no-build)' })
  .strict()
  .help()
  .parseSync();

const REPO = resolve(import.meta.dir, '../../../..');
const PROJECT = 'cpm-ha';
const LB = 'http://localhost:3000';
const CADDY_IMAGE = process.env.CADDY_IMAGE || 'ghcr.io/caddyproxymanager/caddy:latest';
const IMAGES = {
  web: 'cpm-ha/web:current',
  agent: 'cpm-ha/agent:current',
  backend: 'cpm-ha/backend:current',
};
const REPLICAS = {
  'web-a': { container: 'caddy-proxy-manager-web', url: 'http://localhost:3101' },
  'web-b': { container: 'caddy-proxy-manager-web-b', url: 'http://localhost:3102' },
} as const;
type Replica = keyof typeof REPLICAS;
const POSTGRES = 'caddy-proxy-manager-postgres';
const CADDY = 'caddy-proxy-manager-caddy';
const ORIGIN = 'cpm-ha-origin';

function sh(args: string[], options: { allowFail?: boolean } = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      CPM_HA_WEB_IMAGE: IMAGES.web,
      CPM_HA_AGENT_IMAGE: IMAGES.agent,
      CADDY_IMAGE,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${args.join(' ')} exited ${result.status}\n${output.slice(-3000)}`);
  }
  return { ok: result.status === 0, output: output.trim() };
}

function compose(args: string[], options: { allowFail?: boolean } = {}) {
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
      'apps/controller/tests/ha/ha.compose.yml',
      ...args,
    ],
    options,
  );
}

const failures: string[] = [];
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `\n       ${detail}`}`);
  if (!ok) failures.push(what);
}

async function until<T>(what: string, probe: () => Promise<T | null> | T | null, ms = 120_000) {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value as T;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

function sql(query: string): string {
  return sh(['docker', 'exec', POSTGRES, 'psql', '-U', 'cpm', '-d', 'cpm', '-tAc', query]).output;
}

const log = (replica: Replica) =>
  sh(['docker', 'logs', REPLICAS[replica].container], { allowFail: true }).output;

/** Which replica's hostname holds the agent's stream, per the database. */
function holder(): Replica | null {
  const name = sql(
    `select r.hostname from agent_connections c join controller_replicas r on r.id = c."replicaId"`,
  );
  return name === 'web-a' || name === 'web-b' ? name : null;
}

const other = (replica: Replica): Replica => (replica === 'web-a' ? 'web-b' : 'web-a');

// ── HTTP ─────────────────────────────────────────────────────────────────────

let token = '';

async function createToken(): Promise<void> {
  const signIn = await fetch(`${LB}/api/auth/sign-in/username`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: LB },
    body: JSON.stringify({ username: 'haadmin', password: 'Ha-Admin-Password-2026!' }),
  });
  if (!signIn.ok) throw new Error(`sign-in answered ${signIn.status}: ${await signIn.text()}`);
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  // Through HAProxy, so most likely the session lands on one replica and this on the other.
  const created = await fetch(`${LB}/api/v1/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: LB, cookie },
    body: JSON.stringify({ name: 'ha test' }),
  });
  if (!created.ok) throw new Error(`token answered ${created.status}: ${await created.text()}`);
  token = ((await created.json()) as { raw_token: string }).raw_token;
}

async function api(replica: Replica, method: string, path: string, body?: unknown) {
  const res = await fetch(`${REPLICAS[replica].url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/** Through Caddy on :80, as a client would arrive. */
async function serves(host: string): Promise<boolean> {
  const res = await fetch('http://127.0.0.1/', { headers: { host }, redirect: 'manual' });
  return res.status === 200;
}

async function addHost(replica: Replica, domain: string): Promise<void> {
  const started = Date.now();
  const res = await api(replica, 'POST', '/api/v1/proxy-hosts', {
    name: domain,
    domains: [domain],
    upstreams: [`${ORIGIN}:8080`],
    sslForced: false,
  });
  check(
    res.status === 201,
    `${replica} saves a host and applies it`,
    `${res.status} after ${Date.now() - started}ms: ${res.text}`,
  );
  const errorId = /"errorId":"([0-9a-f-]+)"/.exec(res.text)?.[1];
  if (errorId) {
    // The log is gone once the stack is torn down, so say what it held now.
    const lines = log(replica).split('\n');
    const at = lines.findIndex((line) => line.includes(errorId));
    console.log(lines.slice(Math.max(0, at - 30), at + 10).join('\n'));
    const agent = sh(['docker', 'logs', '-t', 'caddy-proxy-manager-agent'], { allowFail: true });
    console.log(`── agent ──\n${agent.output.split('\n').slice(-25).join('\n')}`);
    console.log(`── holder per the database: ${holder()} ──`);
  }
  check(
    await until(`${domain} to serve`, () => serves(domain), 60_000).catch(() => false),
    `${domain}, saved through ${replica}, serves through Caddy`,
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
  sh(['docker', 'build', '-q', '-f', 'docker/web/Dockerfile', '-t', IMAGES.web, '.']);
  sh([
    'docker',
    'build',
    '-q',
    '-f',
    'docker/agent/Dockerfile',
    '--build-arg',
    'PUID=10002',
    '--build-arg',
    'PGID=10002',
    '-t',
    IMAGES.agent,
    '.',
  ]);
  sh(['docker', 'build', '-q', '-t', IMAGES.backend, 'docker-tests/images/backend']);
  if (!sh(['docker', 'image', 'inspect', CADDY_IMAGE], { allowFail: true }).ok) {
    sh(['docker', 'pull', CADDY_IMAGE]);
  }
}

async function bothUp(): Promise<void> {
  console.log('\nTwo controllers, one agent');
  compose([
    'up',
    '-d',
    '--no-build',
    '--wait',
    '--wait-timeout',
    '240',
    'web',
    'web-b',
    'haproxy',
    'agent',
  ]);
  await until(
    'the agent to pair and start Caddy',
    () =>
      sh(['docker', 'inspect', '-f', '{{.State.Running}}', CADDY], { allowFail: true }).output ===
      'true',
    240_000,
  );
  sh([
    'docker',
    'run',
    '-d',
    '--rm',
    '--name',
    ORIGIN,
    '--network',
    `${PROJECT}_caddy-network`,
    IMAGES.backend,
    'http',
    '8080',
  ]);

  const replicas = await until('both replicas to register', () => {
    const rows = sql(
      `select hostname from controller_replicas where "heartbeatAt" > (extract(epoch from now()) * 1000 - 30000) order by hostname`,
    );
    return rows === 'web-a\nweb-b' ? rows : null;
  });
  check(replicas === 'web-a\nweb-b', 'both replicas are registered and beating');

  const leaders = (['web-a', 'web-b'] as const).filter((replica) =>
    log(replica).includes('This replica now runs the background jobs'),
  );
  check(leaders.length === 1, 'exactly one replica runs the background jobs', leaders.join(', '));

  const held = await until('the agent to attach', holder);
  check(held !== null, `the agent's stream is held by ${held}`);
  console.log(`    (stream on ${held}, leader ${leaders.join(', ')})`);

  await createToken();
  for (const replica of ['web-a', 'web-b'] as const) {
    const res = await api(replica, 'GET', '/api/v1/proxy-hosts');
    check(res.status === 200, `${replica} accepts the token made through the other`, res.text);
  }
}

async function routing(): Promise<void> {
  console.log('\nWork for the agent, sent to either replica');
  const held = holder() as Replica;
  await addHost(other(held), 'through-other.test');
  await addHost(held, 'through-holder.test');
  const apply = await api(other(held), 'POST', '/api/v1/caddy/apply');
  check(
    apply.status === 200,
    `${other(held)} reloads Caddy through ${held}`,
    `${apply.status} ${apply.text}`,
  );
}

async function settingsPropagate(): Promise<void> {
  console.log('\nA setting saved on one replica');
  const [a, b] = ['web-a', 'web-b'] as const;
  const before = JSON.parse((await api(b, 'GET', '/api/v1/settings/general')).text) as Record<
    string,
    unknown
  >;
  const name = `ha-${Date.now()}.test`;
  // General settings apply to Caddy as well, so this also crosses to the agent's replica.
  const saved = await api(a, 'PUT', '/api/v1/settings/general', { ...before, defaultDomain: name });
  check(saved.status === 200, 'web-a saves it', `${saved.status} ${saved.text}`);
  const seen = await until(
    'web-b to read it',
    async () => (await api(b, 'GET', '/api/v1/settings/general')).text.includes(name),
    10_000,
  ).catch(() => false);
  check(seen, 'web-b reads the new value without a restart');
}

async function failover(): Promise<void> {
  console.log('\nThe replica holding the stream goes away');
  const held = holder() as Replica;
  const survivor = other(held);
  const stopping = Date.now();
  sh(['docker', 'stop', REPLICAS[held].container]);
  // Docker kills at 10s: lingering until then, a replica that left the cluster still took requests.
  const stopMs = Date.now() - stopping;
  check(stopMs < 8_000, `${held} exits on SIGTERM rather than waiting to be killed`, `${stopMs}ms`);
  const moved = await until(
    'the agent to reattach',
    () => (holder() === survivor ? survivor : null),
    120_000,
  ).catch(() => null);
  check(moved === survivor, `the agent reattaches through HAProxy to ${survivor}`);
  check(
    await until(
      `${survivor} to lead`,
      () => log(survivor).includes('This replica now runs the background jobs'),
      60_000,
    ).catch(() => false),
    `${survivor} runs the background jobs`,
  );
  await addHost(survivor, 'after-failover.test');
  check(await serves('through-other.test'), 'hosts saved before the failover still serve');

  console.log('\nIt comes back');
  sh(['docker', 'start', REPLICAS[held].container]);
  await until(
    `${held} to be healthy`,
    async () => (await fetch(`${REPLICAS[held].url}/api/health`)).ok,
    180_000,
  );
  check(
    log(held).includes('Joining 1 running controller replica(s)'),
    `${held} joins the running replica`,
  );
  check(holder() === survivor, `the stream stays on ${survivor}`);
  await addHost(held, 'after-return.test');
}

async function withoutAgent(): Promise<void> {
  console.log('\nNo agent connected');
  sh(['docker', 'stop', 'caddy-proxy-manager-agent']);
  await until('the stream to close', () => (holder() === null ? true : null), 60_000);
  const before = sh(['docker', 'exec', CADDY, 'wget', '-qO-', 'http://caddy-admin:2019/config/'], {
    allowFail: true,
  }).output;
  const apply = await api('web-a', 'POST', '/api/v1/caddy/apply');
  check(
    apply.status !== 200,
    'a replica refuses to configure Caddy directly',
    `${apply.status} ${apply.text}`,
  );
  const after = sh(['docker', 'exec', CADDY, 'wget', '-qO-', 'http://caddy-admin:2019/config/'], {
    allowFail: true,
  }).output;
  check(before === after, "and Caddy's config is untouched");

  sh(['docker', 'start', 'caddy-proxy-manager-agent']);
  await until('the agent to reattach', () => holder(), 120_000);
  await addHost('web-a', 'agent-back.test');
}

async function main(): Promise<void> {
  preflight();
  if (argv.build) build();
  try {
    await bothUp();
    await routing();
    await settingsPropagate();
    await failover();
    await withoutAgent();
  } catch (error) {
    failures.push(String(error));
    console.error(error);
    for (const replica of ['web-a', 'web-b'] as const) {
      console.error(`\n── ${replica} ──\n${log(replica).slice(-4000)}`);
    }
    console.error(
      `\n── agent ──\n${sh(['docker', 'logs', 'caddy-proxy-manager-agent'], { allowFail: true }).output.slice(-4000)}`,
    );
  } finally {
    if (!argv.keep) {
      sh(['docker', 'rm', '-f', ORIGIN], { allowFail: true });
      compose(
        [
          '--profile',
          'caddy',
          '--profile',
          'clickhouse',
          '--profile',
          'crowdsec',
          'down',
          '-v',
          '--remove-orphans',
        ],
        { allowFail: true },
      );
    }
  }
  console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed.`);
  process.exit(failures.length === 0 ? 0 : 1);
}

await main();
