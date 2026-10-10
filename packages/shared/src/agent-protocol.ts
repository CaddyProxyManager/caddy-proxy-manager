/**
 * The controller <-> agent contract. Every field either side puts on the wire is named here: the
 * two build from different trees, so a rename reaching only one fails at runtime, not compile time.
 * Requests are HMAC-signed (`signatureBase`); the secret never travels with a request.
 */

// ─── Authentication ──────────────────────────────────────────────────────────

export const AGENT_TIMESTAMP_HEADER = "x-cpm-timestamp";
export const AGENT_SIGNATURE_HEADER = "x-cpm-signature";
/** Names the calling agent, so the controller can pick the right secret. */
export const AGENT_ID_HEADER = "x-cpm-agent";

/**
 * Signed, and refused if already seen, so a captured request cannot be replayed inside the skew
 * window - where a replayed subscription would displace the real agent's stream.
 */
export const AGENT_NONCE_HEADER = "x-cpm-nonce";
export const AGENT_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Survives unsynchronised container clocks; a captured request dies in a minute, not a day. */
export const AGENT_CLOCK_SKEW_MS = 60_000;

/**
 * Fixed field count, so no path/body combination can produce another request's base string.
 * Without `nonce` it is the pre-3.0.0-rc.4 base, still verified; the line counts differ.
 */
