/**
 * Runtime checks for what an agent sends. An agent is less trusted than the controller, and a
 * signature only proves who sent a value, not its shape - so every field is checked and bounded,
 * extra fields are dropped, and a bad value is refused rather than cast.
 */
import {
  AGENT_CAPABILITIES,
  AGENT_STATUS_MESSAGES,
  type AgentCapability,
  type AgentCommandResult,
  type AgentErrorCode,
  type AgentStatus,
  type AgentStatusMessageCode,
  type AgentStatusMessageParams,
  type CaddyAdminProxyResponse,
  type CaddyCertificate,
  CERTIFICATE_FILE_ERRORS,
  type CertificateFileEntry,
  type CertificateFileResult,
  type CertificateFileSource,
  type ExternalCaddyImage,
  type CertificateFiles,
  type LogAccessProblemKind,
  type LogAccessReport,
  type LogReadResponse,
  MANAGED_SERVICES,
  MAX_CADDY_CONFIG_BYTES,
} from "./agent-protocol";
import {
  CERTIFICATE_FILE_MAX_BYTES,
  CERTIFICATE_FILES_MAX,
  isValidCertificateFilePath,
} from "./certificate-files";

export class AgentDecodeError extends Error {
  constructor(readonly path: string) {
    super(`Malformed agent data at ${path}`);
    this.name = "AgentDecodeError";
  }
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

function object(value: unknown, path: string): Json {
  if (!isObject(value)) throw new AgentDecodeError(path);
  return value;
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new AgentDecodeError(path);
  return value;
}

function optionalString(value: unknown, path: string, max: number): string | undefined {
  return value === undefined || value === null ? undefined : string(value, path, max);
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new AgentDecodeError(path);
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AgentDecodeError(path);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new AgentDecodeError(path);
  }
  return value as T;
}

function array<T>(
  value: unknown,
  path: string,
  max: number,
  item: (entry: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) throw new AgentDecodeError(path);
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

const SHORT = 256;
const MESSAGE = 4096;

const OPERATION_STATES = ["idle", "pending", "applying", "applied", "failed"] as const;
const BUILD_STATES = ["idle", "pending", "building", "applied", "failed"] as const;

const MAX_MESSAGE_PARAMS = 8;

/** A code this controller does not know is dropped, not refused: a newer agent may send one. */
function messageCode(value: unknown, path: string): AgentStatusMessageCode | undefined {
  const code = optionalString(value, path, SHORT);
  return (AGENT_STATUS_MESSAGES as readonly string[]).includes(code ?? "")
    ? (code as AgentStatusMessageCode)
    : undefined;
}

function messageParams(value: unknown, path: string): AgentStatusMessageParams | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = object(value, path);
  const entries = Object.entries(raw);
  if (entries.length > MAX_MESSAGE_PARAMS) throw new AgentDecodeError(path);
  const params: AgentStatusMessageParams = {};
  for (const [key, param] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) throw new AgentDecodeError(path);
    params[key] =
      typeof param === "number" && Number.isFinite(param)
        ? param
        : string(param, `${path}.${key}`, MESSAGE);
  }
  return params;
}

function operation<S extends string>(value: unknown, path: string, states: readonly S[]) {
  const raw = object(value, path);
  return {
    state: oneOf(raw.state, `${path}.state`, states),
    message: optionalString(raw.message, `${path}.message`, MESSAGE),
    messageCode: messageCode(raw.messageCode, `${path}.messageCode`),
    messageParams: messageParams(raw.messageParams, `${path}.messageParams`),
    appliedAt: optionalString(raw.appliedAt, `${path}.appliedAt`, SHORT),
    triggeredAt: optionalString(raw.triggeredAt, `${path}.triggeredAt`, SHORT),
    error: optionalString(raw.error, `${path}.error`, MESSAGE),
  };
}

function externalImage(value: unknown, path: string): ExternalCaddyImage {
  const raw = object(value, path);
  return {
    image: raw.image === null ? null : string(raw.image, `${path}.image`, 1024),
    puid: string(raw.puid, `${path}.puid`, 16),
    pgid: string(raw.pgid, `${path}.pgid`, 16),
  };
}

