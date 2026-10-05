/**
 * Portable config export and import: hosts, access lists, certificates, groups, WAF and block
 * lists and settings, moved between instances by natural key rather than restored by id. Distinct
 * from backup/restore, which replaces a whole instance. An import is planned in full first (the
 * dry run shows exactly that plan) and applied in one transaction; a host whose domain another host
 * already serves is skipped and reported, never overwritten.
 */
import { eq, getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import pkg from "../../../package.json";
import { logAuditEvent } from "../audit";
import { type AuditChange, diffAuditRecords } from "../audit/changes";
import { MARKER, exportRow, importRow } from "../backup/secrets";
import { applyCaddyConfig } from "../caddy";
import db, { nowIso, runInTransaction } from "../db";
import { activeSchema, schemaDialect } from "../db/schema";
import {
  type DomainError,
  domainError,
  domainErrorMessage,
  domainErrorOf,
  isDetailList,
  renderDetails,
} from "../errors/domain-error";
import { MASKED_VALUE } from "../host-review/types";
import { type Described, describeTables, resyncSequence } from "../migration/import";
import { isNewer } from "../runtime/updates";
import { getWafSettings } from "../settings";
import { encryptSettingCredentials } from "../settings/plaintext-credentials";
import { invalidateSettingsCache } from "../settings/resolve";
import { mapTextColumn } from "../secrets/walk";
import { IMPORT_CHECKS } from "./checks";
import {
  CONFIG_SECTIONS,
  type ConfigFile,
  type ConfigSection,
  openConfigFile,
  readConfigFile,
  sealConfigFile,
} from "./format";
import {
  CONFIG_TABLES,
  type EmbeddedRef,
  NOT_COMPARED,
  ONE_WAY_COLUMNS,
  PORTABLE_SETTING_KEYS,
  type RefKey,
  type Row,
  SPEC_BY_TABLE,
  type TableSpec,
  itemLabel,
  naturalKey,
} from "./spec";

export { CONFIG_SECTIONS, MAX_CONFIG_BYTES, type ConfigSection } from "./format";

export type ImportAction = "create" | "update" | "skip";
export type SkipReason =
  | "unchanged"
  | "domainConflict"
  | "listenerConflict"
  | "missingReference"
  | "unkeyable"
  /** Two rows share the natural key, here or in the file: neither is matched by guesswork. */
  | "ambiguous"
  /** A check the save would run refused it; `values.code` names which. */
  | "invalid";

export type ConfigImportItem = {
  table: string;
  label: string;
  action: ImportAction;
  reason: SkipReason | null;
  /** For the reason's sentence: the domain and host in conflict, the kind and name missing. */
  values: Record<string, string>;
  /** Columns that differ, for an update. */
  fields: string[];
  /** Before and after, secrets masked; a create's before is empty. */
  changes: AuditChange[];
  /** Columns the file would have changed but an import never does, such as a revocation. */
  kept: string[];
};

export type ConfigImportWarning = {
  code: "rowDropped";
  values: Record<string, string>;
};

export type ConfigImportPreview = {
  appVersion: string;
  exportedAt: string;
  sections: ConfigSection[];
  items: ConfigImportItem[];
  counts: Record<ImportAction, number>;
  warnings: ConfigImportWarning[];
};

// ── Tables and rows ─────────────────────────────────────────────────────────

const described = new Map<string, Described>();
function tableInfo(name: string): Described {
  if (described.size === 0) for (const table of describeTables()) described.set(table.name, table);
  const info = described.get(name);
  if (!info) throw new Error(`Unknown table ${name}`);
  return info;
}

function drizzleTable(name: string): PgTable {
  return activeSchema[tableInfo(name).key as keyof typeof activeSchema] as PgTable;
}

/** column name -> drizzle field name. */
function fieldsOf(name: string): Map<string, string> {
  return new Map(
    Object.entries(getTableColumns(drizzleTable(name))).map(([field, column]) => [
      column.name,
      field,
    ]),
  );
}

/** Where a column points: from the foreign keys, so a new reference needs no list here. */
function referencesOf(name: string): Map<string, { target: string; required: boolean }> {
  const out = new Map<string, { target: string; required: boolean }>();
  for (const reference of tableInfo(name).references) {
    for (const column of reference.columns) {
      out.set(column, { target: reference.target, required: reference.required });
    }
  }
  return out;
}

/** Rows keyed by column name with secrets as backup markers, as the file carries them. */
async function readLocal(name: string): Promise<Row[]> {
  const fields = fieldsOf(name);
  const columnOf = new Map([...fields].map(([column, field]) => [field, column]));
  const rows = (await db.select().from(drizzleTable(name))) as Row[];
  return await Promise.all(
    rows.map((row) =>
      exportRow(
        name,
        Object.fromEntries(Object.entries(row).map(([f, v]) => [columnOf.get(f) ?? f, v])),
      ),
    ),
  );
}

/** Tables a reference can reach that the file never carries, keyed by what identifies them. */
const REFERENCE_ONLY = ["users", "agents", "oauth_providers"] as const;

/** What the preview calls a reference whose key is not for reading, and an agent's fallback. */
const REF_LABELS: Partial<Record<string, (row: Row | undefined) => string | null>> = {
  agents: (row) => (row?.name ? String(row.name) : null),
};

/** Hidden from the preview's before and after: bookkeeping, and certificate bodies. */
const DISPLAY_OMIT = ["id", "createdAt", "updatedAt", "sourceReadAt", "sourceError"];

function sectionTables(sections: readonly ConfigSection[]): TableSpec[] {
  return CONFIG_TABLES.filter((spec) => sections.includes(spec.section));
}

// ── Embedded ids ────────────────────────────────────────────────────────────

function mapPath(value: unknown, segments: string[], map: (id: unknown) => unknown): unknown {
  if (segments.length === 0) return map(value);
  const [head, ...rest] = segments as [string, ...string[]];
  const isArray = head.endsWith("[]");
  const name = isArray ? head.slice(0, -2) : head;
  const inner = name ? (value as Row | null)?.[name] : value;
  if (inner === undefined || inner === null) return value;
  const next = isArray
    ? Array.isArray(inner)
      ? inner.map((item) => mapPath(item, rest, map))
      : inner
    : mapPath(inner, rest, map);
  if (!name) return next;
  return value && typeof value === "object" ? { ...(value as Row), [name]: next } : value;
}

/** The ids `refs` name inside a JSON column, remapped; `missing` lists those that did not resolve. */
function remapEmbedded(
  row: Row,
  column: string,
  refs: readonly EmbeddedRef[],
  resolve: (target: string, id: unknown) => number | string | null,
): { value: unknown; missing: { target: string; id: unknown }[] } {
  const raw = row[column];
  const applicable = refs.filter((ref) => !ref.when || ref.when(row));
  if (typeof raw !== "string" || applicable.length === 0) return { value: raw, missing: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: raw, missing: [] };
  }
  const missing: { target: string; id: unknown }[] = [];
  for (const ref of applicable) {
    const segments = ref.path === "[]" ? ["[]"] : ref.path.split(".");
    parsed = mapPath(parsed, segments, (id) => {
      if (id === null || id === undefined) return id;
      const local = resolve(ref.target, id);
      if (local === null) missing.push({ target: ref.target, id });
      return local ?? id;
    });
  }
  return { value: JSON.stringify(parsed), missing };
}

