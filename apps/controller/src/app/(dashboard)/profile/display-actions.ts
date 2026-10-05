"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { setTableDensity } from "@/src/lib/models/table-density";
import { isTableDensity } from "@/src/lib/users/table-density";

export type SaveDensityResult = { ok: true } | { ok: false; error: string };

/** Save how tightly the signed-in user's tables are set. Any signed-in user may choose their own. */
export async function saveTableDensityAction(density: string): Promise<SaveDensityResult> {
  const session = await requireUser();
  // A server action is a public endpoint: the parameter's type is not a check on what arrives.
  if (!isTableDensity(density)) {
    const t = await getTranslations("profile");
    return { ok: false, error: t("tableDensityInvalid") };
  }
  await setTableDensity(Number(session.user.id), density);
  // The dashboard layout hands the density to every table, so every page under it has a stale copy.
  revalidatePath("/", "layout");
  return { ok: true };
}