const PROBLEM_KINDS: readonly LogAccessProblemKind[] = [
  "unreadable",
  "notTruncatable",
  "cleanupBlocked",
];

function logAccess(value: unknown, path: string): LogAccessReport {
  const raw = object(value, path);
  return {
    caddyContainer: string(raw.caddyContainer, `${path}.caddyContainer`, SHORT),
    agentGroups: array(raw.agentGroups, `${path}.agentGroups`, 256, (g, p) =>
      integer(g, p, 0, 2 ** 32),
    ),
    caddyGid: raw.caddyGid === null ? null : integer(raw.caddyGid, `${path}.caddyGid`, 0, 2 ** 32),
    problems: array(raw.problems, `${path}.problems`, 256, (entry, p) => {
      const problem = object(entry, p);
      return {
        kind: oneOf(problem.kind, `${p}.kind`, PROBLEM_KINDS),
        path: string(problem.path, `${p}.path`, 4096),
        uid: integer(problem.uid, `${p}.uid`, 0, 2 ** 32),
        gid: integer(problem.gid, `${p}.gid`, 0, 2 ** 32),
        mode: integer(problem.mode, `${p}.mode`, 0, 0o177777),
      };
    }),
  };
}

export function decodeAgentStatus(value: unknown): AgentStatus {
  const raw = object(value, "status");
  const l4 = object(raw.l4Ports, "status.l4Ports");
  const build = object(raw.caddyBuild, "status.caddyBuild");
  const services = object(raw.services, "status.services");
  const analytics = object(raw.analytics, "status.analytics");
  const applied = services.applied;
  return {
    agentId: string(raw.agentId, "status.agentId", SHORT),
    version: string(raw.version, "status.version", SHORT),
    mode: oneOf(raw.mode, "status.mode", ["standalone", "managed"] as const),
    composeProject: string(raw.composeProject, "status.composeProject", SHORT),
    l4Ports: {
      applied: array(l4.applied, "status.l4Ports.applied", 4096, (p, path) =>
        string(p, path, SHORT),
      ),
      status: operation(l4.status, "status.l4Ports.status", OPERATION_STATES),
    },
    caddyBuild: {
      applied:
        build.applied === null
          ? null
          : array(build.applied, "status.caddyBuild.applied", 1024, (m, path) =>
              string(m, path, 1024),
            ),
      status: operation(build.status, "status.caddyBuild.status", BUILD_STATES),
      ...(build.external === undefined
        ? {}
        : { external: externalImage(build.external, "status.caddyBuild.external") }),
    },
    services: {
      applied:
        applied === null
          ? null
          : (Object.fromEntries(
              MANAGED_SERVICES.map((name) => [
                name,
                boolean(
                  object(applied, "status.services.applied")[name] ?? false,
                  `status.services.applied.${name}`,
                ),
              ]),
            ) as AgentStatus["services"]["applied"]),
      status: operation(services.status, "status.services.status", OPERATION_STATES),
    },
    analytics: {
      enabled: boolean(analytics.enabled, "status.analytics.enabled"),
      accessLogPresent: boolean(analytics.accessLogPresent, "status.analytics.accessLogPresent"),
    },
    logAccess:
      raw.logAccess === undefined ? undefined : logAccess(raw.logAccess, "status.logAccess"),
    // Unknown kinds are a newer agent's, not an error; only the known ones are acted on.
    capabilities:
      raw.capabilities === undefined
        ? undefined
        : array(raw.capabilities, "status.capabilities", 64, (c, p) => string(c, p, SHORT)).filter(
            (c): c is AgentCapability => (AGENT_CAPABILITIES as readonly string[]).includes(c),
          ),
  };
}

