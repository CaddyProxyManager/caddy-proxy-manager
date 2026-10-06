/**
 * Field-by-field before and after for a host, secrets masked. Pure and client safe, so the docs
 * demos run it too; the server feeds it the stored host and the one a save would leave.
 */

import type { EditorSection } from "../proxy-hosts/editor-sections";
import type { L4EditorSection } from "../l4/editor-sections";
import {
  type DiffScalar,
  type DiffValue,
  type FieldChange,
  type HostKind,
  type LeafChange,
  MASKED_VALUE,
} from "./types";

type FieldSpec<S extends string> = {
  section: S;
  /** A create cannot drop it. */
  required?: boolean;
  /** Free text that may embed credentials: redacted inside rather than hidden whole. */
  rawText?: boolean;
};

/** In editor order; a host field missing here is not shown. */
export const HTTP_FIELDS: Record<string, FieldSpec<EditorSection>> = {
  name: { section: "general", required: true },
  description: { section: "general" },
  tags: { section: "general" },
  domains: { section: "general", required: true },
  enabled: { section: "general" },
  upstreams: { section: "upstreams", required: true },
  sslForced: { section: "upstreams" },
  hstsEnabled: { section: "upstreams" },
  hstsSubdomains: { section: "upstreams" },
  allowWebsocket: { section: "upstreams" },
  preserveHostHeader: { section: "upstreams" },
  skipHttpsHostnameValidation: { section: "upstreams" },
  compression: { section: "upstreams" },
  discourageIndexing: { section: "upstreams" },
  loadBalancer: { section: "upstreams" },
  dnsResolver: { section: "upstreams" },
  upstreamTimeouts: { section: "upstreams" },
  upstreamDnsResolution: { section: "upstreams" },
  certificateId: { section: "tls" },
  mtls: { section: "tls" },
  accessListId: { section: "access" },
  authentik: { section: "access" },
  forwardAuth: { section: "access" },
  cpmForwardAuth: { section: "access" },
  cpmForwardAuthAccess: { section: "access" },
  tailscale: { section: "access" },
  rateLimit: { section: "protection" },
  geoblock: { section: "protection" },
  geoblockMode: { section: "protection" },
  crowdsec: { section: "protection" },
  anubis: { section: "protection" },
  waf: { section: "protection" },
  redirects: { section: "routing" },
  locationRules: { section: "routing" },
  rewrite: { section: "routing" },
  pathAllows: { section: "routing" },
  pathBlocks: { section: "routing" },
  pathRewrites: { section: "routing" },
  errorPages: { section: "routing" },
  agentIds: { section: "advanced" },
  cache: { section: "advanced" },
  maintenance: { section: "advanced" },
  customReverseProxyJson: { section: "advanced", rawText: true },
  customPreHandlersJson: { section: "advanced", rawText: true },
  customCaddyfile: { section: "advanced", rawText: true },
};

export const L4_FIELDS: Record<string, FieldSpec<L4EditorSection>> = {
  name: { section: "general", required: true },
  description: { section: "general" },
  tags: { section: "general" },
  enabled: { section: "general" },
  protocol: { section: "listener", required: true },
  listenAddress: { section: "listener", required: true },
  agentIds: { section: "listener" },
  matcherType: { section: "listener" },
  matcherValue: { section: "listener" },
  tlsTermination: { section: "listener" },
  proxyProtocolReceive: { section: "listener" },
  upstreams: { section: "upstreams", required: true },
  upstreamPortMode: { section: "upstreams" },
  proxyProtocolVersion: { section: "upstreams" },
  loadBalancer: { section: "upstreams" },
  dnsResolver: { section: "upstreams" },
  upstreamDnsResolution: { section: "upstreams" },
  accessListId: { section: "protection" },
  crowdsec: { section: "protection" },
  geoblock: { section: "protection" },
  geoblockMode: { section: "protection" },
};

export function hostFields(kind: HostKind): Record<string, FieldSpec<string>> {
  return kind === "http" ? HTTP_FIELDS : L4_FIELDS;
}

/** Fields that never reach the Caddy config: changing only these reloads nothing. */
export const CONFIG_NEUTRAL_FIELDS: readonly string[] = [
  "description",
  "tags",
  "cpmForwardAuthAccess",
];

export const SECRET_KEY =
  /secret|password|passwd|token|api[_-]?key|auth[_-]?key|private[_-]?key|credential|authorization|cookie|bearer/i;

/** A header map's values and a probe body are free-form, so every leaf under them is hidden. */
const OPAQUE_SEGMENT = /^(?:.*headers|requestbody)$/i;

const JSON_SECRET =
  /("[^"]*(?:secret|password|passwd|token|api[_-]?key|auth[_-]?key|private[_-]?key|credential|authorization)[^"]*"\s*:\s*)("(?:[^"\\]|\\.)*"|\[[^\]]*\])/gi;
