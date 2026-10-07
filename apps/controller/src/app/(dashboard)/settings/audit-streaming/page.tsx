import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { stagedView } from "@/src/lib/settings/staged-view";
import { loadSinksAction } from "./actions";
import AuditStreamingClient from "./AuditStreamingClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("auditStreaming.navLabel") };
}

export default async function AuditStreamingPage() {
  const session = await requireCan("audit:read");
  const [staged, sinks] = await Promise.all([
    stagedView(Number(session.user.id)),
    loadSinksAction(),
  ]);
  return <AuditStreamingClient staged={staged} initial={sinks} />;
}