export function decodeCaddyAdminResponse(
  value: unknown,
  path = "response",
): CaddyAdminProxyResponse {
  const raw = object(value, path);
  const headers = raw.headers === undefined ? {} : object(raw.headers, `${path}.headers`);
  const entries = Object.entries(headers);
  if (entries.length > 128) throw new AgentDecodeError(`${path}.headers`);
  return {
    status: integer(raw.status, `${path}.status`, 100, 599),
    // A GET of the whole config can be as large as the largest config a load accepts.
    text: string(raw.text, `${path}.text`, MAX_CADDY_CONFIG_BYTES),
    headers: Object.fromEntries(
      entries.map(([name, v]) => [
        string(name, `${path}.headers`, SHORT),
        string(v, `${path}.headers.${name}`, MESSAGE),
      ]),
    ),
  };
}

const ERROR_CODES: readonly AgentErrorCode[] = [
  "UNAUTHENTICATED",
  "PAIRING_DISABLED",
  "PAIRING_CODE_INVALID",
  "PAIRING_CODE_EXPIRED",
  "BAD_REQUEST",
  "BUSY",
  "INTERNAL",
];

export type DecodedCommandResult =
  | AgentCommandResult
  /** An id we could read around a body we couldn't: its waiter still has to be told. */
  | { id: string; malformed: true };

/** Throws only when `results` isn't a bounded list; a bad entry is reported, not fatal. */
export function decodeCommandResults(value: unknown): DecodedCommandResult[] {
  if (!Array.isArray(value) || value.length > 256) throw new AgentDecodeError("results");
  const decoded: DecodedCommandResult[] = [];
  value.forEach((entry, index) => {
    const path = `results[${index}]`;
    if (!isObject(entry) || typeof entry.id !== "string" || entry.id.length > SHORT) return;
    try {
      if (entry.ok === true) {
        decoded.push({
          id: entry.id,
          ok: true,
          response: decodeCaddyAdminResponse(entry.response, `${path}.response`),
        });
      } else if (entry.ok === false) {
        decoded.push({
          id: entry.id,
          ok: false,
          error: string(entry.error, `${path}.error`, MESSAGE),
          code: oneOf(entry.code, `${path}.code`, ERROR_CODES),
        });
      } else {
        throw new AgentDecodeError(`${path}.ok`);
      }
    } catch (error) {
      if (!(error instanceof AgentDecodeError)) throw error;
      decoded.push({ id: entry.id, malformed: true });
    }
  });
  return decoded;
}

function parse(text: string, path: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentDecodeError(path);
  }
}

const DNS_NAME = 253;

export function decodeCertificateList(text: string): CaddyCertificate[] {
  return array(parse(text, "certificates"), "certificates", 20_000, (entry, path) => {
    const raw = object(entry, path);
    const date = (v: unknown, p: string) => {
      const s = string(v, p, SHORT);
      if (Number.isNaN(Date.parse(s))) throw new AgentDecodeError(p);
      return s;
    };
    return {
      issuerKey: string(raw.issuerKey, `${path}.issuerKey`, DNS_NAME),
      name: string(raw.name, `${path}.name`, DNS_NAME),
      names: array(raw.names, `${path}.names`, 1000, (n, p) => string(n, p, DNS_NAME)),
      issuer: string(raw.issuer, `${path}.issuer`, 1024),
      notBefore: date(raw.notBefore, `${path}.notBefore`),
      notAfter: date(raw.notAfter, `${path}.notAfter`),
      fingerprint: string(raw.fingerprint, `${path}.fingerprint`, SHORT),
    };
  });
}

/** A PEM chain or key is kilobytes; a megabyte leaves room without being unbounded. */
const PEM = 1024 * 1024;

export function decodeCertificateFiles(text: string): CertificateFiles {
  const raw = object(parse(text, "certificateFiles"), "certificateFiles");
  const files: CertificateFiles = {
    certificatePem: string(raw.certificatePem, "certificateFiles.certificatePem", PEM),
  };
  const keyPem = optionalString(raw.keyPem, "certificateFiles.keyPem", PEM);
  if (keyPem !== undefined) files.keyPem = keyPem;
  return files;
}

