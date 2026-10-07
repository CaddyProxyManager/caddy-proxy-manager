"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import {
  type Role,
  type RoleInput,
  createRole,
  deleteRole,
  updateRole,
} from "@/src/lib/roles/store";
import { requireCanAccess } from "@/src/lib/users/permissions";

const PAGE = "/users/roles";

async function actor() {
  const { session, access } = await requireCanAccess("roles:write");
  return { userId: Number(session.user.id), role: access.role, capabilities: access.capabilities };
}

/** Null `key` makes a role. */
export async function saveRoleAction(
  key: string | null,
  input: RoleInput,
): Promise<ActionResult<Role>> {
  return runAction(async () => {
    const by = await actor();
    const saved = key === null ? await createRole(input, by) : await updateRole(key, input, by);
    revalidatePath(PAGE);
    revalidatePath("/users");
    return saved;
  });
}

export async function deleteRoleAction(key: string): Promise<ActionResult> {
  return runAction(async () => {
    const by = await actor();
    await deleteRole(key, by);
    revalidatePath(PAGE);
  });
}
