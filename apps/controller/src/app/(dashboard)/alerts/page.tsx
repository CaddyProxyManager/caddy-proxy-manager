import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { loadAlertsOverviewAction } from "./actions";
import AlertsClient from "./AlertsClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("alerts") };
}

export default async function AlertsPage() {
  await requireCan("alerts:read");
  return <AlertsClient initial={await loadAlertsOverviewAction()} />;
}
