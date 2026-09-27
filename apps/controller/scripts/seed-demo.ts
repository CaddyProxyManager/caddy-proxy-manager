/**
 *   DEMO_MODE=true DATABASE_URL=... bun scripts/seed-demo.ts [--reset]
 *
 * Through the models, so rows match what the UI writes. DEMO_MODE is required: each host create
 * applies, and `installDemoCaddy` keeps that in memory instead of hitting a real Caddy.
 */
import { eq, ne } from "drizzle-orm";

if (process.env.DEMO_MODE?.trim().toLowerCase() !== "true") {
  console.error("Refusing to seed: DEMO_MODE is not true. This writes invented data.");
  process.exit(1);
}

const RESET = process.argv.includes("--reset");

const db = (await import("../src/lib/db")).default;
const { installDemoCaddy } = await import("../src/lib/demo/start");
const schema = await import("../src/lib/db/schema");
const { createProxyHost } = await import("../src/lib/models/proxy-hosts");
const { createL4ProxyHost } = await import("../src/lib/models/l4-proxy-hosts");
const { createAccessList } = await import("../src/lib/models/access-lists");
const { createCertificate } = await import("../src/lib/models/certificates");
const { createGroup, addGroupMember } = await import("../src/lib/models/groups");
const { createUser } = await import("../src/lib/models/user");

installDemoCaddy();

/** Everything seeded is attributed to the owner, as the UI would. */
async function actorId(): Promise<number> {
  // As the app's first start would, so `bun run demo` can seed before the server exists.
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    await (await import("../src/lib/init-db")).ensureAdminUser();
  }
  const [admin] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "admin"))
    .limit(1);
  if (!admin) {
    console.error("No administrator in this database. Start the app once and finish setup first.");
    process.exit(1);
  }
  return admin.id;
}

/** In foreign-key order. The administrator survives: it is the account you sign in with. */
async function reset(actor: number): Promise<void> {
  await db.delete(schema.proxyHosts);
  await db.delete(schema.l4ProxyHosts);
  await db.delete(schema.accessLists);
  await db.delete(schema.certificates);
  await db.delete(schema.groups);
  await db.delete(schema.users).where(ne(schema.users.id, actor));
  await db.delete(schema.auditEvents);
  console.log("Cleared the previous demo data");
}

// ── People ──────────────────────────────────────────────────────────────────

const PEOPLE = [
  { name: "Priya Raman", email: "priya@example.com", role: "admin", group: "Platform" },
  { name: "Tomas Berg", email: "tomas@example.com", role: "operator", group: "Platform" },
  { name: "Dana Okafor", email: "dana@example.com", role: "operator", group: "Support" },
  { name: "Kit Marlowe", email: "kit@example.com", role: "user", group: "Support" },
  { name: "Sam Ellery", email: "sam@example.com", role: "viewer", group: null },
] as const;

async function seedPeople(actor: number): Promise<void> {
  const groups = new Map<string, number>();
  for (const [name, description] of [
    ["Platform", "Runs the proxy and the hosts behind it"],
    ["Support", "Reads the logs and answers for the services"],
  ] as const) {
    groups.set(name, (await createGroup({ name, description }, actor)).id);
  }

  for (const person of PEOPLE) {
    // No password: these only populate lists and own things.
    const user = await createUser({
      email: person.email,
      name: person.name,
      role: person.role,
      provider: "credentials",
      subject: person.email,
    });
    const group = person.group ? groups.get(person.group) : undefined;
    if (group) await addGroupMember(group, user.id, actor);
  }
  console.log(`Seeded ${PEOPLE.length} people in ${groups.size} groups`);
}

// ── What the deployment serves ──────────────────────────────────────────────

type HostSpec = {
  name: string;
  domain: string;
  upstream: string;
  /** Behind the shared certificate, which covers *.example.com. */
  wildcard?: boolean;
  accessList?: string;
  enabled?: boolean;
  websocket?: boolean;
};

