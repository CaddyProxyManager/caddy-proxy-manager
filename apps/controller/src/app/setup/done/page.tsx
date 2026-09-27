import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { dashboardHostAnswers, dashboardHostOrigin } from "@/src/lib/dashboard-host";
import { planEnvCleanup } from "@/src/lib/migration/env-file";
import { getDashboardSettings } from "@/src/lib/settings";
import { SETTING_DEFINITIONS } from "@/src/lib/settings/registry";
import { resolveAllSettings } from "@/src/lib/settings/resolve";
import { getMigrationSource, isSetupCompleted } from "@/src/lib/setup";
import SetupDoneClient from "./SetupDoneClient";
import { sqliteNoticeApplies } from "@/src/lib/sqlite-notice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup.done");
  return { title: { absolute: t("metaTitle") } };
}

/**
 * What a migrated deployment sees after setup: the old database to keep and the `.env` cleanup.
 * A first-run setup never gets here, so it is not told about a file it never had.
 */
export default async function SetupDonePage() {
  const session = await auth();
  if (session?.user?.role !== "admin") redirect("/login");
  if (!(await isSetupCompleted())) redirect("/setup");

  const source = await getMigrationSource();
  if (!source) redirect("/");

  // From the database, not the file: the env usually comes from Compose, Swarm or Kubernetes,
  // none visible from here, but the app knows for certain which settings it now stores.
  const settings = await resolveAllSettings();
  const cleanup = planEnvCleanup(
    SETTING_DEFINITIONS.filter(
      (definition) => settings.get(definition.key)?.source === "stored",
    ).map((definition) => definition.env),
  );

  // A migrated deployment is not handed over to its dashboard domain automatically, so the last
  // button does it - only if the domain answers, since its DNS may not point here yet.
  const dashboardSettings = await getDashboardSettings();
  const dashboard = (await dashboardHostAnswers(dashboardSettings))
    ? dashboardHostOrigin(dashboardSettings)
    : null;

  return (
    <SetupDoneClient
      source={source}
      cleanup={cleanup}
      dashboardOrigin={dashboard}
      sqliteWarning={sqliteNoticeApplies()}
    />
  );
}
