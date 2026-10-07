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

async function graphql(replica: Replica, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(`${REPLICAS[replica].url}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] };
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data ?? {};
}

/** Only since the container last started: a restarted replica's log still holds its old lead. */
function currentLog(replica: Replica): string {
  const { container } = REPLICAS[replica];
  const started = sh(['docker', 'inspect', '-f', '{{.State.StartedAt}}', container], {
    allowFail: true,
  }).output;
  return sh(['docker', 'logs', '--since', started, container], { allowFail: true }).output;
}

function leads(replica: Replica): boolean {
  const text = currentLog(replica);
  return text.lastIndexOf('now runs the background jobs') > text.lastIndexOf('no longer runs');
}

/** Whichever replica's log last says it took the background jobs. */
function leader(): Replica | null {
  const held = (['web-a', 'web-b'] as const).filter(leads);
  return held.length === 1 ? held[0] : null;
}

async function backupSlotSurvivesLeaderLoss(): Promise<void> {
  console.log('\nThe leader dies just before a backup is due');
  const writer = leader();
  check(writer !== null, 'one replica leads', String(writer));
  if (!writer) return;
  const survivor = other(writer);
  const created = (await graphql(
    survivor,
    `mutation ($d: BackupDestinationInput!) { createBackupDestination(input: $d) { id } }`,
    { d: { name: 'ha-local', kind: 'local', path: 'ha' } },
  )) as { createBackupDestination: { id: number } };
  const schedule = (await graphql(
    survivor,
    `mutation ($s: BackupScheduleInput!) { createBackupSchedule(input: $s) { id } }`,
    {
      s: {
        name: 'ha-every-minute',
        destinationId: created.createBackupDestination.id,
        cron: '* * * * *',
        timeZone: 'UTC',
        passphrase: 'ha scheduled passphrase',
      },
    },
  )) as { createBackupSchedule: { id: number } };
  const id = schedule.createBackupSchedule.id;

  // Two seconds before a minute turns: the leader dies holding the cron job for that slot.
  const untilEdge = 60_000 - (Date.now() % 60_000);
  await Bun.sleep(untilEdge < 8_000 ? untilEdge + 58_000 : untilEdge - 2_000);
  const slot = Math.ceil(Date.now() / 60_000) * 60_000;
  sh(['docker', 'kill', REPLICAS[writer].container]);
  check(
    // The dead one's log still ends in its own takeover, so only the survivor's is read.
    await until(`${survivor} to lead`, () => (leads(survivor) ? true : null), 90_000).catch(
      () => false,
    ),
    `${survivor} takes the background jobs over`,
  );
  const runs = await until(
    'the slot to be run',
    () => {
      const rows = sql(
        `select status from backup_runs where "scheduleId" = ${id} and slot = ${slot}`,
      );
      return rows && rows !== 'running' ? rows : null;
    },
    120_000,
  ).catch(() => '');
  check(runs === 'succeeded', 'the slot the dead leader owned is run exactly once', runs);
  const ranOn = sql(
    `select r.hostname from backup_runs b join controller_replicas r on r.id = b.replica where b."scheduleId" = ${id} and b.slot = ${slot}`,
  );
  check(ranOn === survivor, `and ${survivor} ran it`, ranOn);
  // A leader starting late catches up a slot; one starting early fires it: never both.
  const doubles = sql(
    `select count(*) from (select slot from backup_runs where "scheduleId" = ${id} group by slot having count(*) > 1) d`,
  );
  check(doubles === '0', 'no slot has two runs', doubles);

  await graphql(survivor, 'mutation ($id: Int!) { deleteBackupSchedule(id: $id) }', { id });
  sh(['docker', 'start', REPLICAS[writer].container]);
  await until(
    `${writer} to be healthy`,
    async () => (await fetch(`${REPLICAS[writer].url}/api/health`)).ok,
    180_000,
  );
}

/** POSTs the origin logged at a path, by webhook-id; read through Caddy, which shares its network. */
function received(path: string): string[] {
  const out = sh(['docker', 'exec', CADDY, 'wget', '-qO-', `http://${ORIGIN}:8080/__requests`], {
    allowFail: true,
  }).output;
  try {
    const rows = JSON.parse(out) as {
      method: string;
      raw_path: string;
      headers: Record<string, string>;
    }[];
    return rows
      .filter((row) => row.method === 'POST' && row.raw_path === path)
      .map((row) => row.headers['webhook-id'] ?? '');
  } catch {
    return [];
  }
}

