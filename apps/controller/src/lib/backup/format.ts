/**
 * A passphrase, not SESSION_SECRET: a backup must survive losing the machine and its `.env`. The
 * payload carries decrypted secrets (`secrets.ts`), so it is sealed whole; the header stays
 * readable so a restore can say what it will do before asking for the passphrase.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { domainError } from "../domain-error";

const MAGIC = "CPMBAK1";
/** 32 MiB of scrypt: costly to brute-force, affordable on a small controller. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
export const MIN_PASSPHRASE_LENGTH = 12;

export type BackupHeader = {
  format: "cpm-backup";
  /** 2 authenticates the header; 1 left it open to tampering and is refused. */
  version: 2;
  appVersion: string;
  createdAt: string;
  /** Rows per table, shown before restoring. */
  counts: Record<string, number>;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
};

export type BackupPayload = { tables: Record<string, Record<string, unknown>[]> };

/**
 * Everything in the header but the tag, which GCM only produces afterwards. Rebuilt from the parsed
 * header in a fixed order, so reordering keys in the file can't change what is authenticated.
 */
function headerAad(
  header: Omit<BackupHeader, "cipher"> & { cipher: { name: string; iv: string } },
) {
  const counts = Object.keys(header.counts)
    .sort()
    .map((name) => [name, header.counts[name]]);
  return Buffer.from(
    JSON.stringify([
      header.format,
      header.version,
      header.appVersion,
      header.createdAt,
      counts,
      [header.kdf.name, header.kdf.N, header.kdf.r, header.kdf.p, header.kdf.salt],
      [header.cipher.name, header.cipher.iv],
    ]),
    "utf8",
  );
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  kdf: { N: number; r: number; p: number } = SCRYPT,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase.normalize("NFKC"),
      salt,
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

export async function sealBackup(
  payload: BackupPayload,
  passphrase: string,
  meta: { appVersion: string; now?: Date },
): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw domainError("backupPassphraseTooShort", { min: MIN_PASSPHRASE_LENGTH }, { status: 400 });
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const unsealed = {
    format: "cpm-backup" as const,
    version: 2 as const,
    appVersion: meta.appVersion,
    createdAt: (meta.now ?? new Date()).toISOString(),
    counts: Object.fromEntries(
      Object.entries(payload.tables).map(([name, rows]) => [name, rows.length]),
    ),
    kdf: {
      name: "scrypt" as const,
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: salt.toString("base64"),
    },
    cipher: { name: "aes-256-gcm" as const, iv: iv.toString("base64") },
  };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(headerAad(unsealed));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const header: BackupHeader = {
    ...unsealed,
    cipher: { ...unsealed.cipher, tag: cipher.getAuthTag().toString("base64") },
  };
  return Buffer.concat([
    Buffer.from(`${MAGIC}\n${JSON.stringify(header)}\n`, "utf8"),
    Buffer.from(body.toString("base64"), "utf8"),
  ]);
}

/** Without the passphrase, so display-only: nothing in it is trusted until `openBackup`. */
export function readBackupHeader(file: Buffer): { header: BackupHeader; body: string } {
  const text = file.toString("utf8");
  const first = text.indexOf("\n");
  const second = text.indexOf("\n", first + 1);
  if (first === -1 || second === -1 || text.slice(0, first) !== MAGIC) {
    throw domainError("backupNotRecognised", {}, { status: 400 });
  }
  let header: BackupHeader;
  try {
    header = JSON.parse(text.slice(first + 1, second));
  } catch {
    throw domainError("backupNotRecognised", {}, { status: 400 });
  }
  if (header.format !== "cpm-backup" || header.version !== 2) {
    throw domainError("backupNotRecognised", {}, { status: 400 });
  }
  return { header, body: text.slice(second + 1) };
}

/** The payload and the header it vouches for. */
export async function openBackup(
  file: Buffer,
  passphrase: string,
): Promise<BackupPayload & { header: BackupHeader }> {
  const { header, body } = readBackupHeader(file);
  const { N, r, p } = header.kdf;
  // A header can name any cost; accept none above what this writes, so a crafted file can't pin
  // the server's CPU or memory while it "checks the passphrase".
  if (N > SCRYPT.N || r > SCRYPT.r || p > SCRYPT.p) {
    throw domainError("backupNotRecognised", {}, { status: 400 });
  }
  const key = await deriveKey(passphrase, Buffer.from(header.kdf.salt, "base64"), { N, r, p });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.cipher.iv, "base64"));
    decipher.setAAD(headerAad(header));
    decipher.setAuthTag(Buffer.from(header.cipher.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]);
    return { ...JSON.parse(plain.toString("utf8")), header };
  } catch {
    // GCM can't tell a wrong passphrase from a tampered file, and neither should the message.
    throw domainError("backupPassphraseWrong", {}, { status: 400 });
  }
}