const HOSTS: HostSpec[] = [
  {
    name: "Jellyfin",
    domain: "jellyfin.example.com",
    upstream: "http://10.0.3.12:8096",
  },
  { name: "Immich", domain: "photos.example.com", upstream: "http://10.0.3.13:2283" },
  { name: "Nextcloud", domain: "cloud.example.com", upstream: "http://10.0.3.14:8080" },
  { name: "Grafana", domain: "grafana.example.com", upstream: "http://10.0.3.11:3000" },
  {
    name: "Home Assistant",
    domain: "home.example.com",
    upstream: "http://10.0.3.16:8123",
    wildcard: true,
  },
  {
    name: "Gitea",
    domain: "git.example.com",
    upstream: "http://10.0.3.15:3000",
    wildcard: true,
  },
  {
    name: "Vaultwarden",
    domain: "vault.example.com",
    upstream: "http://10.0.3.17:80",
    accessList: "Staff only",
  },
  {
    name: "Uptime Kuma",
    domain: "status.example.com",
    upstream: "http://10.0.3.19:3001",
  },
  {
    name: "Paperless",
    domain: "paperless.example.com",
    upstream: "http://10.0.3.18:8000",
    accessList: "Staff only",
  },
  {
    name: "n8n (staging)",
    domain: "n8n.example.com",
    upstream: "http://10.0.3.20:5678",
    enabled: false,
  },
];

async function seedHosts(actor: number): Promise<string[]> {
  const staffOnly = await createAccessList(
    {
      name: "Staff only",
      description: "Basic auth in front of the things that hold secrets",
      users: [
        { username: "priya", password: "demo-password-1" },
        { username: "tomas", password: "demo-password-2" },
      ],
    },
    actor,
  );

  const wildcard = await createCertificate(
    {
      name: "example.com wildcard",
      type: "managed",
      domainNames: ["*.example.com", "example.com"],
      autoRenew: true,
    },
    actor,
  );

  for (const host of HOSTS) {
    await createProxyHost(
      {
        name: host.name,
        domains: [host.domain],
        upstreams: [host.upstream],
        certificateId: host.wildcard ? wildcard.id : null,
        accessListId: host.accessList ? staffOnly.id : null,
        sslForced: true,
        hstsEnabled: true,
        allowWebsocket: host.websocket ?? true,
        preserveHostHeader: true,
        enabled: host.enabled ?? true,
      },
      actor,
    );
  }

  await createL4ProxyHost(
    {
      name: "PostgreSQL (read replica)",
      protocol: "tcp",
      listenAddress: ":5432",
      upstreams: ["10.0.3.30:5432"],
    },
    actor,
  );
  await createL4ProxyHost(
    {
      name: "Minecraft",
      protocol: "tcp",
      listenAddress: ":25565",
      upstreams: ["10.0.3.31:25565"],
    },
    actor,
  );

  console.log(`Seeded ${HOSTS.length} proxy hosts, 2 L4 hosts, 1 access list, 1 certificate`);
  // A disabled host has no traffic.
  return HOSTS.filter((host) => host.enabled !== false).map((host) => host.domain);
}

// ── A month of traffic ──────────────────────────────────────────────────────

const DAYS = 30;

async function seedTraffic(domains: string[]): Promise<void> {
  const { clearAnalyticsEvents, initClickHouse, isAnalyticsEnabled } = await import(
    "../src/lib/clickhouse/client"
  );
  const { trafficShares, writeDemoTraffic } = await import("../src/lib/demo/traffic");
  if (!(await isAnalyticsEnabled())) {
    console.log("Analytics are off, so no traffic was written.");
    return;
  }
  await initClickHouse();
  // Not incremental: a second run would double the traffic.
  if (RESET) await clearAnalyticsEvents();

  const now = Math.floor(Date.now() / 1000);
  const written = await writeDemoTraffic(now - DAYS * 86400, now, trafficShares(domains));
  console.log(
    `Seeded ${written.traffic} traffic events and ${written.waf} WAF events over ${DAYS} days`,
  );
}

/** Also makes the simulated agent report an access log; stores a ClickHouse from env if any. */
async function enableAnalytics(): Promise<void> {
  const registry = await import("../src/lib/settings/registry");
  const { saveSettings } = await import("../src/lib/settings/resolve");
  const password = process.env.CLICKHOUSE_PASSWORD?.trim();
  if (!password) {
    await saveSettings({ [registry.analyticsEnabled.key]: true });
    return;
  }
  await saveSettings({
    [registry.analyticsEnabled.key]: true,
    [registry.clickhouseUrl.key]: process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:18123",
    [registry.clickhouseUser.key]: process.env.CLICKHOUSE_USER ?? "cpm",
    [registry.clickhousePassword.key]: password,
    [registry.clickhouseDb.key]: process.env.CLICKHOUSE_DB ?? "analytics",
  });
}

const actor = await actorId();
if (RESET) await reset(actor);

await seedPeople(actor);
const hosts = await seedHosts(actor);

await enableAnalytics();
await seedTraffic(hosts);

console.log("Demo data ready.");
process.exit(0);
