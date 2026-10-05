/**
 * The portable config file: readable JSON, with every secret sealed on its own under a passphrase
 * by the backup scheme (scrypt, AES-256-GCM), so the rest can be reviewed or kept in a repository.
 * An HMAC over the whole file, under a subkey of the same passphrase, makes the rest tamper-evident:
 * a file edited without the passphrase is refused before anything in it is planned.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { MIN_PASSPHRASE_LENGTH, SCRYPT, deriveKey } from "../backup/format";
import { MARKER } from "../backup/secrets";
import { domainError } from "../errors/domain-error";
import { SECRET_KEY } from "../host-review/diff";

export const CONFIG_FORMAT = "cpm-config";
/** 2 added the MAC and bound each sealed value to where it sits. Nothing older is read. */
export const CONFIG_VERSION = 2;
export const MAX_CONFIG_BYTES = 50 * 1024 * 1024;
const SEALED = "cpmcfg-sealed:";
const CHECK = "cpm-config-passphrase-check";

export const CONFIG_SECTIONS = [
  "hosts",
  "accessLists",
  "certificates",
  "groups",
  "security",
  "settings",
] as const;
export type ConfigSection = (typeof CONFIG_SECTIONS)[number];

export type ConfigRows = Record<string, Record<string, unknown>[]>;

export type ConfigFile = {
  format: typeof CONFIG_FORMAT;
  version: typeof CONFIG_VERSION;
  appVersion: string;
  exportedAt: string;
  sections: ConfigSection[];
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  /** A known string sealed with the key, so a wrong passphrase fails before anything is read. */
  check: string;
  /** The natural key (a name, an email) of rows the file points at but does not carry. */
  refs: Record<string, Record<string, string>>;
  /** What the preview calls a referenced row whose key is not readable, such as an agent's id. */
  refLabels: Record<string, Record<string, string>>;
  tables: ConfigRows;
  /** HMAC-SHA256 over everything above, in canonical form. */
  mac: string;
};

type FileBody = Omit<ConfigFile, "mac">;

/** Columns holding a secret that is not encrypted at rest (a bcrypt hash). */
const SEALED_COLUMNS: Record<string, readonly string[]> = {
  access_list_entries: ["passwordHash"],
};
/** JSON keys whose whole value is free text that may embed credentials. */
const RAW_TEXT_KEY = /^custom_/;

type Keys = { seal: Buffer; mac: Buffer };

/** Separate subkeys, so the MAC key is never also an encryption key. */
function subkeys(master: Buffer, salt: Buffer): Keys {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, salt, info, 32));
  return { seal: derive("cpm-config:v2:seal"), mac: derive("cpm-config:v2:mac") };
}

/**
 * Where a sealed value sits: table, row, column and JSON path. The row is its id in the file
 * (a setting's key), which unlike a name is unique there, so a blob cannot change places.
 */
function placeOf(table: string, row: Record<string, unknown>, column: string, path: string[]) {
  return JSON.stringify([table, String(row.id ?? row.key ?? ""), column, ...path]);
}

function seal(key: Buffer, plaintext: string, place: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(place, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${SEALED}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

function unseal(key: Buffer, text: string, place: string): string {
  const [iv, tag, body] = text.slice(SEALED.length).split(":");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv ?? "", "base64"));
    decipher.setAAD(Buffer.from(place, "utf8"));
    decipher.setAuthTag(Buffer.from(tag ?? "", "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body ?? "", "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw domainError("configFileTampered", {}, { status: 400 });
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Every string in a parsed JSON value, with its path and the key holding it. JSON kept as text
 * inside it is walked too, its path marked with "#".
 */
function walkStrings(
  value: unknown,
  path: string[],
  name: string,
  needle: string,
  leaf: (text: string, path: string[], name: string) => string,
): unknown {
  if (typeof value === "string") {
    if (!value.startsWith(needle) && value.includes(needle) && looksLikeJson(value)) {
      const inner = parseJson(value);
      if (inner !== undefined) {
        return JSON.stringify(walkStrings(inner, [...path, "#"], name, needle, leaf));
      }
    }
    return leaf(value, path, name);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      walkStrings(item, [...path, String(index)], name, needle, leaf),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        walkStrings(item, [...path, key], key, needle, leaf),
      ]),
    );
  }
  return value;
}

function sealColumn(
  key: Buffer,
  table: string,
  row: Record<string, unknown>,
  column: string,
  value: string,
): string {
  const at = (path: string[]) => placeOf(table, row, column, path);
  if (SEALED_COLUMNS[table]?.includes(column) || value.startsWith(MARKER)) {
    return seal(key, value, at([]));
  }
  if (!looksLikeJson(value)) return value;
  const parsed = parseJson(value);
  if (parsed === undefined) return value;
  // Secrets the backup layer decrypted into markers, and secret-looking keys left in the clear.
  const sealed = walkStrings(parsed, [], "", MARKER, (text, path, name) =>
    text.startsWith(MARKER) || (text && (SECRET_KEY.test(name) || RAW_TEXT_KEY.test(name)))
      ? seal(key, text, at(path))
      : text,
  );
  return JSON.stringify(sealed);
}

