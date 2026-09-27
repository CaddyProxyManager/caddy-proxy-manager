/**
 * Re-encrypts a pre-3.0 database's secrets under this deployment's `SESSION_SECRET` on import, so
 * the operator gives the old secret once instead of adopting it forever. Nothing stores it.
 * Tokens are found by the `enc:v1:` marker, whole-column or inside JSON, not by column name, so a
 * column added later is covered without anyone updating a list here.
 */
import { Database } from "bun:sqlite";
import { config } from "../config";
import { decryptSecretWith, encryptSecret, isEncryptedSecret } from "../secret";

/** How many samples `probeLegacySecrets` collects before it stops reading. */
const SAMPLE_LIMIT = 25;

export type LegacySecretProbe = {
  /** Whether the database holds any encrypted value at all. */
  hasEncryptedValues: boolean;
  /** True is the ordinary upgrade: the same `SESSION_SECRET` carried over, no key needed. */
  readableWithCurrentKey: boolean;
  /** A few tokens, kept so a key the operator types can be checked before the import starts. */
  samples: string[];
};

/** Read-only and cheap enough to run while rendering: the read stops at `SAMPLE_LIMIT` tokens. */
export function probeLegacySecrets(sqlitePath: string): LegacySecretProbe {
  const samples = collectSamples(sqlitePath);
  return {
    hasEncryptedValues: samples.length > 0,
    // Vacuously true with nothing to read, which is the answer the caller wants: a database with
    // no secrets in it never needs a key.
    readableWithCurrentKey: samples.every(
      (sample) => decryptSecretWith(sample, config.sessionSecret) !== null,
    ),
    samples,
  };
}

/** Whether `sessionSecret` decrypts the samples a probe collected. */
export function verifyLegacyKey(probe: LegacySecretProbe, sessionSecret: string): boolean {
  if (probe.samples.length === 0) return false;
  return probe.samples.every((sample) => decryptSecretWith(sample, sessionSecret) !== null);
}

/**
 * Throws on a value it cannot read. The importer runs it over every row before writing, so a wrong
 * key fails before a row lands rather than leaving a half-populated database.
 */
export type Rekeyer = (value: string) => string;

/** Why a legacy secret could not be read: no old key was given, or the one given is wrong. */
export type LegacySecretReason = "keyMissing" | "keyWrong";

const LEGACY_SECRET_ENGLISH: Record<LegacySecretReason, string> = {
  keyMissing:
    "This database holds secrets encrypted with a different SESSION_SECRET than this deployment " +
    "uses. Enter the old one to bring them across.",
  keyWrong:
    "The SESSION_SECRET provided does not decrypt this database's secrets. Check it against the " +
    "`.env` the old installation ran with.",
};

/**
 * Carries the reason and the table rather than only a sentence, so the setup route can say it in
 * the reader's language (`setup.migrateErrors.*`). The English stays as the message, for the log.
 */
export class LegacySecretError extends Error {
  readonly reason: LegacySecretReason;
  readonly table: string | undefined;

  constructor(reason: LegacySecretReason, table?: string) {
    const sentence = LEGACY_SECRET_ENGLISH[reason];
    super(table ? `${sentence} (reading ${table})` : sentence);
    this.name = "LegacySecretError";
    this.reason = reason;
    this.table = table;
  }
}

/**
 * `legacyKey` is null when the secret has not changed. Values the current key reads are returned
 * byte-for-byte, so a migration that needed no key can still be repeated against the original file.
 */
export function createRekeyer(legacyKey: string | null): Rekeyer {
  return (value: string): string => {
    if (!value.includes("enc:v1:")) return value;

    if (isEncryptedSecret(value)) return rekeyToken(value, legacyKey);

    // Something inside is a token. Only JSON columns do this, so parse: a substring rewrite would
    // depend on where a token ends, and trailing base64 has no reliable delimiter.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      // A `enc:v1:` inside something that is not JSON and not a token is not ours to touch.
      return value;
    }

    const mapped = mapStrings(parsed, (text) =>
      isEncryptedSecret(text) ? rekeyToken(text, legacyKey) : text,
    );
    return JSON.stringify(mapped);
  };
}

/** One token: left alone if this deployment can already read it, otherwise re-encrypted. */
function rekeyToken(token: string, legacyKey: string | null): string {
  if (decryptSecretWith(token, config.sessionSecret) !== null) return token;

  if (!legacyKey) {
    throw new LegacySecretError("keyMissing");
  }

  const plaintext = decryptSecretWith(token, legacyKey);
  if (plaintext === null) {
    throw new LegacySecretError("keyWrong");
  }

  return encryptSecret(plaintext);
}

/** Apply `map` to every string in a parsed JSON value, preserving the structure around them. */
function mapStrings(input: unknown, map: (text: string) => string): unknown {
  if (typeof input === "string") return map(input);
  if (Array.isArray(input)) return input.map((entry) => mapStrings(entry, map));
  if (input !== null && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input).map(([key, entry]) => [key, mapStrings(entry, map)]),
    );
  }
  return input;
}

/** Reads every table, not the known ones, to notice a secret even in a table this app dropped. */
function collectSamples(sqlitePath: string): string[] {
  const found: string[] = [];
  let database: Database;
  try {
    database = new Database(sqlitePath, { readonly: true });
  } catch {
    return found;
  }

  try {
    const tables = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    for (const { name } of tables) {
      if (found.length >= SAMPLE_LIMIT) break;
      let rows: Array<Record<string, unknown>>;
      try {
        // The name comes from sqlite_master, not from a request, so it cannot be a parameter.
        rows = database.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
      } catch {
        continue; // A table that cannot be read tells us nothing about the key.
      }

      for (const row of rows) {
        if (found.length >= SAMPLE_LIMIT) break;
        for (const value of Object.values(row)) {
          if (typeof value !== "string" || !value.includes("enc:v1:")) continue;
          collectTokens(value, found);
        }
      }
    }
  } finally {
    database.close(true);
  }

  return found.slice(0, SAMPLE_LIMIT);
}

/** The tokens in one column value, whether it is a token itself or JSON holding some. */
function collectTokens(value: string, into: string[]): void {
  if (isEncryptedSecret(value)) {
    into.push(value);
    return;
  }
  try {
    mapStrings(JSON.parse(value), (text) => {
      if (isEncryptedSecret(text)) into.push(text);
      return text;
    });
  } catch {
    // Not JSON, so the marker was part of some other text. Nothing to sample.
  }
}
