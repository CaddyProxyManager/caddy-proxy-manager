import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { currentAccess } from "@/src/lib/users/permissions";
import { getMoreDrawerPins } from "@/src/lib/models/nav-preferences";
import { moreDestinations, resolveDrawer } from "@/src/lib/nav/destinations";
import MoreClient from "./MoreClient";

/**
 * Every page the phone's tab bar cannot name, grouped. Reached from All pages in the More drawer,
 * or by double-tapping More.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav.more");
  return { title: t("title") };
}

export default async function MorePage() {
  const { session, access } = await currentAccess();
  const pins = await getMoreDrawerPins(Number(session.user.id));
  return (
    <MoreClient
      destinations={moreDestinations(access.capabilities)}
      inDrawer={resolveDrawer(pins, access.capabilities).map((d) => d.id)}
    />
  );
}
