/**
 * The review step's diff for the audit log: the same fields and masking, ids read as names the
 * way the review shows them. Reads only name columns, so the host models can import it.
 */
import { inArray } from "drizzle-orm";
import db from "../db";
import { accessLists, agents, certificates } from "../db/schema";
import { type AuditChange, fromHostChanges } from "../audit/changes";
import { diffHostFields } from "./diff";
import type { HostKind } from "./types";

type HostLike = Record<string, unknown> & {
  certificateId?: number | null;
  accessListId?: number | null;
};

export type HostAuditSide = { host: HostLike; agentIds: readonly number[] } | null;

async function nameMap(
  table: typeof agents | typeof accessLists | typeof certificates,
  ids: number[],
): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(inArray(table.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

const ids = (values: (number | null | undefined)[]) => [
  ...new Set(values.filter((v): v is number => typeof v === "number")),
];

/** A null `before` is a create, a null `after` a delete; both diff against `blank`. */
export async function hostAuditChanges(
  kind: HostKind,
  before: HostAuditSide,
  after: HostAuditSide,
  blank: HostLike,
): Promise<AuditChange[]> {
  const sides = [before, after].filter((side): side is NonNullable<HostAuditSide> => !!side);
  const [agentNames, listNames, certNames] = await Promise.all([
    nameMap(agents, ids(sides.flatMap((side) => [...side.agentIds]))),
    nameMap(accessLists, ids(sides.map((side) => side.host.accessListId))),
    kind === "http"
      ? nameMap(certificates, ids(sides.map((side) => side.host.certificateId)))
      : Promise.resolve(new Map<number, string>()),
  ]);
  const named = (map: Map<number, string>, id: number | null | undefined) =>
    id == null ? null : (map.get(id) ?? `#${id}`);
  const record = (side: NonNullable<HostAuditSide>) => {
    const out: Record<string, unknown> = {
      ...side.host,
      agentIds: [...side.agentIds]
        .map((id) => agentNames.get(id) ?? `#${id}`)
        .sort((a, b) => a.localeCompare(b)),
      accessListId: named(listNames, side.host.accessListId),
    };
    if (kind === "http") out.certificateId = named(certNames, side.host.certificateId);
    return out;
  };
  const blankRecord = record({ host: blank, agentIds: [] });
  const changes = diffHostFields(
    kind,
    before ? record(before) : null,
    after ? record(after) : blankRecord,
    blankRecord,
  );
  return fromHostChanges(changes);
}