/** Equal JSON text in any key order or spacing compares equal. */
function canonical(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return canonical(JSON.parse(trimmed));
      } catch {
        return JSON.stringify(value);
      }
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => (value as Row)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// ── Export ──────────────────────────────────────────────────────────────────

export type ExportOptions = { sections?: readonly ConfigSection[] };

type KeyIndex = {
  /** Unique keys only. */
  byKey: Map<string, Row>;
  keyOf: Map<unknown, string>;
  /** Keys more than one row has: none of those rows is matched, since ids say nothing across instances. */
  ambiguous: Set<string>;
  /** Every keyable row's key, ambiguous ones included, for naming them. */
  baseOf: Map<unknown, string>;
};

function keyIndex(table: string, rows: Row[], ref: RefKey): KeyIndex {
  const keyed = rows.map((row) => [row, naturalKey(table, row, ref)] as const);
  const counts = new Map<string, number>();
  for (const [, key] of keyed) if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  const index: KeyIndex = {
    byKey: new Map(),
    keyOf: new Map(),
    ambiguous: new Set(),
    baseOf: new Map(),
  };
  for (const [row, key] of keyed) {
    if (key === null) continue;
    const id = row.id ?? row.key;
    index.baseOf.set(id, key);
    if ((counts.get(key) ?? 0) > 1) {
      index.ambiguous.add(key);
      continue;
    }
    index.byKey.set(key, row);
    index.keyOf.set(id, key);
  }
  return index;
}

/** Local rows and their keys, loaded once per table on demand. */
class LocalIndex {
  private rows = new Map<string, Row[]>();
  private indexes = new Map<string, KeyIndex>();

  async load(tables: Iterable<string>): Promise<void> {
    for (const table of tables) {
      if (this.rows.has(table)) continue;
      this.rows.set(table, await readLocal(table));
    }
  }

