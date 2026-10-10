import { getAppName } from "@/src/lib/branding/app-name";
import type { ReactNode } from "react";
import { can, currentAccess } from "@/src/lib/users/permissions";
import { isDemoMode } from "@/src/lib/demo/mode";
import { SQLITE_NOTICE_COOKIE, sqliteNoticeApplies } from "@/src/lib/db/sqlite-notice";
import { cookies } from "next/headers";
import { resolveAvatar } from "@/src/lib/users/avatar";
import { getWafSettings, isGravatarEnabled } from "@/src/lib/settings";
import { getTranslations } from "next-intl/server";
import { getModuleGateState } from "@/src/lib/caddy/image-build";
import { caddyModuleName } from "@/src/lib/caddy/image-build/module-messages";
import { getUpdateStatus } from "@/src/lib/runtime/updates";
import { ModuleGateProvider } from "@/components/caddy-modules/ModuleGate";
import { WafPolicyProvider } from "@/components/proxy-hosts/waf/waf-policy";
import { requiresLegacyPasswordChange } from "@/src/lib/services/legacy-password";
import { redirect } from "next/navigation";
import DashboardLayoutClient from "./DashboardLayoutClient";
import { inArray } from "drizzle-orm";
import db from "@/src/lib/db";
import { groups } from "@/src/lib/db/schema";
import { stagedView } from "@/src/lib/settings/staged-view";
import { getMoreDrawerPins } from "@/src/lib/models/nav-preferences";
import { getRole } from "@/src/lib/roles/store";
import { getTableDensity } from "@/src/lib/models/table-density";
import { TableDensityProvider } from "@/components/ui/TableDensity";
import { mfaStandingFor } from "@/src/lib/auth/two-factor/policy";
import { pendingReviewsFor } from "@/src/lib/access-reviews";
import { countAwaiting } from "@/src/lib/approvals";

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
  const { session, access } = await currentAccess();
  const userId = Number(session.user.id);
  // For the module names in the gate's tooltip.
  const t = await getTranslations();

  // Parallel: this runs on every dashboard navigation.
  const [
    mustChangePassword,
    gravatar,
    moduleGate,
    updates,
    staged,
    morePins,
    tableDensity,
    mfaStanding,
    pendingReviews,
    awaitingApprovals,
    globalWaf,
  ] = await Promise.all([
    requiresLegacyPasswordChange(userId),
    isGravatarEnabled(),
    // Once for the whole dashboard: every page needs the same answer, and it changes only when
    // an admin saves Settings > Caddy Build.
    getModuleGateState((module) => caddyModuleName(t, module)),
    // A cache read that refreshes in the background, never a network call on render.
    getUpdateStatus(),
    // Only whoever reaches Settings pays for this read; a settings page reuses it (requestMemo).
    can(access, "settings:read") ? stagedView(userId) : null,
    // Null means never chosen, which keeps the phone's More drawer offering to be customized.
    getMoreDrawerPins(userId),
    getTableDensity(userId),
    // Overdue is the proxy's to enforce; only the grace period's banner is decided here.
    mfaStandingFor(session).catch(() => ({ status: "exempt" }) as const),
    // A reviewer may hold no capability at all, so this banner is how they find their items.
    pendingReviewsFor(userId).catch(() => ({ count: 0, dueOn: null })),
    // An approver is named by the policy and may hold no capability; this is how they hear.
    countAwaiting({ access }).catch(() => 0),
    // A host's WAF editor marks a risky directive as the global setting says, from any page.
    getWafSettings(),
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
  const sqliteNotice = sqliteNoticeApplies() && !(await cookies()).get(SQLITE_NOTICE_COOKIE);
  return (
    <ModuleGateProvider value={moduleGate}>
      <WafPolicyProvider value={{ strictDirectives: globalWaf?.strict_directives === true }}>
        <TableDensityProvider initial={tableDensity}>
          <DashboardLayoutClient
            user={session.user}
            avatar={avatar}
            appName={await getAppName()}
            demoMode={isDemoMode()}
            sqliteNotice={sqliteNotice}
            updateAvailable={updates.updateAvailable}
            staged={staged}
            morePins={morePins}
            capabilities={access.capabilities}
            mfaDeadline={mfaStanding.status === "grace" ? mfaStanding.deadline : null}
            pendingReviews={pendingReviews.count > 0 ? pendingReviews : null}
            awaitingApprovals={awaitingApprovals}
            viewAs={
              session.viewAs
                ? {
                    role: session.viewAs.role,
                    roleName: (await getRole(session.viewAs.role))?.name ?? null,
                    groupNames: await groupNames(session.viewAs.groupIds),
                  }
                : null
            }
          >
            {children}
          </DashboardLayoutClient>
        </TableDensityProvider>
      </WafPolicyProvider>
    </ModuleGateProvider>
  );
}
