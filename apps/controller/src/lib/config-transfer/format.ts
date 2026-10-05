/**
 * The portable config file: readable JSON, with every secret sealed on its own under a passphrase
 * by the backup scheme (scrypt, AES-256-GCM), so the rest can be reviewed or kept in a repository.
 * Only the secrets are authenticated; the dry run is where the rest is checked.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MIN_PASSPHRASE_LENGTH, SCRYPT, deriveKey } from "../backup/format";
import { MARKER } from "../backup/secrets";
import { domainError } from "../errors/domain-error";
import { SECRET_KEY } from "../host-review/diff";
import { mapStrings, mapTextColumn } from "../secrets/walk";

export const CONFIG_FORMAT = "cpm-config";
export const CONFIG_VERSION = 1;
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
  tables: ConfigRows;
};

/** Columns holding a secret that is not encrypted at rest (a bcrypt hash). */
const SEALED_COLUMNS: Record<string, readonly string[]> = {
  access_list_entries: ["passwordHash"],
};
/** JSON keys whose whole value is free text that may embed credentials. */
const RAW_TEXT_KEY = /^custom_/;

function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${SEALED}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${body.toString("base64")}`;
}

function unseal(key: Buffer, text: string): string {
  const [iv, tag, body] = text.slice(SEALED.length).split(":");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv ?? "", "base64"));
    decipher.setAuthTag(Buffer.from(tag ?? "", "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body ?? "", "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw domainError("configPassphraseWrong", {}, { status: 400 });
  }
}

/** Secret-looking keys anywhere in a JSON column, sealed in place. */
function sealJsonSecrets(key: Buffer, value: unknown, name = ""): unknown {
  if (typeof value === "string") {
    return value && (SECRET_KEY.test(name) || RAW_TEXT_KEY.test(name)) && !value.startsWith(SEALED)
      ? seal(key, value)
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => sealJsonSecrets(key, item, name));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([field, item]) => [field, sealJsonSecrets(key, item, field)]),
    );
  }
  return value;
}

function sealColumn(key: Buffer, table: string, column: string, value: string): string {
  if (SEALED_COLUMNS[table]?.includes(column)) return seal(key, value);
  // Secrets the backup layer decrypted into markers.
  let out = mapTextColumn(value, MARKER, (text) =>
    text.startsWith(MARKER) ? seal(key, text) : text,
  );
  const trimmed = out.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      out = JSON.stringify(sealJsonSecrets(key, JSON.parse(trimmed)));
    } catch {
      // Not JSON: left as it is.
    }
  }
  return out;
}

export async function sealConfigFile(
  content: Pick<ConfigFile, "appVersion" | "sections" | "refs" | "tables">,
  passphrase: string,
  now = new Date(),
): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw domainError("backupPassphraseTooShort", { min: MIN_PASSPHRASE_LENGTH }, { status: 400 });
  }
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt);
  const tables: ConfigRows = {};
  for (const [table, rows] of Object.entries(content.tables)) {
    tables[table] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          typeof value === "string" ? sealColumn(key, table, column, value) : value,
        ]),
      ),
    );
  }
  const file: ConfigFile = {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    appVersion: content.appVersion,
    exportedAt: now.toISOString(),
    sections: content.sections,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    check: seal(key, CHECK),
    refs: content.refs,
    tables,
  };
  return Buffer.from(`${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Without the passphrase: is it a config file at all, and what does it say it holds. */
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
    !file ||
    file.format !== CONFIG_FORMAT ||
    file.version !== CONFIG_VERSION ||
    typeof file.tables !== "object" ||
    !file.tables ||
    typeof file.kdf?.salt !== "string" ||
    typeof file.check !== "string"
  ) {
    throw domainError("configFileNotRecognised", {}, { status: 400 });
  }
  file.refs = file.refs && typeof file.refs === "object" ? file.refs : {};
  file.sections = Array.isArray(file.sections)
    ? file.sections.filter((s): s is ConfigSection => CONFIG_SECTIONS.includes(s))
    : [];
  return file;
}

/** The file's rows with every sealed value opened back into backup markers, ready for importRow. */
export async function openConfigFile(bytes: Buffer, passphrase: string): Promise<ConfigFile> {
  const file = readConfigFile(bytes);
  const { N, r, p } = file.kdf;
  // As for backups: a crafted file must not name a cost this server would not pay itself.
  if (!(N <= SCRYPT.N && r <= SCRYPT.r && p <= SCRYPT.p && N > 1 && r > 0 && p > 0)) {
    throw domainError("configFileNotRecognised", {}, { status: 400 });
  }
  const key = await deriveKey(passphrase, Buffer.from(file.kdf.salt, "base64"), { N, r, p });
  if (unseal(key, file.check) !== CHECK)
    throw domainError("configPassphraseWrong", {}, { status: 400 });
  const open = (text: string) =>
    mapTextColumn(text, SEALED, (inner) => (inner.startsWith(SEALED) ? unseal(key, inner) : inner));
  const tables: ConfigRows = {};
  for (const [table, rows] of Object.entries(file.tables)) {
    if (!Array.isArray(rows)) continue;
    tables[table] = rows
      .filter((row) => row && typeof row === "object" && !Array.isArray(row))
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([column, value]) => [
            column,
            typeof value === "string" ? open(value) : mapStrings(value, (s) => s),
          ]),
        ),
      );
  }
  return { ...file, tables };
}
