import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { requireAdmin } from "@/src/lib/auth";
import { stagedView } from "@/src/lib/settings/staged-view";
import BackupClient from "./BackupClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings");
  return { title: t("backup.title") };
}

export default async function SettingsBackupPage() {
  const session = await requireAdmin();
  return <BackupClient staged={await stagedView(Number(session.user.id))} />;
}
