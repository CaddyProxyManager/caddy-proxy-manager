"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/src/lib/auth";
import {
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMember,
  removeGroupMember,
} from "@/src/lib/models/groups";
import { setGroupMappings } from "@/src/lib/models/group-idp-mappings";
import {
  type GrantCapability,
  type GrantResource,
  setGroupGrants,
} from "@/src/lib/models/group-grants";
import { logAuditEvent } from "@/src/lib/audit";

export async function createGroupAction(formData: FormData): Promise<{ id: number }> {
  const session = await requireAdmin();
  const userId = Number(session.user.id);

  const group = await createGroup(
    {
      name: String(formData.get("name") ?? ""),
      description: formData.get("description") ? String(formData.get("description")) : null,
    },
    userId,
  );

  revalidatePath("/groups");
  revalidatePath("/users");
  return { id: group.id };
}

export async function updateGroupAction(id: number, formData: FormData) {
  const session = await requireAdmin();
  const userId = Number(session.user.id);

  await updateGroup(
    id,
    {
      name: String(formData.get("name") ?? ""),
      description: formData.get("description") ? String(formData.get("description")) : null,
    },
    userId,
  );

  revalidatePath("/groups");
}

export async function deleteGroupAction(id: number) {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  await deleteGroup(id, userId);
  revalidatePath("/groups");
  revalidatePath("/users");
}

export async function addGroupMemberAction(groupId: number, memberId: number) {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  await addGroupMember(groupId, memberId, userId);
  revalidatePath("/groups");
  // The Users page shows each account's groups, and changes them from there too.
  revalidatePath("/users");
}

export async function addGroupMembersAction(groupId: number, memberIds: number[]) {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  for (const memberId of new Set(memberIds)) {
    await addGroupMember(groupId, memberId, userId);
  }
  revalidatePath("/groups");
  revalidatePath("/users");
}

export async function removeGroupMemberAction(groupId: number, memberId: number) {
  const session = await requireAdmin();
  const userId = Number(session.user.id);
  await removeGroupMember(groupId, memberId, userId);
  revalidatePath("/groups");
  revalidatePath("/users");
}

/** Admin-only: an operator editing a grant could widen their own access. */
export async function setGroupMappingsAction(
  groupId: number,
  entries: { providerId: string | null; externalName: string }[],
) {
  const session = await requireAdmin();
  await setGroupMappings(groupId, entries);
  await logAuditEvent({
    userId: Number(session.user.id),
    action: "update",
    entityType: "group",
    entityId: groupId,
    summary: `Updated the IdP group mappings for group ${groupId}`,
    data: { entries },
  });
  revalidatePath("/groups");
}

/** Audited: a privilege change. */
export async function setGroupGrantsAction(
  groupId: number,
  grants: { resource: GrantResource; capability: GrantCapability }[],
) {
  const session = await requireAdmin();
  await setGroupGrants(groupId, grants);
  await logAuditEvent({
    userId: Number(session.user.id),
    action: "update",
    entityType: "group",
    entityId: groupId,
    summary: `Updated the management grants for group ${groupId}`,
    data: { grants },
  });
  revalidatePath("/groups");
}
