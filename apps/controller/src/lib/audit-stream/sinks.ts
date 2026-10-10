/**
 * Audit sinks as the page and GraphQL change them, each change audited once here. An HTTP sink's
 * URL and auth header value are `enc:v1` at rest and never leave the server: the URL may carry a
 * token, and the header is the credential. Pointing a sink elsewhere needs the header typed again.
 */

import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { asc, eq } from "drizzle-orm";
import { logAuditEvent } from "../audit";
import { announce } from "../cluster/announcements";
import db, { nowIso } from "../db";
import { auditChain, auditSecurityHead, auditSinks } from "../db/schema";
import { domainError, type StoredErrorCode } from "../errors/domain-error";
import { isLocalHost, isMetadataHost } from "../http/outbound-url";
import { decryptSecret, encryptSecret } from "../secrets";
import { DEFAULT_DATAGRAM_BYTES, MAX_DATAGRAM_BYTES, MIN_DATAGRAM_BYTES } from "./syslog";

export const SINK_KINDS = ["syslog-udp", "syslog-tcp", "syslog-tls", "http", "file"] as const;
export type SinkKind = (typeof SINK_KINDS)[number];

export const SINK_ENCODINGS = ["identity", "gzip", "zstd"] as const;
export type SinkEncoding = (typeof SINK_ENCODINGS)[number];

export const DEFAULT_PORTS: Record<"syslog-udp" | "syslog-tcp" | "syslog-tls", number> = {
  "syslog-udp": 514,
  "syslog-tcp": 514,
  "syslog-tls": 6514,
};

export const DEFAULT_HEADER_NAME = "Authorization";

/** A failing sink's open problem; its gaps are told under `${PROBLEM_PREFIX}gap:`. */
export const PROBLEM_PREFIX = "audit-sink:";

type Config = {
  host?: string;
  port?: number;
  maxBytes?: number;
  /** PEM of the CA a TLS or HTTPS receiver's certificate is checked against, besides the system's. */
  ca?: string;
  encoding?: SinkEncoding;
  headerName?: string;
  /** Under the data volume's audit-stream/. */
  fileName?: string;
};

type Secret = { url?: string; headerValue?: string };

export type Sink = {
  id: number;
  name: string;
  kind: SinkKind;
  enabled: boolean;
  config: Config;
  secret: Secret;
  includeSecurity: boolean;
  auditCursor: number;
  securityCursor: number;
  encodingFallback: boolean;
  failures: number;
  retryAt: string | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastErrorCode: StoredErrorCode | null;
  gapStream: "audit" | "security" | null;
  gapFrom: number | null;
  gapTo: number | null;
  gapAt: string | null;
  missed: number;
  createdAt: string;
  updatedAt: string;
};

export type SinkView = Omit<Sink, "config" | "secret"> & {
  host: string | null;
  port: number | null;
  maxBytes: number | null;
  ca: string | null;
  encoding: SinkEncoding | null;
  headerName: string | null;
  hasHeaderValue: boolean;
  /** Where an HTTP sink posts, with any path or query that may hold a token left out. */
  target: string;
  fileName: string | null;
  /** Records not yet delivered: audit events, and security records while they are included. */
  auditLag: number;
  securityLag: number | null;
};

export type SinkInput = {
  name: string;
  kind: string;
  enabled?: boolean | null;
  includeSecurity?: boolean | null;
  host?: string | null;
  port?: number | null;
  maxBytes?: number | null;
  ca?: string | null;
  /** Blank keeps the stored one. */
  url?: string | null;
  encoding?: string | null;
  headerName?: string | null;
  /** Blank keeps the stored one while the URL's origin stays; `clearHeaderValue` removes it. */
  headerValue?: string | null;
  clearHeaderValue?: boolean | null;
  fileName?: string | null;
};

type Row = typeof auditSinks.$inferSelect;

function parseJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseSink(row: Row): Sink {
  const secret = row.secret ? parseJson(decryptSecret(row.secret, `audit sink "${row.name}"`)) : {};
  const code = parseJson(row.lastErrorCode);
  return {
    id: row.id,
    name: row.name,
    kind: (SINK_KINDS as readonly string[]).includes(row.kind) ? (row.kind as SinkKind) : "file",
    enabled: row.enabled,
    config: parseJson(row.config) as Config,
    secret: secret as Secret,
    includeSecurity: row.includeSecurity,
    auditCursor: row.auditCursor,
    securityCursor: row.securityCursor,
    encodingFallback: row.encodingFallback,
    failures: row.failures,
    retryAt: row.retryAt,
    lastDeliveredAt: row.lastDeliveredAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    lastErrorCode: typeof code.code === "string" ? (code as StoredErrorCode) : null,
    gapStream: row.gapStream === "audit" || row.gapStream === "security" ? row.gapStream : null,
    gapFrom: row.gapFrom,
    gapTo: row.gapTo,
    gapAt: row.gapAt,
    missed: row.missed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function redactedUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return parsed.pathname === "/" && !parsed.search ? parsed.origin : `${parsed.origin}/…`;
  } catch {
    return "";
  }
}

export type StreamHeads = { audit: number; security: number };

export function sinkView(sink: Sink, heads: StreamHeads): SinkView {
  const { config, secret, ...rest } = sink;
  return {
    ...rest,
    host: config.host ?? null,
    port: config.port ?? null,
    maxBytes: sink.kind === "syslog-udp" ? (config.maxBytes ?? DEFAULT_DATAGRAM_BYTES) : null,
    ca: config.ca ?? null,
    encoding: sink.kind === "http" ? (config.encoding ?? "identity") : null,
    headerName: sink.kind === "http" ? (config.headerName ?? DEFAULT_HEADER_NAME) : null,
    hasHeaderValue: Boolean(secret.headerValue),
    target:
      sink.kind === "http"
        ? redactedUrl(secret.url)
        : sink.kind === "file"
          ? (config.fileName ?? "")
          : `${config.host ?? ""}:${config.port ?? ""}`,
    fileName: config.fileName ?? null,
    auditLag: Math.max(0, heads.audit - sink.auditCursor),
    securityLag: sink.includeSecurity ? Math.max(0, heads.security - sink.securityCursor) : null,
  };
}

/** Where the audit chain and the security records stand now. */
export async function streamHeads(): Promise<StreamHeads & { auditAnchor: number }> {
  const [[chain], [security]] = await Promise.all([
    db
      .select({ headSeq: auditChain.headSeq, anchorSeq: auditChain.anchorSeq })
      .from(auditChain)
      .where(eq(auditChain.id, 1)),
    db
      .select({ headSeq: auditSecurityHead.headSeq })
      .from(auditSecurityHead)
      .where(eq(auditSecurityHead.id, 1)),
  ]);
  return {
    audit: chain?.headSeq ?? 0,
    auditAnchor: chain?.anchorSeq ?? 0,
    security: security?.headSeq ?? 0,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

const HOST_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Set by the client itself; an auth header named like one would be overwritten or doubled. */
const RESERVED_HEADERS = new Set(["content-type", "content-encoding", "content-length", "host"]);

function syslogHost(raw: string | null | undefined): string {
  const host = (raw ?? "").trim().replace(/^\[|\]$/g, "");
  const valid =
    isIP(host) !== 0 ||
    (host.length <= 253 && host.split(".").every((label) => HOST_LABEL.test(label)));
  if (!host || !valid) throw domainError("auditSinkHostInvalid", {}, { status: 400 });
  if (isMetadataHost(host)) throw domainError("auditSinkMetadata", {}, { status: 400 });
  return host;
}

function sinkUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw domainError("auditSinkUrlInvalid", {}, { status: 400 });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw domainError("auditSinkUrlInvalid", {}, { status: 400 });
  }
  if (isMetadataHost(url.hostname)) throw domainError("auditSinkMetadata", {}, { status: 400 });
  // The audit log goes in the body: in the clear only to this network.
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw domainError("auditSinkUrlHttps", {}, { status: 400 });
  }
  return url.toString();
}

function caPem(raw: string | null | undefined): string | undefined {
  const pem = (raw ?? "").trim();
  if (!pem) return undefined;
  try {
    new X509Certificate(pem);
  } catch {
    throw domainError("auditSinkCaInvalid", {}, { status: 400 });
  }
  return pem;
}

