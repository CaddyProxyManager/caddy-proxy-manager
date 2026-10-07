export const dynamic = "force-dynamic";

import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getCaddyModuleAvailability, isFeatureUsable } from "@/src/lib/caddy/image-build";
import { listBlockedSources } from "@/src/lib/models/blocked-sources";
import BlockedSourcesClient from "./BlockedSourcesClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("security");
  return { title: t("blockedSources") };
}

export default async function BlockedSourcesPage() {
  await requireCan("security:read");
  const [sources, availability] = await Promise.all([
    listBlockedSources(),
    getCaddyModuleAvailability(),
  ]);
  return (
    <BlockedSourcesClient sources={sources} geoUsable={isFeatureUsable(availability, "geoblock")} />
  );
}
