/**
 * JSON for github.com/tailscale/caddy-tailscale (tsnet in-process: no tailscaled, no TUN device).
 * Split from caddy.ts so the shapes are unit-testable without a database. Certificates come from
 * Caddy's own `tls.get_certificate.tailscale`, not the plugin's listener, so a tailnet host keeps
 * this app's connection policies, HSTS and mTLS.
 */

import { type DomainError, type DomainErrorCode, domainError } from "./domain-error";

/** Local, not from settings-validation: that module imports this one, and imports go one way. */
function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Every Tailscale MagicDNS name ends here; Caddy keys its own certificate handling off it. */
export const TAILSCALE_DOMAIN_SUFFIX = ".ts.net";

/**
 * On the `caddy-data` volume so a node keeps its identity across a recreate - otherwise it
 * re-registers on every restart and the tailnet fills with duplicates.
 */
export const TAILSCALE_DEFAULT_STATE_DIR = "/data/tailscale";

export const TAILSCALE_DEFAULT_NODE = "caddy";

/** A DNS label: what the tailnet admin console will accept. */
const NODE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Tailscale ACL tags, as the admin console writes them. */
const TAG_PATTERN = /^tag:[a-z0-9][a-z0-9-]*$/;

const MAX_TAGS = 32;

export function isTailscaleDomain(domain: string): boolean {
  return domain.trim().toLowerCase().endsWith(TAILSCALE_DOMAIN_SUFFIX);
}

