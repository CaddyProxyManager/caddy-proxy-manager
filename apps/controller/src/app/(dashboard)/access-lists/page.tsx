import AccessListsClient from "./AccessListsClient";
import { listAccessLists, getAccessListUsageMap } from "@/src/lib/models/access-lists";
import { requireAdmin } from "@/src/lib/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("accessLists") };
}

export default async function AccessListsPage() {
  await requireAdmin();

  const [lists, usageMap] = await Promise.all([listAccessLists(), getAccessListUsageMap()]);

  const usage: Record<number, { id: number; name: string; domains: string[]; enabled: boolean }[]> =
    {};
  for (const [listId, hosts] of usageMap) {
    usage[listId] = hosts;
  }

  return <AccessListsClient lists={lists} usage={usage} />;
}
