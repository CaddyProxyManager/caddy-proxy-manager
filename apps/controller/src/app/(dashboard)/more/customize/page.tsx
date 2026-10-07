import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { currentAccess } from "@/src/lib/users/permissions";
import { getMoreDrawerPins } from "@/src/lib/models/nav-preferences";
import { moreDestinations, resolveDrawer } from "@/src/lib/nav/destinations";
import CustomizeDrawerClient from "./CustomizeDrawerClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav.more");
  return { title: t("customizeTitle") };
}

export default async function CustomizeDrawerPage() {
  const { session, access } = await currentAccess();
  const pins = await getMoreDrawerPins(Number(session.user.id));
  return (
    <CustomizeDrawerClient
      destinations={moreDestinations(access.capabilities)}
      initial={resolveDrawer(pins, access.capabilities).map((d) => d.id)}
    />
  );
}
