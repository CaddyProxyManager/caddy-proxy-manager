import { AcmeTab } from "@cpm/controller/src/app/(dashboard)/certificates/components/AcmeTab";
import { DemoSurface } from "../DemoSurface";
import { json, serveApi } from "../fake-api";

const DAY = 24 * 60 * 60 * 1000;
const LETS_ENCRYPT = "acme-v02.api.letsencrypt.org-directory";

const HOSTS = [
  { id: 1, name: "App", domains: ["app.example.com"], sslForced: true, enabled: true },
  {
    id: 2,
    name: "Grafana",
    domains: ["grafana.example.com", "metrics.example.com"],
    sslForced: true,
    enabled: true,
  },
  { id: 3, name: "Status page", domains: ["status.example.com"], sslForced: true, enabled: true },
  { id: 4, name: "Staging", domains: ["staging.example.com"], sslForced: true, enabled: false },
];

/** Relative to the reader's today, so "soon" stays soon; status.example.com has none yet. */
function issued(name: string, daysLeft: number) {
  const notAfter = Date.now() + daysLeft * DAY;
  return {
    issuerKey: LETS_ENCRYPT,
    name,
    names: [name],
    issuer: "Let's Encrypt R11",
    notBefore: new Date(notAfter - 90 * DAY).toISOString(),
    notAfter: new Date(notAfter).toISOString(),
    fingerprint: name,
  };
}

const stored = new Map([
  ["app.example.com", issued("app.example.com", 61)],
  ["grafana.example.com", issued("grafana.example.com", 9)],
  ["metrics.example.com", issued("metrics.example.com", 74)],
  ["staging.example.com", issued("staging.example.com", 33)],
]);

/** Names asked to renew, and when; the next inventory after a few seconds has them renewed. */
const renewing = new Map<string, number>();

const REACHABILITY: Record<number, unknown[]> = {
  1: [{ domain: "app.example.com", addresses: ["203.0.113.10"], caa: [], result: "reached" }],
  2: [
    {
      domain: "grafana.example.com",
      addresses: ["203.0.113.10"],
      caa: ['0 issue "letsencrypt.org"'],
      result: "reached",
    },
    {
      domain: "metrics.example.com",
      addresses: ["198.51.100.7"],
      caa: [],
      result: "otherServer",
      status: 404,
    },
  ],
  3: [{ domain: "status.example.com", addresses: [], caa: [], result: "unresolved" }],
  4: [{ domain: "staging.example.com", addresses: ["203.0.113.10"], caa: [], result: "reached" }],
};

// Registered at import, so the inventory is answered before the tab asks on mount.
if (typeof window !== "undefined") {
  serveApi(async (url, init) => {
    if (url.pathname === "/api/certificates/inventory") {
      for (const [name, since] of renewing) {
        if (Date.now() - since < 4000) continue;
        stored.set(name, issued(name, 90));
        renewing.delete(name);
      }
      return json({
        agents: [{ agentId: "edge-fra", certificates: [...stored.values()] }],
        renewing: [...renewing.keys()],
      });
    }
    if (url.pathname === "/api/certificates/renew") {
      const { names } = JSON.parse(String(init?.body ?? "{}")) as { names: string[] };
      for (const name of names) renewing.set(name, Date.now());
      return json({ ok: true });
    }
    if (url.pathname === "/api/certificates/stored") {
      return json({ error: "There is no controller behind the documentation site." }, 503);
    }
    const reach = /^\/api\/proxy-hosts\/(\d+)\/reachability$/.exec(url.pathname);
    if (reach) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { letsDebug?: string };
      // Asking Let's Debug would send the name to a third party; the demo never does.
      if (body.letsDebug) return json({ letsDebug: { state: "unavailable" } });
      return json({ results: REACHABILITY[Number(reach[1])] ?? [] });
    }
    return null;
  });
}

/** The real ACME tab, with an agent's certificate storage answered in the browser. */
export default function AcmeCertificatesDemo() {
  return (
    <DemoSurface>
      <AcmeTab
        acmeHosts={HOSTS}
        acmePagination={{ total: HOSTS.length, page: 1, perPage: 25 }}
        search=""
        statusFilter={null}
      />
    </DemoSurface>
  );
}