  all(table: string): Row[] {
    return this.rows.get(table) ?? [];
  }

  index(table: string): KeyIndex {
    let index = this.indexes.get(table);
    if (!index) {
      index = keyIndex(table, this.all(table), this.ref);
      this.indexes.set(table, index);
    }
    return index;
  }

  ref: RefKey = (table, id) =>
    id === null || id === undefined ? null : (this.index(table).keyOf.get(id) ?? null);
}

function allTargets(specs: TableSpec[]): Set<string> {
  const targets = new Set<string>(REFERENCE_ONLY);
  for (const spec of specs) {
    for (const { target } of referencesOf(spec.table).values()) targets.add(target);
    for (const refs of Object.values(spec.embedded ?? {})) {
      for (const ref of refs) targets.add(ref.target);
    }
    if (spec.table === "waf_exclusions") targets.add("proxy_hosts");
  }
  return targets;
}

export async function exportConfig(
  passphrase: string,
  options: ExportOptions = {},
): Promise<Buffer> {
  const sections = (options.sections ?? CONFIG_SECTIONS).filter((s) => CONFIG_SECTIONS.includes(s));
  if (sections.length === 0) throw domainError("configNothingSelected", {}, { status: 400 });
  const specs = sectionTables(sections);
  const included = new Set(specs.map((spec) => spec.table));
  const local = new LocalIndex();
  await local.load([...included, ...allTargets(specs)]);

  const tables: Record<string, Row[]> = {};
  const refs: Record<string, Record<string, string>> = {};
  const refLabels: Record<string, Record<string, string>> = {};
  const note = (target: string, id: unknown) => {
    if (included.has(target) || id === null || id === undefined) return;
    const key = local.ref(target, id);
    if (key === null) return;
    refs[target] ??= {};
    refs[target][String(id)] = key;
    const label = REF_LABELS[target]?.(local.all(target).find((row) => row.id === id));
    if (label) {
      refLabels[target] ??= {};
      refLabels[target][String(id)] = label;
    }
  };
  for (const spec of specs) {
    const references = referencesOf(spec.table);
    let rows = local.all(spec.table);
    if (spec.table === "settings")
      rows = rows.filter((row) => PORTABLE_SETTING_KEYS.has(String(row.key)));
    tables[spec.table] = rows;
    for (const row of rows) {
      for (const [column, { target }] of references) note(target, row[column]);
      for (const [column, embedded] of Object.entries(spec.embedded ?? {})) {
        remapEmbedded(row, column, embedded, (target, id) => {
          note(target, id);
          return 0;
        });
      }
      if (spec.table === "waf_exclusions") note("proxy_hosts", row.proxyHostId);
    }
  }
  return await sealConfigFile(
    { appVersion: pkg.version, sections, refs, refLabels, tables },
    passphrase,
  );
}

// ── Plan ────────────────────────────────────────────────────────────────────

type PlannedRow = {
  spec: TableSpec;
  item: ConfigImportItem;
  fileId: unknown;
  key: string;
  /** The local id it becomes or updates; the settings key for settings. */
  targetId: number | string | null;
  values: Row;
  children: Map<string, Row[]>;
};

type Plan = {
  file: ConfigFile;
  rows: PlannedRow[];
  warnings: ConfigImportWarning[];
};

function invalidValues(error: DomainError): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(error.params).map(([name, value]) => [
        name,
        isDetailList(value)
          ? renderDetails(value, domainErrorMessage).join(", ")
          : typeof value === "object"
            ? value.join(", ")
            : String(value),
      ]),
    ),
    code: error.code,
    message: error.message,
  };
}

/** Secrets as the backup layer marks them, masked like any the audit diff finds by name. */
function masked(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      typeof value === "string"
        ? mapTextColumn(value, MARKER, (text) => (text.startsWith(MARKER) ? MASKED_VALUE : text))
        : value,
    ]),
  );
}

function hostListener(row: Row): string {
  return [row.protocol, row.listenAddress, row.matcherType ?? "none", row.matcherValue ?? null]
    .map((part) => JSON.stringify(part ?? null))
    .join("|");
}

