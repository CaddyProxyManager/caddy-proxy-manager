import { requireCan } from "@/src/lib/users/permissions";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { stagedView } from "@/src/lib/settings/staged-view";
import { loadBackupOverviewAction } from "./actions";
import BackupClient from "./BackupClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("backup.title") };
}

export default async function SettingsBackupPage() {
  const session = await requireCan("backups:read");
  const [staged, overview] = await Promise.all([
    stagedView(Number(session.user.id)),
    loadBackupOverviewAction(),
  ]);
  return <BackupClient staged={staged} overview={overview} />;
}