export type PreparedSink = {
  name: string;
  kind: SinkKind;
  enabled: boolean;
  includeSecurity: boolean;
  config: string;
  secret: string;
};

/** Validates an add or an edit; blank secret fields keep what `existing` stores. */
export function prepareSink(input: SinkInput, existing: Sink | null): PreparedSink {
  const name = input.name?.trim() ?? "";
  if (!name || name.length > 100) throw domainError("auditSinkNameRequired", {}, { status: 400 });
  const kind = input.kind as SinkKind;
  if (!SINK_KINDS.includes(kind)) throw domainError("auditSinkKindInvalid", {}, { status: 400 });
  const config: Config = {};
  const secret: Secret = {};

  if (kind === "syslog-udp" || kind === "syslog-tcp" || kind === "syslog-tls") {
    config.host = syslogHost(input.host);
    const port = input.port ?? DEFAULT_PORTS[kind];
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw domainError("auditSinkPortInvalid", {}, { status: 400 });
    }
    config.port = port;
    if (kind === "syslog-udp") {
      const maxBytes = input.maxBytes ?? DEFAULT_DATAGRAM_BYTES;
      if (
        !Number.isInteger(maxBytes) ||
        maxBytes < MIN_DATAGRAM_BYTES ||
        maxBytes > MAX_DATAGRAM_BYTES
      ) {
        throw domainError(
          "auditSinkMaxBytesInvalid",
          { min: MIN_DATAGRAM_BYTES, max: MAX_DATAGRAM_BYTES },
          { status: 400 },
        );
      }
      config.maxBytes = maxBytes;
    }
    if (kind === "syslog-tls") config.ca = caPem(input.ca);
  } else if (kind === "http") {
    const stored = existing?.kind === "http" ? existing.secret : {};
    const typed = input.url?.trim();
    const url = typed ? sinkUrl(typed) : stored.url;
    if (!url) throw domainError("auditSinkUrlInvalid", {}, { status: 400 });
    secret.url = url;
    const encoding = (input.encoding ?? "identity") as SinkEncoding;
    if (!SINK_ENCODINGS.includes(encoding)) {
      throw domainError("auditSinkEncodingInvalid", {}, { status: 400 });
    }
    config.encoding = encoding;
    const headerName = input.headerName?.trim() || DEFAULT_HEADER_NAME;
    if (!HEADER_NAME.test(headerName) || RESERVED_HEADERS.has(headerName.toLowerCase())) {
      throw domainError("auditSinkHeaderInvalid", {}, { status: 400 });
    }
    config.headerName = headerName;
    const replacement = input.headerValue?.trim() || null;
    const sameOrigin =
      stored.url !== undefined && new URL(stored.url).origin === new URL(url).origin;
    if (!replacement && !input.clearHeaderValue && stored.headerValue && !sameOrigin) {
      throw domainError("auditSinkSecretReentry", {}, { status: 400 });
    }
    const headerValue = input.clearHeaderValue
      ? ""
      : (replacement ?? (sameOrigin ? stored.headerValue : "") ?? "");
    if (/[\r\n]/.test(headerValue) || headerValue.length > 4096) {
      throw domainError("auditSinkHeaderInvalid", {}, { status: 400 });
    }
    if (headerValue) secret.headerValue = headerValue;
    config.ca = caPem(input.ca);
  } else {
    const fileName = input.fileName?.trim() ?? "";
    if (!FILE_NAME.test(fileName) || fileName.includes("..")) {
      throw domainError("auditSinkFileInvalid", {}, { status: 400 });
    }
    config.fileName = fileName;
  }

  return {
    name,
    kind,
    enabled: input.enabled ?? existing?.enabled ?? true,
    includeSecurity: input.includeSecurity ?? existing?.includeSecurity ?? false,
    config: JSON.stringify(config),
    secret: Object.keys(secret).length > 0 ? encryptSecret(JSON.stringify(secret)) : "",
  };
}

// ── Store ───────────────────────────────────────────────────────────────────