const WORD_SECRET =
  /\b((?:secret|password|passwd|token|api[_-]?key|auth[_-]?key|authorization|bearer|basic)\b["']?[ \t]*[:=]?[ \t]*)(?!\[masked\])("[^"\n]*"|[^\s"{}]+)/gi;
const BCRYPT = /\$2[aby]?\$\d{2}\$[./A-Za-z0-9]{53}/g;

/** Best effort for snippets: quoted JSON keys, `word value` pairs and bcrypt hashes. */
export function redactSecretText(text: string): string {
  return text
    .replace(BCRYPT, MASKED_VALUE)
    .replace(JSON_SECRET, (_m, key: string) => `${key}"${MASKED_VALUE}"`)
    .replace(WORD_SECRET, (_m, key: string) => `${key}${MASKED_VALUE}`);
}

function isScalar(value: unknown): value is DiffScalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isFlat(value: unknown): value is DiffValue {
  return isScalar(value) || (Array.isArray(value) && value.every(isScalar));
}

/** Absent, blank, off and empty all read as "not set", so a round trip through the form is quiet. */
function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

function sameFlat(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

function flatten(value: unknown, prefix: string, out: Map<string, DiffValue>): void {
  if (value === undefined) return;
  if (isFlat(value)) {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      flatten(item, prefix ? `${prefix}.${index}` : String(index), out);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

function display(value: unknown): DiffValue {
  return isEmpty(value) && value !== false ? null : (value as DiffValue);
}

/** A switched-off config the host never stored is not a change, however the form fills it in. */
function dormant(before: unknown, after: unknown): boolean {
  const off = (value: unknown) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "enabled" in value &&
    !(value as { enabled?: unknown }).enabled;
  return (before === null || before === undefined) && off(after);
}

function maskLeaf(path: string, value: DiffValue): { value: DiffValue; masked: boolean } {
  const segments = path.split(".");
  const last = segments.at(-1) ?? path;
  const opaque = segments.some((segment) => OPAQUE_SEGMENT.test(segment));
  if ((opaque || SECRET_KEY.test(last)) && !isEmpty(value)) {
    return { value: MASKED_VALUE, masked: true };
  }
  return { value, masked: false };
}

function maskText(value: DiffValue): { value: DiffValue; masked: boolean } {
  if (typeof value !== "string") return { value, masked: false };
  const redacted = redactSecretText(value);
  return { value: redacted, masked: redacted !== value };
}

function diffField(
  field: string,
  spec: FieldSpec<string>,
  before: unknown,
  after: unknown,
  isCreate: boolean,
): FieldChange | null {
  const revertible = !(isCreate && spec.required);
  if (dormant(before, after) || dormant(after, before)) return null;

  if ((before === undefined || isFlat(before)) && (after === undefined || isFlat(after))) {
    if (sameFlat(before, after)) return null;
    const mask = spec.rawText ? maskText : (value: DiffValue) => maskLeaf(field, value);
    const b = mask(display(before));
    const a = mask(display(after));
    return {
      field,
      section: spec.section,
      before: b.value,
      after: a.value,
      leaves: null,
      masked: b.masked || a.masked,
      revertible,
    };
  }

  const left = new Map<string, DiffValue>();
  const right = new Map<string, DiffValue>();
  flatten(before, "", left);
  flatten(after, "", right);
  const paths = [...new Set([...left.keys(), ...right.keys()])];
  const leaves: LeafChange[] = [];
  let masked = false;
  for (const path of paths) {
    if (sameFlat(left.get(path), right.get(path))) continue;
    // The field's own name counts, so a field called `headers` hides every leaf.
    const b = maskLeaf(`${field}.${path}`, display(left.get(path)));
    const a = maskLeaf(`${field}.${path}`, display(right.get(path)));
    masked ||= b.masked || a.masked;
    leaves.push({ path, before: b.value, after: a.value });
  }
  if (leaves.length === 0) return null;
  return { field, section: spec.section, before: null, after: null, leaves, masked, revertible };
}

/** One value outside the host field lists, as the audit log's generic diffs need. */
export function diffValue(
  field: string,
  section: string,
  before: unknown,
  after: unknown,
  options: { rawText?: boolean } = {},
): FieldChange | null {
  return diffField(field, { section, rawText: options.rawText }, before, after, false);
}

/**
 * Both sides as field records (a host plus anything stored beside it, such as `agentIds`). A
 * `before` of null is a create, diffed against `blank`, the host the defaults would leave.
 */
export function diffHostFields(
  kind: HostKind,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  blank: Record<string, unknown>,
): FieldChange[] {
  const isCreate = before === null;
  const base = before ?? blank;
  const changes: FieldChange[] = [];
  for (const [field, spec] of Object.entries(hostFields(kind))) {
    const change = diffField(field, spec, base[field], after[field], isCreate);
    if (change) changes.push(change);
  }
  return changes;
}

/**
 * The input with each undone field taken out, so a save leaves it as stored (or, for a create, at
 * its default). Names that are not fields, or cannot be dropped, are ignored.
 */
export function withoutReverted<T extends Record<string, unknown>>(
  kind: HostKind,
  input: T,
  reverted: readonly string[],
  isCreate: boolean,
): T {
  const fields = hostFields(kind);
  const next = { ...input };
  for (const field of reverted) {
    const spec = fields[field];
    if (!spec || (isCreate && spec.required)) continue;
    delete next[field];
  }
  return next;
}

/** `revertField` entries a form carries, as the review step's undo writes them. */
export function revertedFields(formData: FormData): string[] {
  return formData.getAll("revertField").filter((v): v is string => typeof v === "string");
}
