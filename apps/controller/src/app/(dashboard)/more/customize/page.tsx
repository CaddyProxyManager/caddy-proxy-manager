import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/src/lib/auth";
import { getMoreDrawerPins } from "@/src/lib/models/nav-preferences";
import { moreDestinations, resolveDrawer } from "@/src/lib/nav/destinations";
import CustomizeDrawerClient from "./CustomizeDrawerClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav.more");
  return { title: t("customizeTitle") };
}

export default async function CustomizeDrawerPage() {
  const session = await requireUser();
  const pins = await getMoreDrawerPins(Number(session.user.id));
  return (
    <CustomizeDrawerClient
      destinations={moreDestinations(session.user.role)}
      initial={resolveDrawer(pins, session.user.role).map((d) => d.id)}
    />
  );
}
