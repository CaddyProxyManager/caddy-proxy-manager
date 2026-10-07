/**
 * Backup destinations. The S3 secret is `enc:v1` at rest and never leaves for the browser; like an
 * LDAP bind password, the stored one only goes where it was saved for, so pointing a destination
 * somewhere else needs it typed again.
 */
import { asc, eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { backupDestinations, backupSchedules } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { parseOutboundBaseUrl } from "../http/outbound-url";
import { decryptSecret, encryptSecret } from "../secrets";
import { type BackupStore, localStore, s3Store } from "./storage";

export const DESTINATION_KINDS = ["s3", "local"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export type BackupDestination = {
  id: number;
  name: string;
  kind: DestinationKind;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  virtualHostedStyle: boolean;
  path: string;
  createdAt: string;
  updatedAt: string;
};

export type BackupDestinationView = Omit<BackupDestination, "secretAccessKey"> & {
  hasSecret: boolean;
};

export type BackupDestinationInput = {
  name: string;
  kind: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  accessKeyId?: string;
  /** Blank keeps the stored one. */
  secretAccessKey?: string;
  virtualHostedStyle?: boolean;
  path?: string;
};

type Row = typeof backupDestinations.$inferSelect;

function parseRow(row: Row): BackupDestination {
  return {
    ...row,
    kind: row.kind === "local" ? "local" : "s3",
    secretAccessKey: decryptSecret(row.secretAccessKey, `backup destination "${row.name}"`),
  };
}

export function toDestinationView(destination: BackupDestination): BackupDestinationView {
  const { secretAccessKey, ...rest } = destination;
  return { ...rest, hasSecret: secretAccessKey.length > 0 };
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * `a/b/` from ` /a/b `: relative, slash-terminated, no `.` or `..` segment. Empty stays empty
 * unless `required`. A folder (`trailingSlash: false`) is the same without the final slash.
 */
export function normalizeKeyPrefix(
  raw: string,
  options: { trailingSlash?: boolean; required?: boolean } = {},
): string | null {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return options.required ? null : "";
  const segments = trimmed.split("/");
  if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return null;
  return options.trailingSlash === false ? trimmed : `${trimmed}/`;
}

export async function listDestinations(): Promise<BackupDestinationView[]> {
  const rows = await db.select().from(backupDestinations).orderBy(asc(backupDestinations.name));
  return rows.map((row) => toDestinationView(parseRow(row)));
}

export async function getDestination(id: number): Promise<BackupDestination | null> {
  const [row] = await db.select().from(backupDestinations).where(eq(backupDestinations.id, id));
  return row ? parseRow(row) : null;
}

async function requireDestination(id: number): Promise<BackupDestination> {
  const destination = await getDestination(id);
  if (!destination) throw domainError("backupDestinationNotFound", {}, { status: 404 });
  return destination;
}

/** The whole destination a form describes, validated, with a blank secret taken from `existing`. */
export function prepareDestination(
  input: BackupDestinationInput,
  existing: BackupDestination | null,
): Omit<BackupDestination, "id" | "createdAt" | "updatedAt"> {
  const name = input.name?.trim() ?? "";
  if (!name) throw domainError("backupDestinationNameRequired", {}, { status: 400 });
  if (!DESTINATION_KINDS.includes(input.kind as DestinationKind)) {
    throw domainError("backupDestinationKindInvalid", {}, { status: 400 });
  }
  const kind = input.kind as DestinationKind;
  const prefix = normalizeKeyPrefix(input.prefix ?? "");
  if (prefix === null) throw domainError("backupPrefixInvalid", {}, { status: 400 });
  const blank = {
    name,
    kind,
    endpoint: "",
    region: "",
    bucket: "",
    prefix,
    accessKeyId: "",
    secretAccessKey: "",
    virtualHostedStyle: false,
    path: "",
  };

  if (kind === "local") {
    const path = normalizeKeyPrefix(input.path ?? "", { trailingSlash: false, required: true });
    if (path === null) throw domainError("backupFolderInvalid", {}, { status: 400 });
    return { ...blank, path };
  }

  let endpoint = "";
  if (input.endpoint?.trim()) {
    const parsed = parseOutboundBaseUrl(input.endpoint);
    if (parsed.problem === "https") {
      throw domainError("backupEndpointNeedsHttps", {}, { status: 400 });
    }
    if (parsed.problem) throw domainError("backupEndpointInvalid", {}, { status: 400 });
    endpoint = parsed.url;
  }
  const bucket = input.bucket?.trim() ?? "";
  if (!bucket) throw domainError("backupBucketRequired", {}, { status: 400 });
  const accessKeyId = input.accessKeyId?.trim() ?? "";
  const replacement = input.secretAccessKey?.trim() ? input.secretAccessKey.trim() : null;
  const sameTarget =
    existing?.kind === "s3" &&
    existing.endpoint === endpoint &&
    existing.bucket === bucket &&
    existing.accessKeyId === accessKeyId;
  if (!replacement && existing?.secretAccessKey && !sameTarget) {
    throw domainError("backupSecretReentry", {}, { status: 400 });
  }
  const secretAccessKey = replacement ?? (sameTarget ? existing.secretAccessKey : "");
  if (!accessKeyId || !secretAccessKey) {
    throw domainError("backupCredentialsRequired", {}, { status: 400 });
  }
  return {
    ...blank,
    endpoint,
    region: input.region?.trim() ?? "",
    bucket,
    accessKeyId,
    secretAccessKey,
    virtualHostedStyle: input.virtualHostedStyle === true,
  };
}

async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  const [clash] = await db
    .select({ id: backupDestinations.id })
    .from(backupDestinations)
    .where(eq(backupDestinations.name, name));
  if (clash && clash.id !== exceptId) {
    throw domainError("backupDestinationNameTaken", { name }, { status: 409 });
  }
}

export async function createDestination(input: BackupDestinationInput): Promise<BackupDestination> {
  const prepared = prepareDestination(input, null);
  await assertNameFree(prepared.name, null);
  const now = nowIso();
  const [row] = await db
    .insert(backupDestinations)
    .values({
      ...prepared,
      secretAccessKey: encryptSecret(prepared.secretAccessKey),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return parseRow(row);
}

export async function updateDestination(
  id: number,
  input: BackupDestinationInput,
): Promise<BackupDestination> {
  const existing = await requireDestination(id);
  const prepared = prepareDestination(input, existing);
  await assertNameFree(prepared.name, id);
  const [row] = await db
    .update(backupDestinations)
    .set({
      ...prepared,
      secretAccessKey: encryptSecret(prepared.secretAccessKey),
      updatedAt: nowIso(),
    })
    .where(eq(backupDestinations.id, id))
    .returning();
  return parseRow(row);
}

export async function deleteDestination(id: number): Promise<BackupDestination> {
  const existing = await requireDestination(id);
  const [used] = await db
    .select({ id: backupSchedules.id })
    .from(backupSchedules)
    .where(eq(backupSchedules.destinationId, id))
    .limit(1);
  if (used) throw domainError("backupDestinationInUse", {}, { status: 409 });
  await db.delete(backupDestinations).where(eq(backupDestinations.id, id));
  return existing;
}

export function openStore(destination: BackupDestination): BackupStore {
  return destination.kind === "local" ? localStore(destination.path) : s3Store(destination);
}

/** Writes, reads back and deletes a probe object, so a wrong key or bucket shows before a run. */
export async function testDestination(destination: BackupDestination): Promise<void> {
  const store = openStore(destination);
  const key = `${destination.prefix}cpm-probe-${crypto.randomUUID()}.txt`;
  const body = new TextEncoder().encode(`Caddy Proxy Manager destination test ${nowIso()}`);
  await store.write(key, body);
  try {
    const read = await store.read(key);
    if (!read.equals(Buffer.from(body))) {
      throw domainError("backupProbeMismatch", {}, { status: 400 });
    }
  } finally {
    await store.delete(key);
  }
}

/** For the Test button: the form as it stands, unsaved, with a blank secret meaning the stored one. */
export async function previewDestination(
  input: BackupDestinationInput,
  existingId: number | null,
): Promise<BackupDestination> {
  const existing = existingId === null ? null : await requireDestination(existingId);
  const prepared = prepareDestination(input, existing);
  return { ...prepared, id: existingId ?? 0, createdAt: "", updatedAt: "" };
}
