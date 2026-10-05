import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { getMigrationSource, getSetupState, hasLegacyDatabase, SETUP_PATHS } from "@/src/lib/setup";
import SetupAccountClient from "./SetupAccountClient";
import { sqliteNoticeApplies } from "@/src/lib/db/sqlite-notice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup.account");
  return { title: { absolute: t("metaTitle") } };
}

/** Public by necessity, so the stage is re-checked here; the proxy lets it through always. */
export default async function SetupPage() {
  const session = await auth();
  const { stage } = await getSetupState(!!session?.user);

  if (stage !== "account") {
    redirect(SETUP_PATHS[stage]);
  }

  // Otherwise a migration that left old accounts behind looks like it did nothing.
  return (
    <SetupAccountClient
      migratedFrom={await getMigrationSource()}
      hasMigrateStep={hasLegacyDatabase()}
      sqliteWarning={sqliteNoticeApplies()}
    />
  );
}
