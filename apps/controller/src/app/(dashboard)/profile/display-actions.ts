"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { extractErrorMessage } from "@/src/lib/errors/action-error";
import { setTableDensity } from "@/src/lib/models/table-density";
import { isTableDensity } from "@/src/lib/users/table-density";
import { setDisplayPreferences } from "@/src/lib/users/display-preferences";

export type SaveDensityResult = { ok: true } | { ok: false; error: string };

async function failure(error: unknown): Promise<SaveDensityResult> {
  unstable_rethrow(error);
  console.error("Failed to save a display preference:", error);
  const t = await getTranslations();
  return { ok: false, error: extractErrorMessage(t, error, t("common.somethingWentWrong")) };
}

/** Save how tightly the signed-in user's tables are set. Any signed-in user may choose their own. */
export async function saveTableDensityAction(density: string): Promise<SaveDensityResult> {
  try {
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
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}

/** Time zone and number format, stored on the account so they follow it to every browser. */
export async function saveDisplayPreferencesAction(input: {
  timeZone: string | null;
  numberFormat: string;
}): Promise<SaveDensityResult> {
  try {
    const session = await requireUser();
    await setDisplayPreferences(Number(session.user.id), input);
    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error);
  }
}