async function planImport(file: ConfigFile): Promise<Plan> {
  // `file` is authenticated by now, appVersion included, so this gate cannot be edited around.
  if (isNewer(pkg.version, file.appVersion)) {
    throw domainError("configFromNewerVersion", {}, { status: 400 });
  }
  const specs = CONFIG_TABLES.filter((spec) => Array.isArray(file.tables[spec.table]));
  const local = new LocalIndex();
  await local.load([...specs.map((spec) => spec.table), ...allTargets(specs)]);
  const context = { globalWaf: await getWafSettings().catch(() => null) };

  // The file's own keys, the same way: a referenced row is in the file or named in `refs`.
  const fileIndexes = new Map<string, KeyIndex>();
  const fileRef: RefKey = (table, id) => {
    if (id === null || id === undefined) return null;
    const rows = file.tables[table];
    if (Array.isArray(rows)) {
      let index = fileIndexes.get(table);
      if (!index) {
        index = keyIndex(table, rows, fileRef);
        fileIndexes.set(table, index);
      }
      return index.keyOf.get(id) ?? null;
    }
    return file.refs[table]?.[String(id)] ?? null;
  };

  // Natural key -> the local id it ends up as, for this instance's rows and the plan's creates.
  const resolved = new Map<string, Map<string, number | string>>();
  const resolvedFor = (table: string) => {
    let map = resolved.get(table);
    if (!map) {
      map = new Map();
      for (const [key, row] of local.index(table).byKey)
        map.set(key, (row.id ?? row.key) as number);
      resolved.set(table, map);
    }
    return map;
  };
  const fileLabel = (table: string, id: unknown) => file.refLabels[table]?.[String(id)] ?? null;
  /**
   * An agent the file names by an agentId this instance lacks may still be the same machine,
   * re-paired: matched by name, but only when that name is unique on both sides and the local
   * agent is not claimed by another of the file's agentIds.
   */
  const agentByName = (fileId: unknown): number | null => {
    const name = fileLabel("agents", fileId);
    if (!name) return null;
    const labels = Object.values(file.refLabels.agents ?? {});
    if (labels.filter((label) => label === name).length !== 1) return null;
    const named = local.all("agents").filter((row) => row.name === name);
    if (named.length !== 1) return null;
    const claimed = new Set(Object.values(file.refs.agents ?? {}));
    return claimed.has(String(named[0].agentId)) ? null : (named[0].id as number);
  };
  const resolveRef = (table: string, fileId: unknown): number | string | null => {
    const key = fileRef(table, fileId);
    if (key === null) return null;
    const found = resolvedFor(table).get(key) ?? null;
    if (found !== null || local.index(table).ambiguous.has(key)) return found;
    return table === "agents" ? agentByName(fileId) : null;
  };
  /** How the preview names a referenced row: its key, with its label where the key is an id. */
  const describeRef = (table: string, fileId: unknown) => {
    const key = fileRef(table, fileId) ?? `#${String(fileId)}`;
    const label = fileLabel(table, fileId);
    return label ? `${label} (${key})` : key;
  };
  const nextId = new Map<string, number>();
  const allocate = (table: string) => {
    const next =
      nextId.get(table) ?? Math.max(0, ...local.all(table).map((row) => Number(row.id) || 0)) + 1;
    nextId.set(table, next + 1);
    return next;
  };

  const rows: PlannedRow[] = [];
  const warnings: ConfigImportWarning[] = [];
  const byParent = new Map<string, Map<unknown, PlannedRow>>();
  const skip = (planned: PlannedRow, reason: SkipReason, values: Record<string, string> = {}) => {
    planned.item.action = "skip";
    planned.item.reason = reason;
    planned.item.values = values;
    // Anything planned later that points at it finds nothing, rather than a same-named local row.
    resolvedFor(planned.spec.table).delete(planned.key);
  };

  /** A file row with its references turned into local ids, or what it is missing or fails. */
  const translate = (spec: TableSpec, raw: Row, skipColumn?: string) => {
    const references = referencesOf(spec.table);
    const columns = new Set(tableInfo(spec.table).columns.map((column) => column.name));
    let values: Row = {};
    let missing: { target: string; name: string } | null = null;
    let invalid: DomainError | null = null;
    for (const [column, value] of Object.entries(raw)) {
      if (!columns.has(column) || column === "id" || column === skipColumn) continue;
      const reference = references.get(column);
      if (!reference || value === null || value === undefined) {
        values[column] = value;
        continue;
      }
      const localId = resolveRef(reference.target, value);
      if (localId !== null) {
        values[column] = localId;
      } else if (reference.required || spec.mustResolve?.includes(column)) {
        missing ??= { target: reference.target, name: describeRef(reference.target, value) };
      } else {
        values[column] = null;
      }
    }
    for (const [column, embedded] of Object.entries(spec.embedded ?? {})) {
      const { value, missing: lost } = remapEmbedded(raw, column, embedded, resolveRef);
      if (lost.length > 0) {
        const [first] = lost;
        missing ??= {
          target: first?.target ?? "",
          name: describeRef(first?.target ?? "", first?.id),
        };
      } else if (value !== undefined) {
        values[column] = value;
      }
    }
    const check = IMPORT_CHECKS[spec.table];
    if (!missing && check) {
      try {
        values = check(values, context);
      } catch (error) {
        invalid = domainErrorOf(error);
        if (!invalid) throw error;
      }
    }
    return { values, missing, invalid };
  };

  // Shown once everything is planned, so a reference to a planned create can be named.
  const pendingChanges: {
    item: ConfigImportItem;
    table: string;
    before: Row | null;
    after: Row;
  }[] = [];
  const pendingChildren: {
    item: ConfigImportItem;
    table: string;
    parentColumn: string;
    before: Row[];
    after: Row[];
  }[] = [];
  const claimedDomains = new Map<string, string>();
  const claimedListeners = new Map<string, string>();

  const differing = (localRow: Row, values: Row) =>
    Object.keys(values).filter(
      (column) =>
        !NOT_COMPARED.has(column) && canonical(localRow[column]) !== canonical(values[column]),
    );

  for (const spec of specs) {
    const fileRows = [...(file.tables[spec.table] ?? [])].sort(
      (a, b) => Number(a.id ?? 0) - Number(b.id ?? 0),
    );

    if (spec.parent) {
      const { table: parentTable, column: parentColumn, onMissing } = spec.parent;
      const parents = byParent.get(parentTable) ?? new Map<unknown, PlannedRow>();
      const grouped = new Map<unknown, Row[]>();
      for (const row of fileRows) {
        const list = grouped.get(row[parentColumn]) ?? [];
        list.push(row);
        grouped.set(row[parentColumn], list);
      }
      const localChildren = local.all(spec.table);
      const normalize = (row: Row) =>
        canonical(
          Object.fromEntries(
            Object.entries(row).filter(
              ([column]) => column !== parentColumn && !NOT_COMPARED.has(column),
            ),
          ),
        );
      for (const [fileParentId, parent] of parents) {
        if (parent.item.action === "skip" && parent.item.reason !== "unchanged") continue;
        const incoming: Row[] = [];
        for (const raw of grouped.get(fileParentId) ?? []) {
          const { values, missing, invalid } = translate(spec, raw, parentColumn);
          // Dropping a rule that fails could widen the set (a deny rule), so the parent waits.
          if (invalid) {
            skip(parent, "invalid", invalidValues(invalid));
            break;
          }
          if (!missing) {
            incoming.push(values);
            continue;
          }
          if (onMissing === "skipParent") {
            skip(parent, "missingReference", { kind: missing.target, name: missing.name });
            break;
          }
          warnings.push({
            code: "rowDropped",
            values: {
              kind: spec.table,
              parent: parent.item.label,
              missingKind: missing.target,
              missingName: missing.name,
            },
          });
        }
        if (parent.item.action === "skip" && parent.item.reason !== "unchanged") continue;
        const existing =
          parent.item.action === "create"
            ? []
            : localChildren.filter((row) => row[parentColumn] === parent.targetId);
        const before = existing.map(normalize).sort();
        const after = incoming.map(normalize).sort();
        if (parent.item.action !== "create" && canonical(before) === canonical(after)) continue;
        parent.children.set(spec.table, incoming);
        pendingChildren.push({
          item: parent.item,
          table: spec.table,
          parentColumn,
          before: existing,
          after: incoming,
        });
        if (parent.item.reason === "unchanged") {
          parent.item.action = "update";
          parent.item.reason = null;
        }
        if (parent.item.action === "update") parent.item.fields.push(spec.table);
      }
      continue;
    }

    const index = keyIndex(spec.table, fileRows, fileRef);
    const planned = new Map<unknown, PlannedRow>();
    for (const raw of fileRows) {
      const key = index.keyOf.get(raw.id ?? raw.key);
      if (spec.table === "settings" && !PORTABLE_SETTING_KEYS.has(String(raw.key))) continue;
      const base = index.baseOf.get(raw.id ?? raw.key);
      const item: ConfigImportItem = {
        table: spec.table,
        label: itemLabel(spec.table, key ?? base ?? String(raw.name ?? raw.id ?? "")),
        action: "create",
        reason: null,
        values: {},
        fields: [],
        changes: [],
        kept: [],
      };
      const entry: PlannedRow = {
        spec,
        item,
        fileId: raw.id ?? raw.key,
        key: key ?? "",
        targetId: null,
        values: {},
        children: new Map(),
      };
      rows.push(entry);
      planned.set(entry.fileId, entry);
      if (!key) {
        if (base !== undefined) skip(entry, "ambiguous", { name: item.label });
        else skip(entry, "unkeyable");
        continue;
      }
      if (local.index(spec.table).ambiguous.has(key)) {
        skip(entry, "ambiguous", { name: item.label });
        continue;
      }
      const { values, missing, invalid } = translate(spec, raw);
      entry.values = values;
      if (missing) {
        skip(entry, "missingReference", { kind: missing.target, name: missing.name });
        continue;
      }
      if (invalid) {
        skip(entry, "invalid", invalidValues(invalid));
        continue;
      }
      const match = local.index(spec.table).byKey.get(key);
      const conflict =
        findConflict(spec.table, values, match?.id, local) ??
        fileConflict(spec.table, values, claimedDomains, claimedListeners);
      if (conflict) {
        skip(entry, conflict.reason, conflict.values);
        continue;
      }
      claim(spec.table, values, item.label, claimedDomains, claimedListeners);
      if (match) {
        entry.targetId = (match.id ?? match.key) as number | string;
        // An import never undoes these, whatever the file says.
        item.kept = (ONE_WAY_COLUMNS[spec.table] ?? []).filter(
          (column) =>
            column in values &&
            match[column] != null &&
            canonical(match[column]) !== canonical(values[column]),
        );
        for (const column of item.kept) values[column] = match[column];
        const fields = differing(match, values);
        if (fields.length === 0) {
          item.action = "skip";
          item.reason = "unchanged";
        } else {
          item.action = "update";
          item.fields = fields;
          const shown = Object.fromEntries(
            Object.keys(values).map((column) => [column, match[column]]),
          );
          pendingChanges.push({ item, table: spec.table, before: shown, after: values });
        }
      } else {
        entry.targetId = spec.table === "settings" ? String(raw.key) : allocate(spec.table);
        pendingChanges.push({ item, table: spec.table, before: null, after: values });
      }
      resolvedFor(spec.table).set(key, entry.targetId);
    }
    byParent.set(spec.table, planned);
  }

  // References read as what they name, not as ids that mean nothing to the reader.
  const nameOf = (table: string, id: unknown): string => {
    if (table === "agents") {
      const agent = local.all("agents").find((row) => row.id === id);
      if (agent) return String(agent.name);
    }
    for (const [key, localId] of resolvedFor(table))
      if (localId === id) return itemLabel(table, key);
    return `#${String(id)}`;
  };
  const display = (table: string, row: Row, omit: readonly string[] = []): Row => {
    const references = referencesOf(table);
    return masked(
      Object.fromEntries(
        Object.entries(row)
          .filter(([column]) => !omit.includes(column))
          .map(([column, value]) => {
            const reference = references.get(column);
            return [
              column,
              reference && value !== null && value !== undefined
                ? nameOf(reference.target, value)
                : value,
            ];
          }),
      ),
    );
  };
  const pemColumns = (table: string) =>
    tableInfo(table)
      .columns.map((column) => column.name)
      .filter((column) => column.endsWith("Pem"));
  for (const { item, table, before, after } of pendingChanges) {
    if (item.action === "skip") continue;
    item.changes = diffAuditRecords(before && display(table, before), display(table, after), {
      omit: [...DISPLAY_OMIT, ...pemColumns(table)],
    });
  }
  for (const { item, table, parentColumn, before, after } of pendingChildren) {
    if (item.action === "skip") continue;
    const omit = [...DISPLAY_OMIT, parentColumn];
    const list = (rows: Row[]) =>
      rows
        .map((row) => display(table, row, omit))
        .sort((a, b) => canonical(a).localeCompare(canonical(b)));
    item.changes.push(
      ...diffAuditRecords(item.action === "create" ? null : { [table]: list(before) }, {
        [table]: list(after),
      }),
    );
  }
  return { file, rows, warnings };
}

