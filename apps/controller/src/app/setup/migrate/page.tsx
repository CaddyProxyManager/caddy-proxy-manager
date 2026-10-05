import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { auth } from "@/src/lib/auth";
import { scanForLegacyDatabases } from "@/src/lib/migration/legacy-database";
import { probeLegacySecrets } from "@/src/lib/migration/legacy-secrets";
import { getSetupState, SETUP_PATHS } from "@/src/lib/setup";
import SetupMigrateClient from "./SetupMigrateClient";
import { sqliteNoticeApplies } from "@/src/lib/db/sqlite-notice";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("setup.migrate");
  return { title: { absolute: t("heading") } };
}

export default async function SetupMigratePage() {
  const session = await auth();
  const { stage } = await getSetupState(!!session?.user);
  if (stage !== "migrate") {
    redirect(SETUP_PATHS[stage]);
  }

  const { candidates, rejected } = scanForLegacyDatabases();

  return (
    <SetupMigrateClient
      sqliteWarning={sqliteNoticeApplies()}
      candidates={candidates.map((candidate) => {
        // Asked per candidate rather than once for the selection, because the answer belongs to the
        // file: two databases on the same host can have been written under different secrets, and
        // the field has to appear or disappear as the operator picks between them.
        const probe = probeLegacySecrets(candidate.path);
        return {
          path: candidate.path,
          sizeBytes: candidate.sizeBytes,
          users: candidate.counts.users,
          proxyHosts: candidate.counts.proxyHosts,
          certificates: candidate.counts.certificates,
          groupCounts: candidate.groupCounts,
          lastUpdatedAt: candidate.lastUpdatedAt,
          // Only the verdict crosses to the browser. The samples stay here: they are ciphertext,
          // and shipping them would hand anyone who can reach an unconfigured instance something
          // to attack the old secret offline with.
          needsLegacyKey: probe.hasEncryptedValues && !probe.readableWithCurrentKey,
        };
      })}
      rejected={rejected}
    />
  );
}