export async function listSinks(): Promise<SinkView[]> {
  const [rows, heads] = await Promise.all([
    db.select().from(auditSinks).orderBy(asc(auditSinks.name)),
    streamHeads(),
  ]);
  return rows.map((row) => sinkView(parseSink(row), heads));
}

export async function getSink(id: number): Promise<Sink | null> {
  const [row] = await db.select().from(auditSinks).where(eq(auditSinks.id, id));
  return row ? parseSink(row) : null;
}

async function requireSink(id: number): Promise<Sink> {
  const sink = await getSink(id);
  if (!sink) throw domainError("auditSinkNotFound", {}, { status: 404 });
  return sink;
}

async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  const [clash] = await db
    .select({ id: auditSinks.id })
    .from(auditSinks)
    .where(eq(auditSinks.name, name));
  if (clash && clash.id !== exceptId) {
    throw domainError("auditSinkNameTaken", { name }, { status: 409 });
  }
}

async function viewOf(id: number): Promise<SinkView> {
  return sinkView(await requireSink(id), await streamHeads());
}

/**
 * Starts from the oldest event the log still holds, so the receiver gets the whole retained
 * chain; security records only from now, since none were queued for it before.
 */
export async function createSink(input: SinkInput, userId: number | null): Promise<SinkView> {
  const prepared = prepareSink(input, null);
  await assertNameFree(prepared.name, null);
  const heads = await streamHeads();
  const at = nowIso();
  const [row] = await db
    .insert(auditSinks)
    .values({
      ...prepared,
      auditCursor: heads.auditAnchor,
      securityCursor: heads.security,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  // Whether ingest keeps security records follows the sinks.
  announce("audit-sinks");
  await logAuditEvent({
    userId,
    action: "create",
    entityType: "audit_sink",
    entityId: row.id,
    summary: `Created audit sink ${row.name}`,
  });
  return viewOf(row.id);
}

export async function updateSink(
  id: number,
  input: SinkInput,
  userId: number | null,
): Promise<SinkView> {
  const existing = await requireSink(id);
  const prepared = prepareSink(input, existing);
  await assertNameFree(prepared.name, id);
  const heads = await streamHeads();
  await db
    .update(auditSinks)
    .set({
      ...prepared,
      // Switched on now: from now, as for a new sink, not from wherever it stopped before.
      ...(prepared.includeSecurity && !existing.includeSecurity
        ? { securityCursor: heads.security }
        : {}),
      encodingFallback: false,
      // A fixed sink deserves a try now rather than after the backoff it earned while broken.
      retryAt: null,
      updatedAt: nowIso(),
    })
    .where(eq(auditSinks.id, id));
  announce("audit-sinks");
  await logAuditEvent({
    userId,
    action: "update",
    entityType: "audit_sink",
    entityId: id,
    summary: `Updated audit sink ${prepared.name}`,
  });
  return viewOf(id);
}

export async function deleteSink(id: number, userId: number | null): Promise<void> {
  const sink = await requireSink(id);
  await db.delete(auditSinks).where(eq(auditSinks.id, id));
  announce("audit-sinks");
  // Closed quietly: nobody needs telling that a sink they removed stopped failing.
  const { resolveProblem } = await import("../notifications");
  await resolveProblem(`${PROBLEM_PREFIX}${id}`, null);
  await logAuditEvent({
    userId,
    action: "delete",
    entityType: "audit_sink",
    entityId: id,
    summary: `Deleted audit sink ${sink.name}`,
  });
}

/** For "Test" on an unsaved form: the sink as typed, blank secrets from the stored one. */
export async function previewSink(input: SinkInput, existingId: number | null): Promise<Sink> {
  const existing = existingId === null ? null : await requireSink(existingId);
  const prepared = prepareSink(input, existing);
  const at = nowIso();
  return parseSink({
    id: existingId ?? 0,
    ...prepared,
    auditCursor: 0,
    securityCursor: 0,
    encodingFallback: false,
    failures: 0,
    retryAt: null,
    lastDeliveredAt: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorCode: null,
    gapStream: null,
    gapFrom: null,
    gapTo: null,
    gapAt: null,
    missed: 0,
    leaseOwner: null,
    leaseUntil: null,
    createdAt: at,
    updatedAt: at,
  });
}