/** A domain or listener an earlier row of the same file already takes. */
function fileConflict(
  table: string,
  values: Row,
  domains: Map<string, string>,
  listeners: Map<string, string>,
): { reason: SkipReason; values: Record<string, string> } | null {
  if (table === "proxy_hosts") {
    const clash = hostDomains(values.domains).find((domain) => domains.has(domain));
    if (clash) {
      return {
        reason: "domainConflict",
        values: { domain: clash, host: domains.get(clash) as string },
      };
    }
  }
  if (table === "l4_proxy_hosts") {
    const owner = listeners.get(hostListener(values));
    if (owner) {
      return {
        reason: "listenerConflict",
        values: { listen: String(values.listenAddress), host: owner },
      };
    }
  }
  return null;
}

function claim(
  table: string,
  values: Row,
  label: string,
  domains: Map<string, string>,
  listeners: Map<string, string>,
): void {
  if (table === "proxy_hosts") {
    for (const domain of hostDomains(values.domains)) domains.set(domain, label);
  }
  if (table === "l4_proxy_hosts") listeners.set(hostListener(values), label);
}

function hostDomains(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((d) => String(d).toLowerCase()) : [];
  } catch {
    return [];
  }
}

/** Another local host already answering for one of its names, or listening where it would. */
function findConflict(
  table: string,
  values: Row,
  matchedId: unknown,
  local: LocalIndex,
): { reason: SkipReason; values: Record<string, string> } | null {
  if (table === "proxy_hosts") {
    const wanted = new Set(hostDomains(values.domains));
    for (const host of local.all("proxy_hosts")) {
      if (host.id === matchedId) continue;
      const clash = hostDomains(host.domains).find((domain) => wanted.has(domain));
      if (clash)
        return { reason: "domainConflict", values: { domain: clash, host: String(host.name) } };
    }
  }
  if (table === "l4_proxy_hosts") {
    for (const host of local.all("l4_proxy_hosts")) {
      if (host.id === matchedId) continue;
      if (
        host.protocol === values.protocol &&
        host.listenAddress === values.listenAddress &&
        (host.matcherType ?? "none") === (values.matcherType ?? "none") &&
        (host.matcherValue ?? null) === (values.matcherValue ?? null)
      ) {
        return {
          reason: "listenerConflict",
          values: { listen: String(values.listenAddress), host: String(host.name) },
        };
      }
    }
  }
  return null;
}