export function signatureBase(
  method: string,
  path: string,
  timestamp: number,
  bodyHash: string,
  nonce?: string,
): string {
  if (nonce === undefined) return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

/** Capitals only, so it can be read aloud and typed. */
export const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_CODE_LENGTH = 6;
/** The agent prints a fresh code when this elapses. */
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

// ─── Status ──────────────────────────────────────────────────────────────────

export type L4PortsState = "idle" | "pending" | "applying" | "applied" | "failed";
export type CaddyBuildState = "idle" | "pending" | "building" | "applied" | "failed";
export type ManagedServicesState = "idle" | "pending" | "applying" | "applied" | "failed";

/**
 * What an operation status says, as a code the controller words in its reader's language;
 * `message` stays the English for an older controller, and for a code it does not know.
 */
export const AGENT_STATUS_MESSAGES = [
  "l4Interrupted",
  "l4Refused",
  "l4Applying",
  "l4RecreateFailed",
  "l4AppliedHealthy",
  "l4AppliedStarting",
  "l4Failed",
  "buildInterrupted",
  "imageLoading",
  "imagePullFailed",
  "imageModulesUnreadable",
  "imageNarrowing",
  "imageRecreateFailed",
  "imageModulesUnreadableAfter",
  "imageUnhealthy",
  "imageLoaded",
  "imageLoadedNoList",
  "imageLoadFailed",
  "buildRefused",
  "building",
  "buildTimedOut",
  "buildFailedOutput",
  "buildRecreateFailed",
  "buildUnhealthy",
  "buildApplied",
  "buildFailed",
  "servicesInterrupted",
  "servicesStarting",
  "servicesStopping",
  "servicesPartial",
  "servicesRunning",
  "servicesOff",
  "servicesFailed",
] as const;
export type AgentStatusMessageCode = (typeof AGENT_STATUS_MESSAGES)[number];
export type AgentStatusMessageParams = Record<string, string | number>;

export type AgentOperationStatus<TState extends string> = {
  state: TState;
  message?: string;
  messageCode?: AgentStatusMessageCode;
  messageParams?: AgentStatusMessageParams;
  appliedAt?: string;
  triggeredAt?: string;
  error?: string;
};

export type L4PortsStatus = AgentOperationStatus<L4PortsState>;
export type CaddyBuildStatus = AgentOperationStatus<CaddyBuildState>;

/** `external`: the operator builds Caddy's image and the agent only loads it (CADDY_BUILD_MODE). */
export const CADDY_BUILD_MODES = ["agent", "external"] as const;
export type CaddyBuildMode = (typeof CADDY_BUILD_MODES)[number];

/** What an operator building the image needs, reported by an agent that will not build it. */
export type ExternalCaddyImage = {
  /** The reference Caddy's container was created from; null before its first start. */
  image: string | null;
  /** The image bakes Caddy's user in, so these must match the host's; "" when unset. */
  puid: string;
  pgid: string;
};
export type ManagedServicesStatus = AgentOperationStatus<ManagedServicesState>;

/**
 * Compose services behind a profile, which nothing inside the stack can enable - only the agent,
 * which runs the compose CLI. A name an agent does not know is ignored, not refused, so an older
 * agent never starts `crowdsec` and reports it off; a missing one (`geoipupdate`) reads as off.
 */
export const MANAGED_SERVICES = ["clickhouse", "crowdsec"] as const;
export type ManagedServiceName = (typeof MANAGED_SERVICES)[number];

/** An allowlist: an unconstrained key would let the controller set any variable compose reads. */
export const MANAGED_SERVICE_ENV_KEYS = [
  "CLICKHOUSE_USER",
  "CLICKHOUSE_PASSWORD",
  "CLICKHOUSE_DB",
  // The bouncer key the controller generated; the image registers it for Caddy on first start.
  "CROWDSEC_BOUNCER_KEY",
  "CROWDSEC_DISABLE_ONLINE_API",
] as const;
export type ManagedServiceEnvKey = (typeof MANAGED_SERVICE_ENV_KEYS)[number];

export type AgentStatus = {
  agentId: string;
  version: string;
  mode: AgentMode;
  /** Detected from the Caddy container's labels. */
  composeProject: string;
  l4Ports: {
    /** As `HOST:CONTAINER[/proto]`. */
    applied: string[];
    status: L4PortsStatus;
  };
  caddyBuild: {
    /**
     * Null when never rebuilt, read as the shipped image's full catalog. An empty array is a
     * different, much worse claim: built with no plugins at all.
     */
    applied: string[] | null;
    status: CaddyBuildStatus;
    /** Only from an agent in external mode; absent means it builds the image itself. */
    external?: ExternalCaddyImage;
  };
  services: {
    /** Recorded, not probed: `docker compose ps` per service is too slow for every render. */
    applied: Record<ManagedServiceName, boolean> | null;
    status: ManagedServicesStatus;
  };
  analytics: {
    enabled: boolean;
    /** Only the agent can see the log; the controller's own filesystem says nothing remotely. */
    accessLogPresent: boolean;
  };
  /** Undefined from an older agent, or one that cannot read its own identity (non-Linux). */
  logAccess?: LogAccessReport;
  /**
   * Kinds beyond `caddy-admin`. Undefined means none: an older agent answers an unknown kind with
   * silence, and the caller would wait out the whole command timeout.
   */
  capabilities?: AgentCapability[];
};

export const AGENT_CAPABILITIES = [
  "caddy-validate",
  "log-read",
  "certificates",
  "caddy-image",
  // Only listed with CERT_FILES_HOST_DIR set, so a picker never offers an agent with no files.
  "certificate-files",
  // Not a command: an agent without it is sent a port range one port at a time.
  "l4-port-ranges",
] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

/**
 * `unreadable`: events silently skipped. `notTruncatable`: the WAF audit log grows until the disk
 * fills. `cleanupBlocked`: Caddy can write but not list the directory, so pruning silently stops.
 */
export type LogAccessProblemKind = "unreadable" | "notTruncatable" | "cleanupBlocked";

export type LogAccessProblem = {
  kind: LogAccessProblemKind;
  /** The same path inside Caddy's container. */
  path: string;
  uid: number;
  gid: number;
  mode: number;
};

export type LogAccessReport = {
  /** Where a fix runs: `docker exec` into this container. */
  caddyContainer: string;
  /** So a file in some other group reads as a CADDY_GID mismatch. */
  agentGroups: number[];
  /** Read off the files Caddy owns; null when there are none yet. */
  caddyGid: number | null;
  problems: LogAccessProblem[];
};

export type AgentMode = "standalone" | "managed";

// ─── Requests ────────────────────────────────────────────────────────────────

/** `env` carries credentials the controller holds in settings, which the host `.env` lacks. */
export type ManagedServicesRequest = {
  /** A missing name is off. */
  services: Partial<Record<ManagedServiceName, boolean>>;
  env: Partial<Record<ManagedServiceEnvKey, string>>;
};

// ─── Caddy admin proxy ───────────────────────────────────────────────────────

/**
 * Only the agent knows where its Caddy is; dialling one itself, the controller would configure a
 * local Caddy while a remote agent recreated its own.
 */
export type CaddyAdminProxyRequest = {
  /** Must be absolute. */
  path: string;
  method: string;
  body?: string;
  /** Defaults to application/json; /adapt needs text/caddyfile. */
  contentType?: string;
  /**
   * A 2xx body comes back as its SHA-256 in hex, marked by `CADDY_DIGEST_HEADER`, so a monitor
   * polling the whole config moves 64 bytes. An older agent ignores it and sends the body.
   */
  digest?: true;
};

export const CADDY_DIGEST_HEADER = "x-cpm-digest";

/** A non-2xx status is data here, not an error. */
export type CaddyAdminProxyResponse = {
  status: number;
  text: string;
  headers: Record<string, string>;
};

/** Hundreds of hosts produce megabytes; well above realistic, still bounded. */
export const MAX_CADDY_CONFIG_BYTES = 8 * 1024 * 1024;

/**
 * Caddy has no dry run and Coraza compiles only while provisioning, so this is the one way to test
 * a directive before loading it. Answered 200 or 422, `text` the `caddy validate` transcript.
 */
export type CaddyValidateRequest = { config: string };

export type LogReadRequest = {
  source: "access" | "waf" | "caddy";
  /** Absent for the newest lines. Opaque to the controller. */
  cursor?: string | null;
  limit?: number;
};

/** Never the key. */
export type CaddyCertificate = {
  /** The issuer's storage directory, e.g. `acme-v02.api.letsencrypt.org-directory`. */
  issuerKey: string;
  /** The storage name, usually the domain. */
  name: string;
  names: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  fingerprint: string;
};

export type CertificateFileRequest = { issuerKey: string; name: string; includeKey?: boolean };
export type CertificateFiles = { certificatePem: string; keyPem?: string };

// ─── Certificates from files on the agent's host ─────────────────────────────

/** Paths are relative to the agent's CERT_FILES_HOST_DIR; see `isValidCertificateFilePath`. */
export type CertificateFileSource = { id: number; certPath: string; keyPath: string };

/** Codes, not sentences: the controller renders them in its reader's language. */
export const CERTIFICATE_FILE_ERRORS = [
  "not-configured",
  "unavailable",
  "invalid-path",
  "not-found",
  "outside-directory",
  "too-large",
  "not-a-certificate",
  "not-a-key",
  "key-mismatch",
  "no-names",
] as const;
export type CertificateFileError = (typeof CERTIFICATE_FILE_ERRORS)[number];

/**
 * `fingerprint` is the SHA-256 (hex) of the chain as sent. The PEM is left out when the agent sent
 * this fingerprint before; the controller answers with the ids it wants in full again.
 */
export type CertificateFileResult = { id: number } & (
  | { ok: true; fingerprint: string; certificatePem?: string; keyPem?: string }
  | { ok: false; error: CertificateFileError }
);

/** What the picker lists. Never a key's content: a key file is only named. */
export type CertificateFileEntry =
  | {
      path: string;
      kind: "certificate";
      names: string[];
      notAfter: string;
      /** The leaf's SHA-256, as `X509Certificate.fingerprint256` spells it. */
      fingerprint: string;
    }
  | { path: string; kind: "key" };

export type CertificateFilesReadRequest = { files: CertificateFileSource[] };

/** The `agentCertificateFiles` answer. */
export type CertificateFilesAck = { resend: number[] };

export type LogReadResponse = {
  lines: string[];
  /** Null when there is nothing to continue from yet. */
  cursor: string | null;
  truncated?: boolean;
  /** E.g. access logging is off. */
  missing?: boolean;
};

export const CADDY_VALIDATE_REFUSED_STATUS = 422;

// ─── Fleet configuration ─────────────────────────────────────────────────────

/** Parsers read Country, geo-blocking Country and ASN; City only because subscribers expect it. */
export const GEOIP_EDITIONS = ["GeoLite2-Country", "GeoLite2-ASN", "GeoLite2-City"] as const;
export type GeoipEdition = (typeof GEOIP_EDITIONS)[number];

export type FleetConfig = {
  /** Always null, but still sent so an older agent reads analytics as off. */
  clickhouse: null;

  /** Only the agent can read the log; the controller writes, so no agent holds a credential. */
  analytics: boolean;

  /**
   * Count the access log's 502/503/504 answers per host and relay them (`upstream-errors`),
   * whatever `analytics` says: the admin notification needs no ClickHouse. Absent from an older
   * controller, which would refuse the kind.
   */
  upstreamErrors?: boolean;

  /**
   * How often the agent parses its logs and relays the rows, which is how soon the dashboard sees a
   * request. Absent from an older controller, and an older agent ignores it: both keep 30 seconds.
   */
  analyticsIntervalSeconds?: number;

  /**
   * How long a `docker compose build caddy` may take before the agent abandons it: Settings ->
   * Caddy build. Absent from an older controller, and an older agent ignores it: both keep the
   * agent's own CADDY_BUILD_TIMEOUT.
   */
  caddyBuildTimeoutSeconds?: number;

  /**
   * Offline mode: the agent acts as if `CADDY_BUILD_MODE=external`, since a build downloads Go
   * modules. Absent from an older controller; an older agent ignores it and still builds.
   */
  offline?: boolean;

  /**
   * Pulled, not pushed: tens of megabytes. Agents prefer their paired address joined to
   * `CONTROLLER_GEOIP_ROUTE`, since one beside the controller would otherwise fetch through the
   * Caddy it has not started; `url` (the public address) remains for older agents.
   */
  geoip: {
    url: string;
    editions: string[];
  } | null;
};

/** What an agent does without `analyticsIntervalSeconds`, and what the controller pushes by default. */
export const DEFAULT_ANALYTICS_INTERVAL_SECONDS = 30;
export const LIVE_ANALYTICS_INTERVAL_SECONDS = 5;
/** Clamped on the agent, so a bad value neither spins the parser nor starves the dashboard. */
export const MIN_ANALYTICS_INTERVAL_SECONDS = 2;
export const MAX_ANALYTICS_INTERVAL_SECONDS = 300;

// ─── Analytics rows ──────────────────────────────────────────────────────────

/**
 * Why a request ended: `served` reached the end of the gates, the rest name the gate that answered
 * it. `blocked` is the global deny list. A row without one is `served`, or `geo` when `is_blocked`.
 */
export const TRAFFIC_OUTCOMES = [
  "served",
  "waf",
  "geo",
  "access",
  "auth",
  "rate_limit",
  "crowdsec",
  "blocked",
] as const;
export type TrafficOutcome = (typeof TRAFFIC_OUTCOMES)[number];

/** The access-log field the config's `log_append` writes the outcome to. */
export const ACCESS_LOG_OUTCOME_FIELD = "cpm_outcome";

export function isTrafficOutcome(value: unknown): value is TrafficOutcome {
  return (TRAFFIC_OUTCOMES as readonly unknown[]).includes(value);
}

export type TrafficEventRow = {
  ts: number;
  client_ip: string;
  country_code: string | null;
  host: string;
  method: string;
  uri: string;
  status: number;
  proto: string;
  bytes_sent: number;
  user_agent: string;
  is_blocked: boolean;
  // Optional: absent from an older agent, and an older controller drops what it does not know.
  /** Caddy's own request duration, in whole milliseconds. */
  duration_ms?: number | null;
  outcome?: TrafficOutcome;
  /** From GeoLite2-ASN, when the agent has it. */
  asn?: number | null;
  asn_org?: string | null;
};

export type WafEventRow = {
  ts: number;
  host: string;
  client_ip: string;
  country_code: string | null;
  rule_id: number | null;
  rule_message: string | null;
  severity: string | null;
  raw_data: string | null;
  blocked: boolean;
  method: string;
  uri: string;
};

/** The answers a dead or overloaded upstream gets a proxy to give. */
export const UPSTREAM_ERROR_STATUSES = [502, 503, 504] as const;

/** Access-log answers in `UPSTREAM_ERROR_STATUSES`, per host and minute: counts, never requests. */
export type UpstreamErrorRow = {
  /** Unix seconds at the start of the minute, from the log's own timestamps. */
  minute: number;
  host: string;
  status: number;
  count: number;
};

// ─── Errors ──────────────────────────────────────────────────────────────────

export type AgentErrorCode =
  | "UNAUTHENTICATED"
  | "PAIRING_DISABLED"
  | "PAIRING_CODE_INVALID"
  | "PAIRING_CODE_EXPIRED"
  | "BAD_REQUEST"
  | "BUSY"
  | "INTERNAL";

// ═══ Controller-side agent API ═══════════════════════════════════════════════
//
// The agent dials out, so a host behind NAT needs no inbound port; whatever the controller must
// push goes down one long-lived stream the agent holds open.

export const CONTROLLER_AGENT_API_PREFIX = "/api/agent/v1";

export const CONTROLLER_AGENT_ROUTES = {
  /** Unsigned and not GraphQL: pairing runs before the secret every signed call needs exists. */
  pair: `${CONTROLLER_AGENT_API_PREFIX}/pair`,
  /**
   * Unsigned, like `pair`: names the controller without spending the code, so a typo'd address
   * that answers can be caught. A wrong code counts against the same budget as a wrong pairing.
   */
  pairPreview: `${CONTROLLER_AGENT_API_PREFIX}/pair/preview`,
  /** The subscription is read with `fetch`, not `EventSource`, so it carries the signed headers. */
  graphql: "/api/graphql",
} as const;

export const AGENT_OPERATIONS = {
  events: "subscription AgentEvents { agentEvents }",
  status: "mutation AgentStatus($status: JSON!) { agentStatus(status: $status) }",
  commandResults:
    "mutation AgentCommandResults($results: [JSON!]!) { agentCommandResults(results: $results) }",
  analytics:
    "mutation AgentAnalytics($kind: String!, $rows: [JSON!]!) { agentAnalytics(kind: $kind, rows: $rows) }",
  certificateFiles:
    "mutation AgentCertificateFiles($results: [JSON!]!) { agentCertificateFiles(results: $results) }",
} as const;

/** `upstream-errors` goes only to a controller that set `FleetConfig.upstreamErrors`. */
export const AGENT_ANALYTICS_KINDS = ["traffic", "waf", "upstream-errors"] as const;
export type AgentAnalyticsKind = (typeof AGENT_ANALYTICS_KINDS)[number];

/** A malformed row is dropped, not fatal. */
export type AgentAnalyticsResult = { accepted: number; rejected: number };

/** The agent splits to fit: a refused batch is resent every pass and would stall analytics. */
export const MAX_ANALYTICS_REQUEST_BYTES = 8 * 1024 * 1024;

/** `<route>/<edition>`. Outside the v1 prefix because it predates it and keeps its path. */
export const CONTROLLER_GEOIP_ROUTE = "/api/agent/geoip";

/** A silent stream looks like one a proxy dropped; inside the common 60s idle timeout. */
export const AGENT_STREAM_KEEPALIVE_MS = 20_000;

/** Backs off from min to max on repeated failure. */
export const AGENT_RECONNECT_MIN_MS = 1_000;
export const AGENT_RECONNECT_MAX_MS = 30_000;

export const AGENT_COMMAND_TIMEOUT_MS = 60_000;

/** The agent reposts status this often even when nothing changed. */
export const AGENT_STATUS_HEARTBEAT_MS = 60_000;

/**
 * Both sides open this under different mounts; a rename reaching only one silently stops the
 * bundled stack pairing itself. Same-host only - a remote agent pairs with a code.
 */
export const AGENT_BOOTSTRAP_FILE = "agent-bootstrap";

/** Tells the token apart from a typed six-letter code. */
export const AGENT_BOOTSTRAP_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// ─── Pairing (controller-minted) ─────────────────────────────────────────────

export type AgentPairRequest = {
  code: string;
  /** Generated once, then persisted. */
  agentId: string;
  agentName?: string;
  agentVersion: string;
};

export type AgentPairPreviewRequest = {
  code: string;
  /** Decides which code is checked: a known agent can only be re-paired with its own. */
  agentId: string;
};

export type AgentPairPreviewResponse = {
  controllerId: string;
  controllerName: string;
  /** The code would replace an existing pairing rather than add an agent. */
  repair: boolean;
};

export type AgentPairResponse = {
  /** Returned exactly once. */
  secret: string;
  /** Echoed on every later request so a re-pair is detectable. */
  controllerId: string;
  controllerName: string;
};

// ─── Desired state ───────────────────────────────────────────────────────────

/** Absolute, never incremental, so a dropped stream costs nothing but the reconnect. */
export type AgentDesiredState = {
  /** Ranges only for an agent listing `l4-port-ranges`. */
  l4Ports: string[];
  caddyModules: string[];
  services: ManagedServicesRequest;
  fleetConfig: FleetConfig;
  /** False until there is something to serve, keeping 80 and 443 shut on a fresh host. */
  caddyEnabled: boolean;
  /** Only for an agent listing `certificate-files`; absent otherwise. */
  certificateFiles?: CertificateFileSource[];
};

// ─── Stream frames ───────────────────────────────────────────────────────────

/** The one exception to desired state: a call the controller blocks on for an answer. */
export type AgentCommand = {
  /** Opaque to the agent. */
  id: string;
} & (
  | { kind: "caddy-admin"; request: CaddyAdminProxyRequest }
  /** Only sent to an agent listing it in `AgentStatus.capabilities`. */
  | { kind: "caddy-validate"; request: CaddyValidateRequest }
  /** Likewise. Answered as a 200 whose text is a `LogReadResponse`. */
  | { kind: "log-read"; request: LogReadRequest }
  /** Under the `certificates` capability: a 200 whose text is `CaddyCertificate[]`. */
  | { kind: "certificate-list"; request: Record<string, never> }
  /** Likewise: a 200 whose text is `CertificateFiles`, or a 404. */
  | { kind: "certificate-read"; request: CertificateFileRequest }
  /**
   * Under `caddy-image`: start loading the operator's image. A 200 once started, as a recreate
   * outlasts the command timeout; the outcome is reported in `caddyBuild.status`.
   */
  | { kind: "caddy-image-load"; request: Record<string, never> }
  /** Under `certificate-files`: a 200 whose text is `CertificateFileEntry[]`. */
  | { kind: "certificate-files-list"; request: Record<string, never> }
  /** Likewise: a 200 whose text is `CertificateFileResult[]`, every PEM included. */
  | { kind: "certificate-files-read"; request: CertificateFilesReadRequest }
);

export type AgentServerEvent =
  | { type: "desired-state"; state: AgentDesiredState }
  | { type: "command"; command: AgentCommand }
  /** Restarts Caddy and the agent after a controller migration. No answer: the agent exits. */
  | { type: "restart"; reason: string }
  | { type: "hello"; controllerId: string; controllerName: string }
  /** Keepalive in the protocol: the GraphQL library owns the transport, so no SSE comments. */
  | { type: "ping" };

export type AgentCommandResult = { id: string } & (
  | { ok: true; response: CaddyAdminProxyResponse }
  | { ok: false; error: string; code: AgentErrorCode }
);

// ─── Local control ───────────────────────────────────────────────────────────

/**
 * `cpm-agent --pair` talks to the running agent, not the controller: that process holds the
 * socket and the database, and a second one would have to hand the result over anyway.
 */
export const AGENT_LOCAL_ROUTES = {
  /** Unauthenticated, for the container HEALTHCHECK. Answers in every state. */
  health: "/health",
  state: "/local/state",
  pair: "/local/pair",
  pairPreview: "/local/pair/preview",
} as const;

export type AgentLifecycle =
  /** Caddy is held down and nothing is polled. */
  | "idle"
  /** Has an address and a code, exchanging them for a secret. */
  | "pairing"
  /** Paired and polling. */
  | "paired";

export type AgentLocalState = {
  lifecycle: AgentLifecycle;
  agentId: string;
  version: string;
  controllerUrl: string | null;
  caddy: { running: boolean; allowed: boolean };
  /** Operator-facing, English. */
  message: string | null;
};

export type AgentLocalPairRequest = {
  /** A bare host is assumed to be http://. */
  host: string;
  port?: number;
  code: string;
};

export type AgentLocalPairPreviewResponse =
  | {
      ok: true;
      controllerUrl: string;
      /** Null when the controller predates the preview route. */
      controllerName: string | null;
      controllerId: string | null;
      repair: boolean;
    }
  | {
      ok: false;
      /** English - this goes to a terminal. */
      error: string;
    };

export type AgentLocalPairResponse = {
  ok: boolean;
  state: AgentLocalState;
  /** English - this goes to a terminal. */
  error?: string;
};
