"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { setTableDensity } from "@/src/lib/models/table-density";
import { isTableDensity } from "@/src/lib/users/table-density";
import { setDisplayPreferences } from "@/src/lib/users/display-preferences";
import { DomainError } from "@/src/lib/errors/domain-error";

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

/** Time zone and number format, stored on the account so they follow it to every browser. */
export async function saveDisplayPreferencesAction(input: {
  timeZone: string | null;
  numberFormat: string;
}): Promise<SaveDensityResult> {
  const session = await requireUser();
  try {
    await setDisplayPreferences(Number(session.user.id), input);
  } catch (error) {
    if (error instanceof DomainError) {
      const t = await getTranslations("errors");
      return { ok: false, error: t(error.code) };
    }
    throw error;
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
