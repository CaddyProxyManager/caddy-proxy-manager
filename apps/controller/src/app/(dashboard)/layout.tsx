import { getAppName } from "@/src/lib/app-name";
import type { ReactNode } from "react";
import { requireUser } from "@/src/lib/auth";
import { isDemoMode } from "@/src/lib/demo-mode";
import { SQLITE_NOTICE_COOKIE, sqliteNoticeApplies } from "@/src/lib/sqlite-notice";
import { cookies } from "next/headers";
import { resolveAvatar } from "@/src/lib/avatar";
import { isGravatarEnabled } from "@/src/lib/settings";
import { getTranslations } from "next-intl/server";
import { getModuleGateState } from "@/src/lib/caddy-build";
import { caddyModuleName } from "@/src/lib/caddy-module-messages";
import { getUpdateStatus } from "@/src/lib/updates";
import { ModuleGateProvider } from "@/components/caddy-modules/ModuleGate";
import { requiresLegacyPasswordChange } from "@/src/lib/services/legacy-password";
import { redirect } from "next/navigation";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { inArray } from "drizzle-orm";
import db from "@/src/lib/db";
import { groups } from "@/src/lib/db/schema";
import { stagedKeys } from "@/src/lib/settings/staged-view";
import { getMoreDrawerPins } from "@/src/lib/models/nav-preferences";
import { getTableDensity } from "@/src/lib/models/table-density";
import { TableDensityProvider } from "@/components/ui/TableDensity";

/** Names for the banner, in the order the ids were chosen. */
async function groupNames(ids: number[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(inArray(groups.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row.name]));
  return ids.map((id) => byId.get(id)).filter((name): name is string => Boolean(name));
}

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireUser();
  const userId = Number(session.user.id);
  // For the module names in the gate's tooltip.
  const t = await getTranslations();

  // Parallel: this runs on every dashboard navigation.
  const [mustChangePassword, gravatar, moduleGate, updates, stagedSet, morePins, tableDensity] =
    await Promise.all([
      requiresLegacyPasswordChange(userId),
      isGravatarEnabled(),
      // Once for the whole dashboard: every page needs the same answer, and it changes only when
      // an admin saves Settings > Caddy Build.
      getModuleGateState((module) => caddyModuleName(t, module)),
      // A cache read that refreshes in the background, never a network call on render.
      getUpdateStatus(),
      // Only admins reach Settings, so nobody else pays for this read.
      session.user.role === "admin" ? stagedKeys(userId) : null,
      // Null means never chosen, which keeps the phone's More drawer offering to be customized.
      getMoreDrawerPins(userId),
      getTableDensity(userId),
    ]);

  // Here, not per page: a bcrypt-hash user must reach the reset screen from any URL. The reset
  // page is outside this layout, so this cannot loop.
  if (mustChangePassword) {
    redirect("/password-change");
  }

  const avatar = resolveAvatar(
    { name: session.user.name, email: session.user.email, avatarUrl: session.user.image },
    64,
    { gravatar },
  );
  const staged = stagedSet ? [...stagedSet] : [];
  const sqliteNotice = sqliteNoticeApplies() && !(await cookies()).get(SQLITE_NOTICE_COOKIE);
  return (
    <ModuleGateProvider value={moduleGate}>
      <TableDensityProvider initial={tableDensity}>
        <DashboardLayoutClient
          user={session.user}
          avatar={avatar}
          appName={await getAppName()}
          demoMode={isDemoMode()}
          sqliteNotice={sqliteNotice}
          updateAvailable={updates.updateAvailable}
          stagedKeys={staged}
          morePins={morePins}
          viewAs={
            session.viewAs
              ? { role: session.viewAs.role, groupNames: await groupNames(session.viewAs.groupIds) }
              : null
          }
        >
          {children}
        </DashboardLayoutClient>
      </TableDensityProvider>
    </ModuleGateProvider>
  );
}
