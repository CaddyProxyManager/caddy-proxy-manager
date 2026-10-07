import { can, requireCanAccess } from "@/src/lib/users/permissions";
import { localUsersDisabled } from "@/src/lib/auth/policy";
import UsersClient from "./UsersClient";
import { isDemoAdmin } from "@/src/lib/demo/mode";
import { lastSessionByUser, listUsers, usersWithPassword } from "@/src/lib/models/user";
import { listGroups } from "@/src/lib/models/groups";
import { listRoles } from "@/src/lib/roles/store";
import { resolveAvatar } from "@/src/lib/users/avatar";
import { isGravatarEnabled } from "@/src/lib/settings";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { emailReady } from "@/src/lib/email/config";
import { passkeyCountsByUser } from "@/src/lib/auth/passkeys";
import { disabledByFailedSignIns } from "@/src/lib/auth/account-failures";
import { type AccountSource, accountSourcesByUser } from "@/src/lib/users/account-source";
import { getTwoFactorPolicySettings } from "@/src/lib/settings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("users") };
}

export default async function UsersPage() {
  const { session, access } = await requireCanAccess("users:read");
  const [allUsers, gravatarEnabled, lastSessions, allGroups, withPassword, sources, policy, roles] =
    await Promise.all([
      listUsers(),
      isGravatarEnabled(),
      // Best-effort: a failure here must not take the page with it.
      lastSessionByUser().catch(() => new Map<number, string>()),
      listGroups().catch(() => []),
      usersWithPassword().catch(() => new Set<number>()),
      accountSourcesByUser().catch(() => new Map<number, AccountSource>()),
      getTwoFactorPolicySettings(),
      listRoles(),
    ]);
  const passkeyCounts = await passkeyCountsByUser(allUsers.map((user) => user.id)).catch(
    () => new Map<number, number>(),
  );
  const autoDisabled = await disabledByFailedSignIns(
    allUsers.filter((user) => user.status !== "active").map((user) => user.id),
  ).catch(() => new Set<number>());
  // Icons resolve here: Gravatar hashing needs node:crypto.
  const safeUsers = allUsers.map(({ passwordHash, ...rest }) => ({
    ...rest,
    avatar: resolveAvatar(rest, 72, { gravatar: gravatarEnabled }),
    lastSessionAt: lastSessions.get(rest.id) ?? null,
    hasPassword: passwordHash !== null || withPassword.has(rest.id),
    passkeyCount: passkeyCounts.get(rest.id) ?? 0,
    accountSource: sources.get(rest.id) ?? ("local" as const),
    disabledByFailedSignIns: autoDisabled.has(rest.id),
    isDemoAdmin: isDemoAdmin(rest.id),
    isSelf: rest.id === Number(session.user.id),
  }));
  const groups = allGroups.map((group) => ({
    id: group.id,
    name: group.name,
    source: group.source,
    memberIds: group.members.map((member) => member.userId),
  }));
  return (
    <UsersClient
      users={safeUsers}
      groups={groups}
      localUsersEnabled={!(await localUsersDisabled())}
      emailEnabled={await emailReady()}
      mfaPolicyMode={policy.mode}
      customRoles={roles.flatMap((role) => (role.name ? [{ key: role.key, name: role.name }] : []))}
      canSeeRoles={can(access, "roles:read")}
    />
  );
}
