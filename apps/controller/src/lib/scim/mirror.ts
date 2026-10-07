/**
 * After a SCIM write commits: the provisioned group's CPM twin brought in line (the projection only
 * reaches groups someone is in, so an empty or deleted group is handled here), and one audit row
 * for what the identity provider changed.
 */
import { eq } from "drizzle-orm";
import db, { nowIso } from "../db";
import { groups, scimGroups } from "../db/schema";
import { logAuditEvent } from "../audit";
import { authenticateScimToken, mappedGroupRole } from "./connections";

export async function syncGroupMirror(scimGroupId: string): Promise<void> {
  const id = Number(scimGroupId);
  if (!Number.isInteger(id)) return;
  const [row] = await db.select().from(scimGroups).where(eq(scimGroups.id, id)).limit(1);
  const [mirror] = await db
    .select()
    .from(groups)
    .where(eq(groups.scimGroupId, scimGroupId))
    .limit(1);
  if (!row) {
    if (mirror?.source === "scim") await db.delete(groups).where(eq(groups.id, mirror.id));
    return;
  }
  const role = await mappedGroupRole(Number(row.connectionId), row.displayName);
  const now = nowIso();
  if (mirror) {
    if (mirror.name !== row.displayName || mirror.role !== role) {
      await db
        .update(groups)
        .set({ name: row.displayName, role, updatedAt: now })
        .where(eq(groups.id, mirror.id));
    }
    return;
  }
  const [taken] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(eq(groups.name, row.displayName))
    .limit(1);
  // A group of the same name made on the Groups page keeps it; the twin waits for a rename.
  if (taken) return;
  await db.insert(groups).values({
    name: row.displayName,
    source: "scim",
    role,
    scimGroupId,
    createdAt: now,
    updatedAt: now,
  });
}

const VERBS = { POST: "created", PUT: "updated", PATCH: "updated", DELETE: "removed" } as const;

/** One row per write, naming the connection and what it touched. */
export async function auditScimWrite(input: {
  method: string;
  kind: "user" | "group";
  token: string | null;
  // biome-ignore lint/suspicious/noExplicitAny: the plugin's resource as it answered
  resource: any;
  resourceId: string | null;
}): Promise<void> {
  const verb = VERBS[input.method as keyof typeof VERBS];
  if (!verb) return;
  const connection = input.token ? await authenticateScimToken(input.token) : null;
  const name =
    input.kind === "user"
      ? (input.resource?.userName ?? input.resourceId)
      : (input.resource?.displayName ?? input.resourceId);
  await logAuditEvent({
    userId: null,
    action: `scim_${verb}`,
    entityType: input.kind === "user" ? "scim_user" : "scim_group",
    entityId: null,
    summary: `SCIM connection ${connection?.name ?? "?"} ${verb} ${input.kind} ${name ?? "?"}`,
    data: {
      scimConnectionId: connection?.id ?? null,
      resourceId: input.resource?.id ?? input.resourceId,
      ...(input.kind === "user" && typeof input.resource?.active === "boolean"
        ? { active: input.resource.active }
        : {}),
    },
  });
}
