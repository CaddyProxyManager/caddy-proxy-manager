"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
import {
  type ScimConnection,
  type ScimConnectionInput,
  createScimConnection,
  deleteScimConnection,
  rotateScimConnectionToken,
  updateScimConnection,
} from "@/src/lib/scim/connections";
import { requireCanAccess } from "@/src/lib/users/permissions";

const PAGE = "/users/provisioning";

async function actor() {
  const { session, access } = await requireCanAccess("users:write");
  return { userId: Number(session.user.id), capabilities: access.capabilities };
}

/** Null `id` makes a connection, and only then is a token answered. */
export async function saveScimConnectionAction(
  id: number | null,
  input: ScimConnectionInput,
): Promise<ActionResult<{ connection: ScimConnection; token: string | null }>> {
  return runAction(async () => {
    const by = await actor();
    const result =
      id === null
        ? await createScimConnection(input, by)
        : { connection: await updateScimConnection(id, input, by), token: null };
    revalidatePath(PAGE);
    return result;
  });
}

export async function rotateScimTokenAction(id: number): Promise<ActionResult<string>> {
  return runAction(async () => {
    const { token } = await rotateScimConnectionToken(id, await actor());
    revalidatePath(PAGE);
    return token;
  });
}

export async function deleteScimConnectionAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    await deleteScimConnection(id, await actor());
    revalidatePath(PAGE);
  });
}
