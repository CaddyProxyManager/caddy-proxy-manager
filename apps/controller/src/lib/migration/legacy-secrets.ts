/**
 * Carrying a pre-3.0 database's encrypted values across a change of `SESSION_SECRET`.
 *
 * Secrets in the old database - certificate private keys, DNS provider credentials, OAuth client
 * secrets, agent secrets, the Tailscale auth key - are ciphertext bound to the `SESSION_SECRET`
 * that installation ran with. The importer copies rows verbatim, so before this the only way to
 * read them afterwards was to adopt the old secret on the new deployment: change `SESSION_SECRET`
 * to match, restart, migrate. That is a bad trade. It makes the old value permanent, and an
 * operator who has already generated a new one has to go and find the old one anyway.
 *
 * So the old secret is asked for once, used here, and forgotten. Every encrypted value is
 * decrypted with it and re-encrypted under the key this deployment actually uses, on the way in.
 * Nothing stores it, and after the migration the old secret is of no further use to anyone.
 *
 * Two shapes have to be handled, because two shapes exist in the schema:
 *
 * - A column that *is* a secret - `certificates.privateKeyPem`, `ca_certificates.privateKeyPem`,
 *   `agents.secret`. Old releases kept the key columns in plain text; `SECRET_COLUMNS` seals those.
 * - A column holding JSON with secrets inside it - the `settings` rows, where a registry secret is
 *   a JSON-encoded string and the Tailscale blob is an object with an `authKey` field.
 *
 * Both are handled by looking for the `enc:v1:` marker rather than by naming columns: the prefix is
 * already the thing every read path keys off, so a column added later is covered without anyone
 * remembering to add it to a list here.
 */
import { Database } from "bun:sqlite";
import { config } from "../config";
import { decryptSecretWith, encryptSecret, isEncryptedSecret } from "../secret";

/** How many samples `probeLegacySecrets` collects before it stops reading. */
const SAMPLE_LIMIT = 25;

export type LegacySecretProbe = {
  /** Whether the database holds any encrypted value at all. */
  hasEncryptedValues: boolean;
  /**
   * Whether this deployment's own `SESSION_SECRET` reads them.
   *
   * True is the ordinary upgrade - the same secret carried over - and needs no key from anyone.
   */
  readableWithCurrentKey: boolean;
  /** A few tokens, kept so a key the operator types can be checked before the import starts. */
  samples: string[];
};

/**
 * What the old database's secrets look like from here.
 *
 * Read-only, and cheap enough to run while rendering the migration page: a pre-3.0 database is a
 * few megabytes at most, and the read stops at `SAMPLE_LIMIT` tokens.
 */
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
 * A function that rewrites one column value for the destination database.
 *
 * Throws on a value it cannot read. The importer runs it over every row before writing anything,
 * so a wrong key fails the whole migration before it has written a row - rather than partway
 * through, which would leave a half-populated database the operator is told not to retry against.
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
 * Build the rewriter for an import.
 *
 * `legacyKey` is null for the ordinary case, where the secret has not changed and every value is
 * already readable. Values the current key reads are returned byte-for-byte: re-encrypting them
 * would churn ciphertext for no gain, and would mean a migration that needed no key still could
 * not be repeated against the original file.
 */
export function createRekeyer(legacyKey: string | null): Rekeyer {
  return (value: string): string => {
    if (!value.includes("enc:v1:")) return value;

    if (isEncryptedSecret(value)) return rekeyToken(value, legacyKey);

    // Not itself a token, but something in it is. The only such columns hold JSON, so parse rather
    // than pattern-match the text: a substring rewrite would depend on where a token ends, and the
    // trailing base64 has no delimiter that could not also be data.
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

/**
 * Every encrypted token in the file, up to `SAMPLE_LIMIT`.
 *
 * Reads every table rather than the ones known to hold secrets, for the same reason the rewriter
 * looks for the prefix rather than for column names: the point is to notice a secret wherever it
 * is, including in a table this version of the app no longer has.
 */
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
