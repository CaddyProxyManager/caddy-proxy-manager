/**
 * How the environment names the database. A leaf module, so drizzle.config.ts and tests can use it
 * without the driver. POSTGRES_* exist because Compose interpolates an unencoded password into a
 * URL, where `/`, `@`, `#` or `?` break it; DATABASE_URL still wins, as it carries more options.
 */
import { isAbsolute, resolve as resolvePath } from "node:path";

export type DatabaseDialect = "postgres" | "sqlite";

export type DatabaseTarget =
  /** An absolute filesystem path, or the literal ":memory:". */
  | { kind: "sqlite"; path: string }
  | { kind: "url"; url: string }
  | {
      kind: "fields";
      hostname: string;
      port: number;
      username: string;
      password: string;
      database: string;
      tls: boolean;
    };

/** Named so an operator pointing at one of these gets a straight answer. */
const UNSUPPORTED_SCHEMES = new Map<string, string>([
  ["mysql", "MySQL"],
  ["mariadb", "MariaDB"],
  ["mssql", "SQL Server"],
  ["sqlserver", "SQL Server"],
  ["mongodb", "MongoDB"],
]);

const SQLITE_SCHEMES = new Set(["file", "sqlite"]);

/** What the bundled compose stack runs, so an operator who sets only a password gets it. */
const FIELD_DEFAULTS = {
  hostname: "postgres",
  port: 5432,
  username: "cpm",
  database: "cpm",
} as const;

/** The scheme of a URL-shaped string, lowercased. Null for bare filesystem paths. */
function schemeOf(rawUrl: string): string | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rawUrl);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  // Windows drive letters ("C:\data\app.db") parse as a one-character scheme.
  return scheme.length === 1 ? null : scheme;
}

const MISSING_MESSAGE =
  "No database is configured. Set POSTGRES_PASSWORD (with POSTGRES_HOST, POSTGRES_PORT, " +
  "POSTGRES_USER and POSTGRES_DB as needed), or DATABASE_URL for a full connection string - " +
  "postgres://user:pass@host:5432/db, or file:/app/data/cpm.db for SQLite.";

const EXAMPLES = "(postgres://user:pass@host:5432/db, or file:/app/data/cpm.db for SQLite)";

/**
 * A `file:` URL's Windows path arrives as "/C:/data/app.db". Not `fileURLToPath`, which rejects
 * POSIX-style file URLs on Windows; on POSIX "/C:/x" is a real path, hence `platform`.
 */
export function stripLeadingSlashBeforeDriveLetter(
  pathname: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return pathname;
  return /^\/[A-Za-z]:[/\\]/.test(pathname) ? pathname.slice(1) : pathname;
}

const MEMORY = new Set([":memory:", "file::memory:", "sqlite::memory:"]);

/** A SQLite DATABASE_URL as an absolute path, relative ones against the working directory. */
export function resolveSqlitePath(rawUrl: string, cwd: string = process.cwd()): string {
  if (MEMORY.has(rawUrl)) return ":memory:";

  // `sqlite:` reads exactly like `file:` past the scheme.
  const url = rawUrl.replace(/^sqlite:/i, "file:");
  if (!/^file:/i.test(url)) {
    return isAbsolute(url) ? url : resolvePath(cwd, url);
  }

  const remainder = url.slice("file:".length);
  // `file:./x` and `file:x` are relative, which a URL parser would root at `/`.
  if (!remainder.startsWith("/")) {
    if (!remainder) throw new Error("DATABASE_URL names a SQLite file without a path.");
    return resolvePath(cwd, remainder);
  }

  const parsed = new URL(url);
  if (parsed.host && parsed.host !== "localhost") {
    throw new Error(`DATABASE_URL names a SQLite file on another host (${parsed.host}).`);
  }
  return stripLeadingSlashBeforeDriveLetter(decodeURIComponent(parsed.pathname));
}

/** Undefined for blank too, which .env files produce easily. */
function read(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function targetFromUrl(url: string): DatabaseTarget {
  const scheme = schemeOf(url);
  if (scheme === "postgres" || scheme === "postgresql") {
    return { kind: "url", url };
  }

  // A bare path is what a pre-3.0 .env carries when it names the file directly.
  if (MEMORY.has(url) || scheme === null || SQLITE_SCHEMES.has(scheme)) {
    return { kind: "sqlite", path: resolveSqlitePath(url) };
  }

  const unsupported = UNSUPPORTED_SCHEMES.get(scheme);
  throw new Error(
    unsupported
      ? `DATABASE_URL names ${unsupported}, which is not supported. Use PostgreSQL or SQLite ${EXAMPLES}.`
      : `DATABASE_URL has an unrecognized scheme "${scheme}". Use PostgreSQL or SQLite ${EXAMPLES}.`,
  );
}

/**
 * For picking a schema before a connection exists. Never throws: a misconfiguration is
 * ./connection.ts's to report.
 */
export function databaseDialect(
  env: Record<string, string | undefined> = process.env,
): DatabaseDialect {
  const url = read(env, "DATABASE_URL");
  if (!url) return "postgres";
  const scheme = schemeOf(url);
  return MEMORY.has(url) || scheme === null || SQLITE_SCHEMES.has(scheme) ? "sqlite" : "postgres";
}

/** Refuses a bad port rather than defaulting past it. */
function portFrom(raw: string | undefined): number {
  if (raw === undefined) return FIELD_DEFAULTS.port;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`POSTGRES_PORT must be a port number between 1 and 65535, not "${raw}".`);
  }
  return port;
}

/** Plain on/off, not an sslmode: a half-modelled mapping is worse than none. Use DATABASE_URL. */
function tlsFrom(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.toLowerCase();
  if (["true", "1", "yes", "on", "require"].includes(normalized)) return true;
  if (["false", "0", "no", "off", "disable"].includes(normalized)) return false;
  throw new Error(`POSTGRES_SSL must be true or false, not "${raw}".`);
}

export function resolveDatabaseTarget(
  env: Record<string, string | undefined> = process.env,
): DatabaseTarget {
  const url = read(env, "DATABASE_URL");
  if (url) return targetFromUrl(url);

  // The rest default to the bundled stack, so without a password nothing is configured.
  const password = read(env, "POSTGRES_PASSWORD");
  if (password === undefined) {
    throw new Error(MISSING_MESSAGE);
  }

  return {
    kind: "fields",
    hostname: read(env, "POSTGRES_HOST") ?? FIELD_DEFAULTS.hostname,
    port: portFrom(read(env, "POSTGRES_PORT")),
    username: read(env, "POSTGRES_USER") ?? FIELD_DEFAULTS.username,
    password,
    database: read(env, "POSTGRES_DB") ?? FIELD_DEFAULTS.database,
    tls: tlsFrom(read(env, "POSTGRES_SSL")),
  };
}

/** `kind` is the only field that is ours rather than the driver's. */
export function driverOptions(
  target: Exclude<DatabaseTarget, { kind: "sqlite" }>,
): Record<string, string | number | boolean | undefined> {
  const { kind: _kind, ...options } = target;
  return options;
}
