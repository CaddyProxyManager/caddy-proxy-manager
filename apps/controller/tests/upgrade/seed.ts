/**
 * The upgrade harness's first half. ./run.ts starts it with cwd set to the OLDER checkout's
 * apps/controller, and every app module is imported from there, so the rows are the ones that
 * version's own models write. Only this file and ./snapshot.ts come from this checkout.
 *
 * Writes into UPGRADE_OUT: tables.json, document.json and backup.cpmbak.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { symmetricEncrypt } from 'better-auth/crypto';
import { createSelfSignedServerCertificate } from '../helpers/certs';
import { rawQuery, snapshotTables } from './snapshot';

const root = process.cwd();
const out = process.env.UPGRADE_OUT;
if (!out) throw new Error('UPGRADE_OUT is not set; run tests/upgrade/run.ts');
mkdirSync(out, { recursive: true });

// Typed loosely on purpose: these are another version's modules.
const load = (path: string): Promise<any> => import(resolve(root, 'src/lib', path));

const { default: db, client } = await load('db.ts');
const schema = await load('db/schema.ts');
const { installDemoCaddy } = await load('demo/start.ts');
// Every model applies on write; this keeps that in memory instead of dialing a Caddy.
installDemoCaddy();

// The previous version's own startup, so the rows below land on a database it has booted.
await (await import(resolve(root, 'src/instrumentation.ts'))).register();

const [admin] = await rawQuery(client, "SELECT id FROM users WHERE role = 'admin'");
if (!admin) throw new Error('The previous version did not seed its administrator');
const actor = Number(admin.id);

const { createUser } = await load('models/user.ts');
const { createGroup, addGroupMember } = await load('models/groups.ts');
const { createApiToken } = await load('models/api-tokens.ts');
const { insertPairedAgent } = await load('models/agents.ts');
const { createCertificate } = await load('models/certificates.ts');
const { createAccessList, setAccessListIpRules } = await load('models/access-lists.ts');
const { createProxyHost } = await load('models/proxy-hosts.ts');
const { createL4ProxyHost } = await load('models/l4-proxy-hosts.ts');
const { createOAuthProvider } = await load('models/oauth-providers.ts');
const { createAuditEvent } = await load('models/audit.ts');
const settingsModule = await load('settings.ts');
const { saveSettings } = await load('settings/resolve.ts');
const { config } = await load('config.ts');

// ── People ──────────────────────────────────────────────────────────────────

const operator = await createUser({
  email: 'ops@example.com',
  name: 'Olga Operator',
  role: 'operator',
  provider: 'credentials',
  subject: 'ops@example.com',
  passwordHash: await Bun.password.hash('operator-password-1', { algorithm: 'argon2id' }),
});
const viewer = await createUser({
  email: 'viewer@example.com',
  name: 'Vic Viewer',
  role: 'viewer',
  provider: 'credentials',
  subject: 'viewer@example.com',
});
// As Better Auth's two-factor plugin stores them: encrypted with the auth secret.
const now = new Date().toISOString();
await db.insert(schema.twoFactors).values({
  userId: operator.id,
  secret: await symmetricEncrypt({ key: config.sessionSecret, data: 'JBSWY3DPEHPK3PXP' }),
  backupCodes: await symmetricEncrypt({
    key: config.sessionSecret,
    data: JSON.stringify(['aaaa-1111', 'bbbb-2222']),
  }),
  verified: true,
});
await rawQuery(client, `UPDATE users SET "twoFactorEnabled" = TRUE WHERE id = ${operator.id}`);

const platform = await createGroup({ name: 'Platform', description: 'Runs the proxy' }, actor);
await addGroupMember(platform.id, operator.id, actor);
await addGroupMember(platform.id, viewer.id, actor);
await createApiToken('ci deploys', actor);

const [agentRow] = [
  await insertPairedAgent({ name: 'edge-1', agentId: 'agent-edge-1', secret: 'agent-secret-1' }),
];

// ── Certificates ────────────────────────────────────────────────────────────

const pair = createSelfSignedServerCertificate('app.example.com', ['app.example.com']);
const imported = await createCertificate(
  {
    name: 'App (imported)',
    type: 'imported',
    domainNames: ['app.example.com'],
    certificatePem: pair.certificatePem,
    privateKeyPem: pair.privateKeyPem,
  },
  actor,
);
const managed = await createCertificate(
  { name: 'Wildcard', type: 'managed', domainNames: ['*.corp.example.com'], autoRenew: true },
  actor,
);

// ── Access lists ────────────────────────────────────────────────────────────

const office = await createAccessList(
  {
    name: 'Office',
    description: 'HQ and the VPN',
    users: [
      { username: 'alice', password: 'alice-password-1' },
      { username: 'bob', password: 'bob-password-1' },
    ],
    ipRules: [
      { action: 'deny', cidr: '203.0.113.66', note: 'Lobby kiosk' },
      { action: 'allow', cidr: '203.0.113.0/24', note: 'HQ' },
      { action: 'allow', cidr: '2001:db8:10::/48', note: 'HQ over IPv6' },
      { action: 'allow', cidr: '198.51.100.7' },
      { action: 'deny', cidr: '2001:db8:10:66::/64', note: 'Guest Wi-Fi, below its own allow' },
    ],
    ipDefault: 'deny',
    satisfy: 'any',
  },
  actor,
);
const admins = await createAccessList(
  {
    name: 'Admins',
    users: [{ username: 'root', password: 'root-password-1' }],
    ipRules: [
      { action: 'allow', cidr: '10.0.0.0/8', note: 'Management network' },
      { action: 'allow', cidr: 'fd00::/8' },
    ],
    ipDefault: 'deny',
    satisfy: 'all',
    passAuth: true,
  },
  actor,
);
const blocklist = await createAccessList(
  { name: 'Blocklist', ipRules: [], ipDefault: 'allow', satisfy: 'any' },
  actor,
);
// Written a second time, so the rule ids no longer start where the list's first ones did.
await setAccessListIpRules(
  blocklist.id,
  [
    { action: 'deny', cidr: '192.0.2.0/24', note: 'Scanner' },
    { action: 'deny', cidr: '2001:db8:bad::/48', note: 'Scanner v6' },
    { action: 'allow', cidr: '192.0.2.10', note: 'Except the monitor' },
  ],
  actor,
);

// ── Settings ────────────────────────────────────────────────────────────────

await settingsModule.saveGeneralSettings({
  defaultDomain: 'example.com',
  acmeEmail: 'certs@example.com',
});
await settingsModule.saveTrustedProxiesSettings({ ranges: ['10.0.0.0/8'], strict: false });
await settingsModule.saveDnsProviderSettings({
  providers: { cloudflare: { api_token: 'cf-token-123' } },
  default: 'cloudflare',
});
await settingsModule.saveWafSettings({
  enabled: false,
  mode: 'On',
  load_owasp_crs: true,
  custom_directives: '',
});
await saveSettings({
  'config:app_name': 'Upgrade Lab',
  'config:smtp_host': 'smtp.example.com',
  'config:smtp_password': 'smtp-secret-1',
});

// ── Hosts ───────────────────────────────────────────────────────────────────

const geoblock = {
  enabled: true,
  block_countries: ['RU'],
  block_continents: [],
  block_asns: [64512],
  block_cidrs: ['192.0.2.0/24'],
  block_ips: [],
  allow_countries: [],
  allow_continents: [],
  allow_asns: [],
  allow_cidrs: [],
  allow_ips: ['192.0.2.10'],
  trusted_proxies: [],
  fail_closed: false,
  response_status: 403,
  response_body: 'Forbidden',
  response_headers: {},
  redirect_url: '',
};

await createProxyHost(
  {
    name: 'App',
    description: 'The public app',
    domains: ['app.example.com'],
    upstreams: ['http://10.0.1.10:8080', 'http://10.0.1.11:8080'],
    certificateId: imported.id,
    accessListId: office.id,
    hstsEnabled: true,
    allowWebsocket: true,
    loadBalancer: { enabled: true, policy: 'round_robin', retries: 2 },
    redirects: [{ from: '/old', to: '/new', status: 301 }],
  },
  actor,
);
await createProxyHost(
  {
    name: 'Admin console',
    domains: ['admin.corp.example.com'],
    upstreams: ['http://10.0.2.10:9000'],
    certificateId: managed.id,
    accessListId: admins.id,
    locationRules: [
      { path: '/api/*', upstreams: ['10.0.2.11:9001'] },
      { path: '/public/*', upstreams: ['10.0.2.12:9002'], accessListId: null },
      { path: '/audit/*', upstreams: ['10.0.2.13:9003'], accessListId: blocklist.id },
    ],
  },
  actor,
);
await createProxyHost(
  {
    name: 'Shop',
    domains: ['shop.example.com', 'www.shop.example.com'],
    upstreams: ['http://10.0.3.10:3000'],
    accessListId: blocklist.id,
    geoblock,
    geoblockMode: 'override',
    waf: { enabled: true, mode: 'On', load_owasp_crs: true, waf_mode: 'override' },
    pathBlocks: [{ path: '/wp-admin/*', status: 404 }],
  },
  actor,
);
await createProxyHost(
  {
    name: 'Edge only',
    domains: ['edge.example.com'],
    upstreams: ['http://10.0.4.10:80'],
    agentIds: [agentRow.id],
  },
  actor,
);
await createProxyHost(
  {
    name: 'Parked',
    domains: ['parked.example.com'],
    upstreams: ['http://10.0.5.10:80'],
    enabled: false,
  },
  actor,
);

await createL4ProxyHost(
  {
    name: 'SSH bastion',
    protocol: 'tcp',
    listenAddress: ':2222',
    upstreams: ['10.0.6.10:22'],
    geoblock: {
      enabled: true,
      block_countries: ['CN'],
      block_continents: [],
      block_asns: [],
      block_cidrs: [],
      block_ips: ['198.51.100.99'],
      allow_countries: [],
      allow_continents: [],
      allow_asns: [],
      allow_cidrs: ['10.0.0.0/8'],
      allow_ips: [],
    },
    geoblockMode: 'override',
  },
  actor,
);
await createL4ProxyHost(
  {
    name: 'DNS',
    protocol: 'udp',
    listenAddress: ':5353',
    upstreams: ['10.0.6.20:53', '10.0.6.21:53'],
    agentIds: [agentRow.id],
  },
  actor,
);
await createL4ProxyHost(
  {
    name: 'Postgres via SNI',
    protocol: 'tcp',
    listenAddress: ':5432',
    upstreams: ['10.0.6.30:5432'],
    matcherType: 'tls_sni',
    matcherValue: ['db.example.com'],
    proxyProtocolVersion: 'v2',
  },
  actor,
);

await createOAuthProvider({
  name: 'Keycloak',
  clientId: 'cpm',
  clientSecret: 'oauth-client-secret-1',
  issuer: 'https://sso.example.com/realms/main',
  autoLink: true,
  groupsClaim: 'roles',
  roleMappingEnabled: true,
  adminGroup: 'cpm-admins',
  syncGroups: true,
});

await createAuditEvent({
  userId: actor,
  action: 'update',
  entityType: 'settings',
  summary: 'Seeded by the upgrade harness',
  data: JSON.stringify({ at: now }),
});

// ── What the next version must reproduce ────────────────────────────────────

const { buildCaddyDocument } = await load('caddy.ts');
const { createBackup } = await load('backup/service.ts');
writeFileSync(resolve(out, 'document.json'), JSON.stringify(await buildCaddyDocument(), null, 2));
writeFileSync(
  resolve(out, 'document-agent.json'),
  JSON.stringify(await buildCaddyDocument(agentRow.id), null, 2),
);
writeFileSync(
  resolve(out, 'backup.cpmbak'),
  await createBackup('upgrade-passphrase', { auditLog: true, settingsHistory: true }),
);
writeFileSync(resolve(out, 'tables.json'), JSON.stringify(await snapshotTables(client), null, 2));
console.log(`[seed] wrote ${out}`);
process.exit(0);
