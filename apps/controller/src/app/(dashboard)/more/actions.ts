"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { currentAccess } from "@/src/lib/users/permissions";
import { setMoreDrawerPins } from "@/src/lib/models/nav-preferences";
import { MORE_DRAWER_SLOTS, moreDestinations } from "@/src/lib/nav/destinations";

export type SaveDrawerResult = { ok: true } | { ok: false; error: string };

export async function saveMoreDrawerPinsAction(ids: string[]): Promise<SaveDrawerResult> {
  const { session, access } = await currentAccess();
  const t = await getTranslations("nav.more");

  // What this user may open, not just what exists: a posted "settings" must not pin a refused page.
  const allowed = new Set(moreDestinations(access.capabilities).map((d) => d.id));
  const chosen = [...new Set(ids)].filter((id) => allowed.has(id as never));

  if (chosen.length !== new Set(ids).size) {
    return { ok: false, error: t("errorUnknownPage") };
  }
  if (chosen.length > MORE_DRAWER_SLOTS) {
    return { ok: false, error: t("errorTooMany", { max: MORE_DRAWER_SLOTS }) };
  }

  await setMoreDrawerPins(
    Number(session.user.id),
    chosen as Parameters<typeof setMoreDrawerPins>[1],
  );
  // The drawer is in the dashboard layout, so every page under it has a stale copy.
  revalidatePath("/", "layout");
  return { ok: true };
}