function openColumn(
  key: Buffer,
  table: string,
  row: Record<string, unknown>,
  column: string,
  value: string,
): string {
  const at = (path: string[]) => placeOf(table, row, column, path);
  if (value.startsWith(SEALED)) return unseal(key, value, at([]));
  if (!value.includes(SEALED) || !looksLikeJson(value)) return value;
  const parsed = parseJson(value);
  if (parsed === undefined) return value;
  const opened = walkStrings(parsed, [], "", SEALED, (text, path) =>
    text.startsWith(SEALED) ? unseal(key, text, at(path)) : text,
  );
  return JSON.stringify(opened);
}

/** Sorted keys at every depth: the bytes the MAC covers, whatever the file's own spacing. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((field) => (value as Record<string, unknown>)[field] !== undefined)
      .map(
        (field) =>
          `${JSON.stringify(field)}:${canonicalJson((value as Record<string, unknown>)[field])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function macOf(key: Buffer, body: FileBody): string {
  return createHmac("sha256", key)
    .update(`${CONFIG_FORMAT}:${CONFIG_VERSION}\n${canonicalJson(body)}`)
    .digest("base64");
}

export async function sealConfigFile(
  content: Pick<ConfigFile, "appVersion" | "sections" | "refs" | "refLabels" | "tables">,
  passphrase: string,
  now = new Date(),
): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw domainError("backupPassphraseTooShort", { min: MIN_PASSPHRASE_LENGTH }, { status: 400 });
  }
  const salt = randomBytes(16);
  const keys = subkeys(await deriveKey(passphrase, salt), salt);
  const tables: ConfigRows = {};
  for (const [table, rows] of Object.entries(content.tables)) {
    tables[table] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          typeof value === "string" ? sealColumn(keys.seal, table, row, column, value) : value,
        ]),
      ),
    );
  }
  const body: FileBody = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    appVersion: content.appVersion,
    exportedAt: now.toISOString(),
    sections: content.sections,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    check: seal(keys.seal, CHECK, "check"),
    refs: content.refs,
    refLabels: content.refLabels,
    tables,
  };
  const file: ConfigFile = { ...body, mac: macOf(keys.mac, body) };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, "utf8");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Without the passphrase: is it a config file at all, and what does it say it holds. Nothing here
 * is authenticated yet; only `openConfigFile` vouches for it.
 */
export function readConfigFile(bytes: Buffer): ConfigFile {
  if (bytes.length > MAX_CONFIG_BYTES) {
    throw domainError("configFileTooLarge", { max: "50 MiB" }, { status: 400 });
  }
  let file: ConfigFile;
  try {
    file = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw domainError("configFileNotRecognised", {}, { status: 400 });
  }
  if (
    !isRecord(file) ||
    file.format !== CONFIG_FORMAT ||
    file.version !== CONFIG_VERSION ||
    !isRecord(file.tables) ||
    typeof file.kdf?.salt !== "string" ||
    typeof file.check !== "string" ||
    typeof file.mac !== "string" ||
    typeof file.appVersion !== "string" ||
    typeof file.exportedAt !== "string" ||
    !Array.isArray(file.sections) ||
    !isRecord(file.refs) ||
    !isRecord(file.refLabels)
  ) {
    throw domainError("configFileNotRecognised", {}, { status: 400 });
  }
  return file;
}

/**
 * The file authenticated, then its rows with every sealed value opened back into backup markers,
 * ready for importRow. Anything the MAC does not vouch for is refused before it is read.
 */
export async function openConfigFile(bytes: Buffer, passphrase: string): Promise<ConfigFile> {
  const file = readConfigFile(bytes);
  const { N, r, p } = file.kdf;
  // As for backups: a crafted file must not name a cost this server would not pay itself.
  if (!(N <= SCRYPT.N && r <= SCRYPT.r && p <= SCRYPT.p && N > 1 && r > 0 && p > 0)) {
    throw domainError("configFileNotRecognised", {}, { status: 400 });
  }
  const salt = Buffer.from(file.kdf.salt, "base64");
  const keys = subkeys(await deriveKey(passphrase, salt, { N, r, p }), salt);
  let check: string | null = null;
  try {
    check = unseal(keys.seal, file.check, "check");
  } catch {
    check = null;
  }
  if (check !== CHECK) throw domainError("configPassphraseWrong", {}, { status: 400 });

  const { mac, ...body } = file;
  const expected = Buffer.from(macOf(keys.mac, body), "base64");
  const given = Buffer.from(mac, "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw domainError("configFileTampered", {}, { status: 400 });
  }

  const tables: ConfigRows = {};
  for (const [table, rows] of Object.entries(file.tables)) {
    if (!Array.isArray(rows)) continue;
    tables[table] = rows
      .filter(isRecord)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            typeof value === "string" ? openColumn(keys.seal, table, row, column, value) : value,
          ]),
        ),
      );
  }
  const sections = file.sections.filter((s): s is ConfigSection => CONFIG_SECTIONS.includes(s));
  return { ...file, sections, tables };
}
