"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { createApiToken, deleteApiToken } from "@/src/lib/models/api-tokens";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";

export async function createApiTokenAction(
  formData: FormData,
): Promise<{ rawToken: string } | { error: string }> {
  const session = await requireUser();
  const userId = Number(session.user.id);
  const name = String(formData.get("name") ?? "").trim();

  // A token carries the account's real role, a confusing thing to mint mid-preview.
  if (session.viewAs) {
    const t = await getTranslations("errors");
    return { error: t("viewAsForbidden") };
  }

  if (!name) {
    const t = await getTranslations("errors");
    return { error: t("nameRequired") };
  }

  const expiresAt = formData.get("expires_at") ? String(formData.get("expires_at")) : undefined;

  // The model refuses with codes; translate them before the client shows the message.
  const { rawToken } = await withTranslatedErrors(() =>
    createApiToken(name, userId, expiresAt || undefined),
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
