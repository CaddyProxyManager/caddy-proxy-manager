export const dynamic = "force-dynamic";

import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { parseExploreState } from "@/src/lib/analytics/explore-state";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { getSecurityReport } from "@/src/lib/security/report";
import SecurityClient from "./SecurityClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("security") };
}

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SecurityPage({ searchParams }: PageProps) {
  await requireCan("security:read");
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      params.append(key, one);
    }
  }
  const page = Number.parseInt(params.get("page") ?? "1", 10) || 1;
  const [report, hosts] = await Promise.all([
    getSecurityReport(parseExploreState(params), page),
    listProxyHosts(),
  ]);
  return (
    <SecurityClient
      report={report}
      hosts={hosts
        .map((host) => ({ id: host.id, name: host.name }))
        .sort((a, b) => a.name.localeCompare(b.name))}
    />
  );
}
