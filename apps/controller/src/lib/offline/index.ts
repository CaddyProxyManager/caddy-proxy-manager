/**
 * Every network call this deployment makes beyond its own stack, and the offline switch over
 * them. A call to the internet that CPM makes on its own asks `outboundAllowed` first; one that
 * reaches an address an administrator configured, or a service inside the stack, carries an
 * `// outbound: <id>` marker instead. tests/unit/offline/outbound-calls.test.ts finds every call
 * site in apps/controller/src and apps/agent/src and fails on one that is in neither form.
 */

/**
 * `internet`: CPM decides to reach a public service, so offline mode turns it off. `configured`:
 * an administrator named the destination, which an offline network can host itself. `internal`:
 * within the stack.
 */
export type OutboundKind = "internet" | "configured" | "internal";

export const OUTBOUND_CALLS = {
  updateCheck: "internet",
  letsdebug: "internet",
  gravatar: "internet",
  crsRegistry: "internet",
  maxmind: "internet",
  // The agent downloads Go modules to build Caddy; offline, it loads an image built elsewhere.
  caddyBuild: "internet",
  webPush: "internet",
  alerts: "configured",
  auditStreaming: "configured",
  backupStorage: "configured",
  smtp: "configured",
  ldap: "configured",
  oidcProvider: "configured",
  samlMetadata: "configured",
  acmeDns: "configured",
  captcha: "configured",
  tailscale: "configured",
  crowdsecLapi: "configured",
  reachability: "configured",
  dashboardHost: "configured",
  caddyAdmin: "internal",
  clickhouse: "internal",
  agentController: "internal",
  // `cpm-agent --pair` and the health check, asking the running agent over its own socket.
  agentSocket: "internal",
} as const satisfies Record<string, OutboundKind>;

export type OutboundCallId = keyof typeof OUTBOUND_CALLS;

export const OUTBOUND_CALL_IDS = Object.keys(OUTBOUND_CALLS) as OutboundCallId[];

export async function offlineModeEnabled(): Promise<boolean> {
  const [{ offlineMode }, { getSetting }] = await Promise.all([
    import("../settings/registry"),
    import("../settings/resolve"),
  ]);
  return getSetting(offlineMode);
}

/** False only for an internet call while offline mode is on. */
export async function outboundAllowed(id: OutboundCallId): Promise<boolean> {
  return OUTBOUND_CALLS[id] !== "internet" || !(await offlineModeEnabled());
}

/**
 * `offline` and `switchedOff` say which switch stops it; `on` is an internet call that runs when
 * its feature needs it. `configured` and `internal` never change with offline mode.
 */
export type OutboundCallState = "on" | "offline" | "switchedOff" | "configured" | "internal";

export type OutboundCallView = { id: OutboundCallId; kind: OutboundKind; state: OutboundCallState };

/** Calls with a switch of their own, read only while offline mode leaves them running. */
const OWN_SWITCHES: Partial<Record<OutboundCallId, () => Promise<boolean>>> = {
  updateCheck: async () => {
    const [{ updateCheckEnabled }, { getSetting }] = await Promise.all([
      import("../settings/registry"),
      import("../settings/resolve"),
    ]);
    return getSetting(updateCheckEnabled);
  },
  gravatar: async () => (await import("../settings")).isGravatarEnabled(),
  maxmind: async () => {
    const [{ geoipEnabled }, { geoipCredentials }] = await Promise.all([
      import("../agent/geoip"),
      import("../geoip/update-check"),
    ]);
    if (!(await geoipEnabled())) return false;
    const { accountId, licenseKey } = await geoipCredentials();
    return Boolean(accountId && licenseKey);
  },
};

export async function outboundCallViews(): Promise<OutboundCallView[]> {
  const offline = await offlineModeEnabled();
  return Promise.all(
    OUTBOUND_CALL_IDS.map(async (id): Promise<OutboundCallView> => {
      const kind: OutboundKind = OUTBOUND_CALLS[id];
      if (kind !== "internet") return { id, kind, state: kind };
      if (offline) return { id, kind, state: "offline" };
      const own = OWN_SWITCHES[id];
      return { id, kind, state: own && !(await own()) ? "switchedOff" : "on" };
    }),
  );
}