async function alertsSurviveLeaderLoss(): Promise<void> {
  console.log('\nThe leader dies with an alert queued and a digest due');
  // The replica the last scenario restarted may still be joining.
  const writer = await until('one replica to lead', () => leader(), 60_000).catch(() => null);
  check(writer !== null, 'one replica leads', String(writer));
  if (!writer) return;
  const survivor = other(writer);
  // Far enough from a minute's turn to set everything up before it.
  const untilStart = 60_000 - (Date.now() % 60_000);
  if (untilStart < 50_000) await Bun.sleep(untilStart + 1_000);
  const slot = Math.ceil(Date.now() / 60_000) * 60_000;
  const hhmm = new Date(slot).toISOString().slice(11, 16);
  const channel = async (name: string, path: string) =>
    (
      (await graphql(
        survivor,
        `mutation ($c: AlertChannelInput!) { createAlertChannel(input: $c) { id } }`,
        { c: { name, kind: 'webhook', url: `http://${ORIGIN}:8080${path}` } },
      )) as { createAlertChannel: { id: number } }
    ).createAlertChannel.id;
  const alertChannel = await channel('ha-alerts', '/ha-alert');
  const digestChannel = await channel('ha-digest', '/ha-digest');
  const rule = (
    (await graphql(
      survivor,
      `mutation ($r: AlertRuleInput!) { createAlertRule(input: $r) { id } }`,
      {
        r: {
          name: 'ha-rule',
          source: 'event',
          kinds: ['agentOffline'],
          channelIds: [alertChannel],
        },
      },
    )) as { createAlertRule: { id: number } }
  ).createAlertRule.id;
  const digest = (
    (await graphql(
      survivor,
      `mutation ($d: AlertDigestInput!) { createAlertDigest(input: $d) { id } }`,
      { d: { name: 'ha-digest', time: hhmm, timeZone: 'UTC', channelIds: [digestChannel] } },
    )) as { createAlertDigest: { id: number } }
  ).createAlertDigest.id;
  // Queued now, due a minute later: after the leader is gone.
  const eventId = (
    (await graphql(survivor, 'mutation ($id: Int!) { testAlertRule(id: $id) }', { id: rule })) as {
      testAlertRule: number;
    }
  ).testAlertRule;
  check(eventId > 0, 'a test alert is queued through the rule', String(eventId));

  await Bun.sleep(Math.max(0, slot - 2_000 - Date.now()));
  sh(['docker', 'kill', REPLICAS[writer].container]);
  check(
    await until(`${survivor} to lead`, () => (leads(survivor) ? true : null), 90_000).catch(
      () => false,
    ),
    `${survivor} takes the alerts over`,
  );

  const sent = await until(
    'the alert to be sent',
    () => {
      const status = sql(`select status from alert_deliveries where "eventId" = ${eventId}`);
      return status === 'sent' ? status : null;
    },
    180_000,
  ).catch(() => '');
  check(sent === 'sent', 'the queued alert is sent', sent);
  await Bun.sleep(5_000);
  const alertPosts = received('/ha-alert');
  check(alertPosts.length === 1, 'and the receiver got it exactly once', alertPosts.join(','));

  const run = await until(
    'the digest slot to be sent',
    () => {
      const status = sql(
        `select status from alert_digest_runs where "digestId" = ${digest} and slot = ${slot}`,
      );
      return status && status !== 'running' ? status : null;
    },
    180_000,
  ).catch(() => '');
  check(run === 'sent', 'the digest the dead leader owed is sent', run);
  const runs = sql(`select count(*) from alert_digest_runs where "digestId" = ${digest}`);
  check(runs === '1', 'one run for the slot', runs);
  await Bun.sleep(5_000);
  const digestPosts = received('/ha-digest');
  check(digestPosts.length === 1, 'and one digest reached the receiver', digestPosts.join(','));

  await graphql(survivor, 'mutation ($id: Int!) { deleteAlertDigest(id: $id) }', { id: digest });
  await graphql(survivor, 'mutation ($id: Int!) { deleteAlertRule(id: $id) }', { id: rule });
  sh(['docker', 'start', REPLICAS[writer].container]);
  await until(
    `${writer} to be healthy`,
    async () => (await fetch(`${REPLICAS[writer].url}/api/health`)).ok,
    180_000,
  );
}

