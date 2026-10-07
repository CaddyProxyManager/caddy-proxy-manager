"use server";

import { requireCan, requireCanAccess } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import {
  createGroup,
  updateGroup,
  deleteGroup,
  addGroupMember,
  assertMayAddToGroup,
  removeGroupMember,
  setGroupRole,
} from "@/src/lib/models/groups";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import { setGroupMappings } from "@/src/lib/models/group-idp-mappings";
import {
  type GrantCapability,
  type GrantResource,
  assertMayGrant,
  setGroupGrants,
} from "@/src/lib/models/group-grants";
import { logAuditEvent } from "@/src/lib/audit";

export async function createGroupAction(formData: FormData): Promise<{ id: number }> {
  const session = await requireCan("groups:write");
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
  const session = await requireCan("groups:write");
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
  const session = await requireCan("groups:write");
  const userId = Number(session.user.id);
  await deleteGroup(id, userId);
  revalidatePath("/groups");
  revalidatePath("/users");
}

export async function addGroupMemberAction(groupId: number, memberId: number) {
  const { session, access } = await requireCanAccess("groups:write");
  const userId = Number(session.user.id);
  await withTranslatedErrors(() => assertMayAddToGroup(access.capabilities, groupId));
  await addGroupMember(groupId, memberId, userId);
  revalidatePath("/groups");
  // The Users page shows each account's groups, and changes them from there too.
  revalidatePath("/users");
}

export async function addGroupMembersAction(groupId: number, memberIds: number[]) {
  const { session, access } = await requireCanAccess("groups:write");
  const userId = Number(session.user.id);
  await withTranslatedErrors(() => assertMayAddToGroup(access.capabilities, groupId));
  for (const memberId of new Set(memberIds)) {
    await addGroupMember(groupId, memberId, userId);
  }
  revalidatePath("/groups");
  revalidatePath("/users");
}

export async function removeGroupMemberAction(groupId: number, memberId: number) {
  const session = await requireCan("groups:write");
  const userId = Number(session.user.id);
  await removeGroupMember(groupId, memberId, userId);
  revalidatePath("/groups");
  revalidatePath("/users");
}

export async function setGroupMappingsAction(
  groupId: number,
  entries: { providerId: string | null; externalName: string }[],
) {
  const session = await requireCan("groups:write");
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
  const { session, access } = await requireCanAccess("groups:write");
  await withTranslatedErrors(async () => assertMayGrant(access.capabilities, grants));
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

/** The role every member holds besides their own; null for none. */
export async function setGroupRoleAction(groupId: number, role: string | null): Promise<void> {
  const { session, access } = await requireCanAccess("groups:write");
  await withTranslatedErrors(() =>
    setGroupRole(groupId, role, {
      userId: Number(session.user.id),
      capabilities: access.capabilities,
    }),
  );
  revalidatePath("/groups");
  revalidatePath("/users");
}
