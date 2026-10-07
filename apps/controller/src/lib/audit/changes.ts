/**
 * Field-level before and after on an audit event, stored as `data.changes`. Client safe: the audit
 * page parses it and the docs demo renders it. Hosts reuse the review step's diff; everything else
 * goes through the generic one here, which masks the same way.
 */
import { diffValue } from "../host-review/diff";
import {
  type DiffValue,
  type FieldChange,
  type LeafChange,
  MASKED_VALUE,
} from "../host-review/types";

export type AuditChange = {
  field: string;
  /** The host editor section for host fields; null elsewhere. */
  section: string | null;
  before: DiffValue;
  after: DiffValue;
  leaves: LeafChange[] | null;
  masked: boolean;
};

/** Bookkeeping every row has and no reader asks about. */
const ALWAYS_OMIT = new Set(["id", "createdAt", "updatedAt"]);
/** A value sealed with the deployment's key: never shown. */
const SEALED = /^enc:v\d+:/;

export function fromHostChanges(changes: FieldChange[]): AuditChange[] {
  return changes.map(({ field, section, before, after, leaves, masked }) => ({
    field,
    section,
    before,
    after,
    leaves,
    masked,
  }));
}

/** Sealed strings masked at any depth, so a settings blob's ciphertext never reaches the log. */
function unseal(value: unknown): unknown {
  if (typeof value === "string") return SEALED.test(value) ? MASKED_VALUE : value;
  if (Array.isArray(value)) return value.map(unseal);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unseal(item)]));
  }
  return value;
}

/** JSON kept in a text column diffs by path rather than as one long string. */
function normalize(value: unknown): unknown {
  if (typeof value !== "string") return unseal(value);
  const trimmed = value.trim();
  const json =
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"));
  if (json) {
    try {
      return unseal(JSON.parse(trimmed));
    } catch {
      // Not JSON after all: compared as text.
    }
  }
  return unseal(value);
}

/**
 * Any two records, a null side for a create or delete. `omit` drops columns too large or too
 * internal to read (a PEM body, a cache key).
 */
export function diffAuditRecords(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  options: { omit?: readonly string[] } = {},
): AuditChange[] {
  const omit = new Set([...ALWAYS_OMIT, ...(options.omit ?? [])]);
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
    (field) => !omit.has(field),
  );
  const out: AuditChange[] = [];
  for (const field of fields) {
    const left = normalize(before?.[field]);
    const right = normalize(after?.[field]);
    // Two sealed values compare equal: a save re-encrypts with a fresh IV, so text says nothing.
    const change = diffValue(field, "", left, right);
    if (change) out.push({ ...fromHostChanges([change])[0], section: null } as AuditChange);
  }
  return out;
}

function isDiffValue(value: unknown): value is DiffValue {
  const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}

/** The stored `data` column's changes, or null; anything malformed is dropped rather than shown. */
/** The host revision a host event's write made; null for anything else. */
export function parseAuditRevisionId(data: string | null): number | null {
  if (!data) return null;
  try {
    const id = (JSON.parse(data) as { revisionId?: unknown } | null)?.revisionId;
    return Number.isInteger(id) ? (id as number) : null;
  } catch {
    return null;
  }
}

export function parseAuditChanges(data: string | null): AuditChange[] | null {
  if (!data) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const list = (parsed as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(list)) return null;
  const out: AuditChange[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    if (typeof c.field !== "string") continue;
    const leaves = Array.isArray(c.leaves)
      ? c.leaves.filter(
          (leaf): leaf is LeafChange =>
            !!leaf &&
            typeof (leaf as LeafChange).path === "string" &&
            isDiffValue((leaf as LeafChange).before) &&
            isDiffValue((leaf as LeafChange).after),
        )
      : null;
    out.push({
      field: c.field,
      section: typeof c.section === "string" && c.section ? c.section : null,
      before: isDiffValue(c.before) ? c.before : null,
      after: isDiffValue(c.after) ? c.after : null,
      leaves,
      masked: c.masked === true,
    });
  }
  return out.length > 0 ? out : null;
}
