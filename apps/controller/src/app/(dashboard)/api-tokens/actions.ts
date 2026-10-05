"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { createApiToken, deleteApiToken } from "@/src/lib/models/api-tokens";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
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
): Promise<{ rawToken: string } | { error: string }> {
  const session = await requireUser();
  const userId = Number(session.user.id);
  const name = String(input.name ?? "").trim();

  // A token carries the account's real role, a confusing thing to mint mid-preview.
  if (session.viewAs) {
    const t = await getTranslations("errors");
    return { error: t("viewAsForbidden") };
  }

  if (!name) {
    const t = await getTranslations("errors");
    return { error: t("nameRequired") };
  }

  // The model refuses with codes; translate them before the client shows the message.
  const { rawToken } = await withTranslatedErrors(async () =>
    createApiToken(
      name,
      userId,
      resolveTokenExpiry(tokenExpiryPreset(input.expiry), input.expiresAt),
      parseTokenScope(input.scope, input.permissions),
    ),
  );
  revalidatePath("/profile");
  return { rawToken };
}

export async function deleteApiTokenAction(id: number) {
  const session = await requireUser();
  const userId = Number(session.user.id);
  await deleteApiToken(id, userId);
  revalidatePath("/profile");
}
