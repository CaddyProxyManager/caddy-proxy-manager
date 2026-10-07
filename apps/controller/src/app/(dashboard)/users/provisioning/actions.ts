"use server";

import { revalidatePath } from "next/cache";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
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
): Promise<{ connection: ScimConnection; token: string | null }> {
  const by = await actor();
  return withTranslatedErrors(async () => {
    const result =
      id === null
        ? await createScimConnection(input, by)
        : { connection: await updateScimConnection(id, input, by), token: null };
    revalidatePath(PAGE);
    return result;
  });
}

export async function rotateScimTokenAction(id: number): Promise<string> {
  const by = await actor();
  return withTranslatedErrors(async () => {
    const { token } = await rotateScimConnectionToken(id, by);
    revalidatePath(PAGE);
    return token;
  });
}

export async function deleteScimConnectionAction(id: number): Promise<void> {
  const by = await actor();
  await withTranslatedErrors(async () => {
    await deleteScimConnection(id, by);
    revalidatePath(PAGE);
  });
}
