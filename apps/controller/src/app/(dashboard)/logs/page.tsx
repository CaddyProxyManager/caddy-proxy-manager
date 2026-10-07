import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { logReadableAgents } from "@/src/lib/agent/client";
import { isLogView } from "@/src/lib/analytics/log-view";
import { getLoggingSettings } from "@/src/lib/settings";
import LogsClient from "./LogsClient";

export async function generateMetadata(): Promise<Metadata> {
  const tNav = await getTranslations("nav");
  return { title: tNav("logs") };
}

/** `?source=access&host=app.example.com` is how a host's Logs action opens it. */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCan("logs:read");
  const params = await searchParams;
  const view = isLogView(params.source) ? params.source : "access";
  const host = typeof params.host === "string" ? params.host : null;
  const agent = typeof params.agent === "string" ? params.agent : null;
  return (
    <LogsClient
      agents={logReadableAgents().map((a) => ({ ...a, canReadLogs: true }))}
      initialAgent={agent}
      initialView={view}
      initialHost={host}
      accessLogEnabled={(await getLoggingSettings())?.enabled === true}
    />
  );
}
