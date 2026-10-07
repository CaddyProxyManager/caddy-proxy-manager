import { requireCan } from "@/src/lib/users/permissions";
import AccessListsClient from "./AccessListsClient";
import {
  listAccessLists,
  getAccessListUsageMap,
  type AccessListUsage,
} from "@/src/lib/models/access-lists";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("accessLists") };
}

export default async function AccessListsPage() {
  await requireCan("accessLists:read");

  const [lists, usageMap] = await Promise.all([listAccessLists(), getAccessListUsageMap()]);

  const usage: Record<number, AccessListUsage[]> = {};
  for (const [listId, hosts] of usageMap) {
    usage[listId] = hosts;
  }

  return <AccessListsClient lists={lists} usage={usage} />;
}