function summarize(plan: Plan): ConfigImportPreview {
  const items = plan.rows.map((row) => row.item);
  const counts: Record<ImportAction, number> = { create: 0, update: 0, skip: 0 };
  for (const item of items) counts[item.action] += 1;
  return {
    appVersion: plan.file.appVersion,
    exportedAt: plan.file.exportedAt,
    sections: plan.file.sections,
    items,
    counts,
    warnings: plan.warnings,
  };
}

/** The dry run: everything the import would do, nothing written. */
export async function previewConfigImport(
  bytes: Buffer,
  passphrase: string,
): Promise<ConfigImportPreview> {
  return summarize(await planImport(await openConfigFile(bytes, passphrase)));
}

/** Header fields only, before a passphrase is asked for. */
export function describeConfigFile(bytes: Buffer) {
  const file = readConfigFile(bytes);
  return {
    appVersion: file.appVersion,
    exportedAt: file.exportedAt,
    sections: file.sections.filter((s) => CONFIG_SECTIONS.includes(s)),
    counts: Object.fromEntries(
      Object.entries(file.tables).map(([table, rows]) => [
        table,
        Array.isArray(rows) ? rows.length : 0,
      ]),
    ),
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────

async function toFields(table: string, row: Row): Promise<Row> {
  const fields = fieldsOf(table);
  const booleans = new Set(
    tableInfo(table)
      .columns.filter((c) => c.isBoolean)
      .map((c) => c.name),
  );
  const sealed = await importRow(table, row);
  const out: Row = {};
  for (const [column, value] of Object.entries(sealed)) {
    const field = fields.get(column);
    if (!field) continue;
    out[field] = booleans.has(column) && typeof value === "number" ? value === 1 : value;
  }
  return out;
}

function hasColumn(table: string, column: string): boolean {
  return tableInfo(table).columns.some((c) => c.name === column);
}

/** Re-plans against the current state, so a stale preview is never what gets written. */
export async function applyConfigImport(
  bytes: Buffer,
  passphrase: string,
  actorUserId: number,
): Promise<ConfigImportPreview> {
  const plan = await planImport(await openConfigFile(bytes, passphrase));
  const now = nowIso();
  type Write =
    | { kind: "insert"; table: string; values: Row }
    | { kind: "update"; table: string; id: number; values: Row }
    | { kind: "setting"; values: Row }
    | { kind: "replace"; table: string; parentColumn: string; parentId: number; rows: Row[] };
  const writes: Write[] = [];
  // After every parent: a group's grants name hosts planned after the group.
  const childWrites: Extract<Write, { kind: "replace" }>[] = [];
  const created = new Set<string>();

  for (const planned of plan.rows) {
    const { spec, item } = planned;
    if (item.action === "skip") continue;
    const table = spec.table;
    const stamp = (row: Row, isCreate: boolean): Row => ({
      ...row,
      ...(hasColumn(table, "updatedAt") ? { updatedAt: now } : {}),
      ...(isCreate && hasColumn(table, "createdAt") ? { createdAt: now } : {}),
    });
    if (table === "settings") {
      const values = await toFields(table, {
        key: planned.targetId,
        value: planned.values.value,
        updatedAt: now,
      });
      // A credential the file carried in the clear is stored as a save would store it.
      if (typeof values.value === "string") {
        values.value = encryptSettingCredentials(String(planned.targetId), values.value);
      }
      writes.push({ kind: "setting", values });
      continue;
    }
    const id = planned.targetId as number;
    if (item.action === "create") {
      const values = { ...planned.values };
      if (hasColumn(table, "createdBy") && values.createdBy == null) values.createdBy = actorUserId;
      writes.push({
        kind: "insert",
        table,
        values: await toFields(table, { ...stamp(values, true), id }),
      });
      created.add(table);
    } else {
      const values = Object.fromEntries(
        Object.entries(planned.values).filter(
          ([column]) => !["createdAt", "createdBy", "ownerUserId"].includes(column),
        ),
      );
      writes.push({
        kind: "update",
        table,
        id,
        values: await toFields(table, stamp(values, false)),
      });
    }
    for (const [childTable, children] of planned.children) {
      const childSpec = SPEC_BY_TABLE.get(childTable);
      if (!childSpec?.parent) continue;
      const parentColumn = childSpec.parent.column;
      childWrites.push({
        kind: "replace",
        table: childTable,
        parentColumn,
        parentId: id,
        rows: await Promise.all(
          children.map((child) =>
            toFields(childTable, {
              ...child,
              [parentColumn]: id,
              ...(hasColumn(childTable, "createdAt") ? { createdAt: now } : {}),
              ...(hasColumn(childTable, "updatedAt") ? { updatedAt: now } : {}),
            }),
          ),
        ),
      });
    }
  }

  const order = (table: string) => CONFIG_TABLES.findIndex((spec) => spec.table === table);
  writes.push(...childWrites.sort((a, b) => order(a.table) - order(b.table)));

  if (writes.length > 0) {
    await runInTransaction((tx) =>
      writes.flatMap((write) => {
        if (write.kind === "setting") {
          const settings = drizzleTable("settings") as unknown as typeof activeSchema.settings;
          return [
            tx
              .insert(settings)
              .values(write.values)
              .onConflictDoUpdate({
                target: settings.key,
                set: { value: write.values.value, updatedAt: write.values.updatedAt },
              }),
          ];
        }
        // biome-ignore lint/suspicious/noExplicitAny: the columns are per-table, the loop is generic
        const target = drizzleTable(write.table) as any;
        if (write.kind === "insert") return [tx.insert(target).values(write.values)];
        if (write.kind === "update") {
          return [tx.update(target).set(write.values).where(eq(target.id, write.id))];
        }
        const field = fieldsOf(write.table).get(write.parentColumn) as string;
        return [
          tx.delete(target).where(eq(target[field], write.parentId)),
          ...(write.rows.length > 0 ? [tx.insert(target).values(write.rows)] : []),
        ];
      }),
    );
    if (schemaDialect === "postgres") {
      for (const table of created) {
        const serial = tableInfo(table).serialColumn;
        if (serial) await resyncSequence(table, serial);
      }
    }
    invalidateSettingsCache();
    await applyCaddyConfig().catch((error) => {
      // The rows are in: a failed reload is retried by the next apply, as after any save.
      console.error("Config import: applying the new configuration failed:", error);
    });
  }

  const preview = summarize(plan);
  await logAuditEvent({
    userId: actorUserId,
    action: "config_imported",
    entityType: "config",
    summary: `Imported a configuration (${preview.counts.create} created, ${preview.counts.update} updated, ${preview.counts.skip} skipped)`,
    data: {
      exportedAt: preview.exportedAt,
      appVersion: preview.appVersion,
      sections: preview.sections,
      items: preview.items
        .filter((item) => item.action !== "skip" || item.reason !== "unchanged")
        .map(({ table, label, action, reason, fields, kept }) => ({
          table,
          label,
          action,
          reason,
          fields,
          kept,
        })),
    },
  });
  return preview;
}

/** Audited by the caller, who knows whether it was the UI or the API. */
export async function exportConfigAudited(
  passphrase: string,
  options: ExportOptions,
  actorUserId: number,
): Promise<Buffer> {
  const file = await exportConfig(passphrase, options);
  await logAuditEvent({
    userId: actorUserId,
    action: "config_exported",
    entityType: "config",
    summary: "Exported the configuration",
    data: { sections: options.sections ?? CONFIG_SECTIONS },
  });
  return file;
}
