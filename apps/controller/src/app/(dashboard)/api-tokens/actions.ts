"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/src/lib/auth";
import { createApiToken, deleteApiToken } from "@/src/lib/models/api-tokens";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { domainError } from "@/src/lib/errors/domain-error";
import { runAction } from "@/src/lib/errors/run-action";
import { resolveTokenExpiry, tokenExpiryPreset } from "@/src/lib/api-tokens/expiry";
import { parseTokenScope } from "@/src/lib/api-tokens/scope";

export type CreateApiTokenInput = {
  name: string;
  expiry: string;
  /** The picker's value, for the custom expiry only. */
  expiresAt?: string;
  scope: string;
  permissions: string[];
};

export async function createApiTokenAction(
  input: CreateApiTokenInput,
): Promise<ActionResult<{ rawToken: string }>> {
  return runAction(async () => {
    const session = await requireUser();
    const userId = Number(session.user.id);
    const name = String(input.name ?? "").trim();

    // A token carries the account's real role, a confusing thing to mint mid-preview.
    if (session.viewAs) throw domainError("viewAsForbidden");
    if (!name) throw domainError("nameRequired");

    const { rawToken } = await createApiToken(
      name,
      userId,
      resolveTokenExpiry(tokenExpiryPreset(input.expiry), input.expiresAt),
      parseTokenScope(input.scope, input.permissions),
    );
    revalidatePath("/profile");
    return { rawToken };
  });
}

export async function deleteApiTokenAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireUser();
    await deleteApiToken(id, Number(session.user.id));
    revalidatePath("/profile");
  });
}