/** The agent's own cap (apps/agent/src/logs.ts). */
const LOG_LINES_MAX = 1000;
const LOG_LINE = 64 * 1024;

export function decodeLogReadResponse(text: string): LogReadResponse {
  const raw = object(parse(text, "log"), "log");
  const response: LogReadResponse = {
    lines: array(raw.lines, "log.lines", LOG_LINES_MAX, (l, p) => string(l, p, LOG_LINE)),
    cursor: raw.cursor === null ? null : string(raw.cursor, "log.cursor", SHORT),
  };
  if (raw.truncated !== undefined) response.truncated = boolean(raw.truncated, "log.truncated");
  if (raw.missing !== undefined) response.missing = boolean(raw.missing, "log.missing");
  return response;
}

// ─── Certificates from files ─────────────────────────────────────────────────

const FILE_PATH = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function certificateId(value: unknown, path: string): number {
  return integer(value, path, 0, 2 ** 31 - 1);
}

/**
 * The agent's check of what the controller asks it to read. Shape only: a bad path is reported
 * back per entry as `invalid-path`, so one entry cannot hide the rest.
 */
export function decodeCertificateFileSources(value: unknown): CertificateFileSource[] {
  return array(value, "certificateFiles", CERTIFICATE_FILES_MAX, (entry, path) => {
    const raw = object(entry, path);
    return {
      id: certificateId(raw.id, `${path}.id`),
      certPath: string(raw.certPath, `${path}.certPath`, FILE_PATH),
      keyPath: string(raw.keyPath, `${path}.keyPath`, FILE_PATH),
    };
  });
}

/** Throws only when `results` is not a bounded list of well-formed entries. */
export function decodeCertificateFileResults(value: unknown): CertificateFileResult[] {
  return array(value, "results", CERTIFICATE_FILES_MAX, (entry, path) => {
    const raw = object(entry, path);
    const id = certificateId(raw.id, `${path}.id`);
    if (raw.ok === false) {
      return { id, ok: false, error: oneOf(raw.error, `${path}.error`, CERTIFICATE_FILE_ERRORS) };
    }
    if (raw.ok !== true) throw new AgentDecodeError(`${path}.ok`);
    const fingerprint = string(raw.fingerprint, `${path}.fingerprint`, 64);
    if (!SHA256_HEX.test(fingerprint)) throw new AgentDecodeError(`${path}.fingerprint`);
    const certificatePem = optionalString(
      raw.certificatePem,
      `${path}.certificatePem`,
      CERTIFICATE_FILE_MAX_BYTES,
    );
    const keyPem = optionalString(raw.keyPem, `${path}.keyPem`, CERTIFICATE_FILE_MAX_BYTES);
    // Both or neither: a chain without its key cannot be stored or checked.
    if ((certificatePem === undefined) !== (keyPem === undefined)) {
      throw new AgentDecodeError(`${path}.keyPem`);
    }
    return certificatePem === undefined
      ? { id, ok: true, fingerprint }
      : { id, ok: true, fingerprint, certificatePem, keyPem };
  });
}

export function decodeCertificateFileListing(text: string): CertificateFileEntry[] {
  return array(parse(text, "certificateFiles"), "certificateFiles", 5000, (entry, path) => {
    const raw = object(entry, path);
    if (!isValidCertificateFilePath(raw.path)) throw new AgentDecodeError(`${path}.path`);
    const kind = oneOf(raw.kind, `${path}.kind`, ["certificate", "key"] as const);
    if (kind === "key") return { path: raw.path, kind };
    const notAfter = string(raw.notAfter, `${path}.notAfter`, SHORT);
    if (Number.isNaN(Date.parse(notAfter))) throw new AgentDecodeError(`${path}.notAfter`);
    return {
      path: raw.path,
      kind,
      names: array(raw.names, `${path}.names`, 1000, (n, p) => string(n, p, DNS_NAME)),
      notAfter,
      fingerprint: string(raw.fingerprint, `${path}.fingerprint`, SHORT),
    };
  });
}