/** Lowercased, not rejected: `Caddy` vs `caddy` would register two nodes that look identical. */
export function normalizeNodeName(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/** Each field has its own message, so no label is spliced into one. */
export type NodeNameField = "node" | "upstreamNode" | "defaultNode";

const NODE_NAME_CODES = {
  node: { required: "tailscaleNodeNameRequired", invalid: "tailscaleNodeNameInvalid" },
  upstreamNode: {
    required: "tailscaleUpstreamNodeNameRequired",
    invalid: "tailscaleUpstreamNodeNameInvalid",
  },
  defaultNode: { required: "tailscaleDefaultNodeRequired", invalid: "tailscaleDefaultNodeInvalid" },
} as const satisfies Record<NodeNameField, Record<"required" | "invalid", DomainErrorCode>>;

/** Why a node name is unusable, or null. */
export function nodeNameProblem(name: string, field: NodeNameField = "node"): DomainError | null {
  const codes = NODE_NAME_CODES[field];
  if (!name) return domainError(codes.required, {}, { status: 400 });
  if (!NODE_NAME_PATTERN.test(name)) return domainError(codes.invalid, { name }, { status: 400 });
  return null;
}

export function validateNodeName(name: string, field: NodeNameField = "node"): string | null {
  return nodeNameProblem(name, field)?.message ?? null;
}

/**
 * The `<id>` of a `tskey-<type>-<id>-<secret>` key, or null. Null means "cannot check", never
 * "invalid": the format is not a documented contract, and old keys, placeholders and Headscale
 * keys lack it.
 */
export function tailscaleKeyId(key: string): string | null {
  const parts = key.trim().split("-");
  if (parts.length < 4 || parts[0] !== "tskey") return null;
  const id = parts[2];
  return /^[A-Za-z0-9]+$/.test(id) ? id : null;
}

/** Caddy expands it at load time, so it cannot be resolved or checked here. */
export function isCaddyPlaceholder(value: string): boolean {
  return /\{[a-z][a-z0-9_.]*\}/i.test(value.trim());
}

// ─── Global settings ─────────────────────────────────────────────────────────

/** The plugin's global options: a tailnet has one set of credentials however many sites use it. */
export type TailscaleSettings = {
  enabled: boolean;
  /** Encrypted at rest; passed verbatim, so `{env.TS_AUTHKEY}` keeps it out of the database. */
  authKey: string;
  /** For Headscale and friends. Empty means Tailscale's own. */
  controlUrl: string;
  ephemeral: boolean;
  /** Empty falls back to the plugin's own default. */
  stateDir: string;
  /** Required by most reusable auth keys. */
  tags: string[];
  defaultNode: string;
  /**
   * Off by default: it needs a second credential (an auth key cannot call the API). With it off a
   * revoked key surfaces only when Caddy rejects the whole configuration.
   */
  validateAuthKey: boolean;
  /** For that check. Encrypted at rest. */
  apiAccessToken: string;
  /** "-" means the token's own tailnet. */
  apiTailnet: string;
  /**
   * Off by default: an h3 listener makes Caddy bring the node up during config load, which blocks
   * - and wedges the admin API - for as long as the control server is unreachable.
   */
  http3: boolean;
};

export const DEFAULT_TAILSCALE_SETTINGS: TailscaleSettings = {
  enabled: false,
  authKey: "",
  controlUrl: "",
  ephemeral: false,
  stateDir: TAILSCALE_DEFAULT_STATE_DIR,
  tags: [],
  defaultNode: TAILSCALE_DEFAULT_NODE,
  validateAuthKey: false,
  apiAccessToken: "",
  apiTailnet: "-",
  http3: false,
};

/** Everything but the two secrets. */
export type TailscaleSettingsView = Omit<TailscaleSettings, "authKey" | "apiAccessToken"> & {
  hasAuthKey: boolean;
  hasApiAccessToken: boolean;
};

export function redactTailscaleSettingsForApi(settings: TailscaleSettings): TailscaleSettingsView {
  const { authKey, apiAccessToken, ...rest } = settings;
  return {
    ...rest,
    hasAuthKey: authKey.trim().length > 0,
    hasApiAccessToken: apiAccessToken.trim().length > 0,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Throws rather than correcting: a bad node name makes Caddy reject the whole document, taking
 * every other host down with it.
 */
export function normalizeTailscaleSettings(value: unknown): TailscaleSettings {
  const input = (value ?? {}) as Partial<Record<keyof TailscaleSettings, unknown>>;

  const defaultNode = normalizeNodeName(
    typeof input.defaultNode === "string" && input.defaultNode.trim()
      ? input.defaultNode
      : TAILSCALE_DEFAULT_NODE,
  );
  const nodeError = nodeNameProblem(defaultNode, "defaultNode");
  if (nodeError) throw nodeError;

  // Generous: this also runs over the stored blob, where the key is a much longer ciphertext.
  const authKey = typeof input.authKey === "string" ? input.authKey.trim() : "";
  if (authKey.length > 4096) throw domainError("tailscaleAuthKeyTooLong");
  if (/\s/.test(authKey) || hasForbiddenControlCharacter(authKey)) {
    throw domainError("tailscaleAuthKeyInvalidCharacters");
  }

  const controlUrl = typeof input.controlUrl === "string" ? input.controlUrl.trim() : "";
  if (controlUrl) {
    let parsed: URL;
    try {
      parsed = new URL(controlUrl);
    } catch {
      throw domainError("tailscaleControlUrlInvalid", { url: controlUrl });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw domainError("tailscaleControlUrlProtocol");
    }
  }

  const stateDir = typeof input.stateDir === "string" ? input.stateDir.trim() : "";
  if (stateDir) {
    if (!stateDir.startsWith("/") || stateDir.includes("..")) {
      throw domainError("tailscaleStateDirNotAbsolute");
    }
    if (hasForbiddenControlCharacter(stateDir)) {
      throw domainError("tailscaleStateDirControlCharacter");
    }
  }

  const apiAccessToken =
    typeof input.apiAccessToken === "string" ? input.apiAccessToken.trim() : "";
  if (apiAccessToken.length > 4096) throw domainError("tailscaleApiTokenTooLong");
  if (/\s/.test(apiAccessToken) || hasForbiddenControlCharacter(apiAccessToken)) {
    throw domainError("tailscaleApiTokenInvalidCharacters");
  }

  // Only refuses what would corrupt the request path.
  const apiTailnet =
    typeof input.apiTailnet === "string" && input.apiTailnet.trim() ? input.apiTailnet.trim() : "-";
  if (!/^[A-Za-z0-9._@-]+$/.test(apiTailnet)) {
    throw domainError("tailscaleTailnetInvalid", { tailnet: apiTailnet });
  }

  const tags = Array.from(
    new Set(
      asStringArray(input.tags)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (tags.length > MAX_TAGS) throw domainError("tailscaleTooManyTags", { max: MAX_TAGS });
  for (const tag of tags) {
    if (!TAG_PATTERN.test(tag)) {
      throw domainError("tailscaleTagInvalid", { tag });
    }
  }

  return {
    enabled: Boolean(input.enabled),
    authKey,
    controlUrl,
    ephemeral: Boolean(input.ephemeral),
    stateDir,
    tags,
    defaultNode,
    validateAuthKey: Boolean(input.validateAuthKey),
    apiAccessToken,
    apiTailnet,
    http3: Boolean(input.http3),
  };
}

// ─── Caddy JSON ──────────────────────────────────────────────────────────────

/**
 * No `nodes`: the plugin derives each hostname from the listener address, and an entry would
 * only drift. `authKey` arrives decrypted - only the caller knows whether it is a placeholder.
 */
export function buildTailscaleApp(
  settings: TailscaleSettings,
  authKey: string,
): Record<string, unknown> {
  return {
    ...(authKey ? { auth_key: authKey } : {}),
    ...(settings.controlUrl ? { control_url: settings.controlUrl } : {}),
    ...(settings.ephemeral ? { ephemeral: true } : {}),
    ...(settings.stateDir ? { state_dir: settings.stateDir } : {}),
    ...(settings.tags.length > 0 ? { tags: settings.tags } : {}),
  };
}

/** Both ports: a client typing a bare MagicDNS name lands on :80 and gets redirected. */
export function tailscaleListenAddresses(node: string): string[] {
  return [`tailscale/${node}:80`, `tailscale/${node}:443`];
}

/** The `tailscale_auth` equivalent. */
export function buildTailscaleAuthHandler(): Record<string, unknown> {
  return { handler: "authentication", providers: { tailscale: {} } };
}

/**
 * Keys must match the plugin's Authenticate() exactly - a typo forwards an empty header rather
 * than failing. Headers are in Go's canonical casing because Caddy looks them up literally.
 */
export const TAILSCALE_IDENTITY_HEADERS: Record<string, string> = {
  "X-Tailscale-User": "{http.auth.user.tailscale_user}",
  "X-Tailscale-Login": "{http.auth.user.tailscale_login}",
  "X-Tailscale-Name": "{http.auth.user.tailscale_name}",
  "X-Tailscale-Tailnet": "{http.auth.user.tailscale_tailnet}",
  "X-Tailscale-Profile-Picture": "{http.auth.user.tailscale_profile_picture}",
};

/** Runs first, or a client could send identity headers the upstream takes for this proxy's. */
export function buildTailscaleIdentityStripHandler(): Record<string, unknown> {
  return { handler: "headers", request: { delete: Object.keys(TAILSCALE_IDENTITY_HEADERS) } };
}

/** Only valid after the auth handler. */
export function buildTailscaleIdentityHeadersHandler(): Record<string, unknown> {
  return {
    handler: "headers",
    request: {
      set: Object.fromEntries(
        Object.entries(TAILSCALE_IDENTITY_HEADERS).map(([header, placeholder]) => [
          header,
          [placeholder],
        ]),
      ),
    },
  };
}

/** One handler, so callers that place a single "auth handler" get both or neither. */
export function buildTailscaleAuthSubroute(forwardIdentity: boolean): Record<string, unknown> {
  const handle = forwardIdentity
    ? [buildTailscaleAuthHandler(), buildTailscaleIdentityHeadersHandler()]
    : [buildTailscaleAuthHandler()];
  return { handler: "subroute", routes: [{ handle }] };
}

/**
 * `tls` passes through: the plugin reads any non-nil TLS config as "use https". Releasing a node
 * never started crashes tsnet upstream - see docker/caddy/go.mod before moving the fork pin.
 */
export function buildTailscaleTransport(
  node: string,
  tls: Record<string, unknown> | null,
): Record<string, unknown> {
  return { protocol: "tailscale", name: node, ...(tls ? { tls } : {}) };
}

/** No `issuers` on purpose: one would put `.ts.net` names back on ACME, which cannot issue them. */
export function buildTailscaleAutomationPolicy(subjects: string[]): Record<string, unknown> {
  return { subjects, get_certificate: [{ via: "tailscale" }] };
}