/**
 * Every audit record the file sink received, in the order written. Read through a replica, since
 * both share the data volume; the origin's request log keeps no bodies.
 */
function streamed(through: Replica): { seq: number; prevHash: string; hash: string }[] {
  const out = sh(
    ['docker', 'exec', REPLICAS[through].container, 'cat', '/app/data/audit-stream/ha.jsonl'],
    { allowFail: true },
  ).output;
  return out
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((record) => record.kind === 'audit');
}

async function auditStreamSurvivesLeaderLoss(): Promise<void> {
  console.log('\nThe leader dies while streaming the audit log');
  const writer = await until('one replica to lead', () => leader(), 60_000).catch(() => null);
  check(writer !== null, 'one replica leads', String(writer));
  if (!writer) return;
  const survivor = other(writer);
  const sink = (
    (await graphql(
      survivor,
      `mutation ($s: AuditSinkInput!) { createAuditSink(input: $s) { id } }`,
      { s: { name: 'ha-sink', kind: 'file', fileName: 'ha.jsonl' } },
    )) as { createAuditSink: { id: number } }
  ).createAuditSink.id;
  // Each Verify is an audit event, written through either replica.
  const verify = async (replica: Replica, times: number) => {
    for (let i = 0; i < times; i++) await graphql(replica, 'mutation { verifyAuditChain { ok } }');
  };
  await verify(survivor, 10);
  await until(
    'the first records to arrive',
    () => (streamed(survivor).length > 0 ? true : null),
    60_000,
  );
  await verify(survivor, 10);
  sh(['docker', 'kill', REPLICAS[writer].container]);
  check(
    await until(`${survivor} to lead`, () => (leads(survivor) ? true : null), 90_000).catch(
      () => false,
    ),
    `${survivor} takes the streaming over`,
  );
  await verify(survivor, 10);
  const head = Number(sql('select max(seq) from audit_events'));
  const arrived = await until(
    'the receiver to reach the head of the log',
    () => {
      const records = streamed(survivor);
      return records.some((record) => record.seq === head) ? records : null;
    },
    120_000,
  ).catch(() => streamed(survivor));
  const unique = new Map(arrived.map((record) => [record.seq, record]));
  const seqs = [...unique.keys()].sort((a, b) => a - b);
  const contiguous = seqs.every((seq, i) => i === 0 || seq === seqs[i - 1] + 1);
  check(
    seqs.at(-1) === head && contiguous,
    'no record is skipped',
    `${seqs.length} up to ${seqs.at(-1)} of ${head}`,
  );
  const linked = seqs.every(
    (seq, i) => i === 0 || unique.get(seq)?.prevHash === unique.get(seqs[i - 1])?.hash,
  );
  check(linked, 'every record links to the one before it');
  // At least once allows the batch in flight to come again, never the stream over.
  const repeats = arrived.length - unique.size;
  check(repeats <= 200, 'a flip repeats at most one batch', `${repeats} repeated`);

  await graphql(survivor, 'mutation ($id: Int!) { deleteAuditSink(id: $id) }', { id: sink });
  sh(['docker', 'start', REPLICAS[writer].container]);
  await until(
    `${writer} to be healthy`,
    async () => (await fetch(`${REPLICAS[writer].url}/api/health`)).ok,
    180_000,
  );
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
    await backupSlotSurvivesLeaderLoss();
    await alertsSurviveLeaderLoss();
    await auditStreamSurvivesLeaderLoss();
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
