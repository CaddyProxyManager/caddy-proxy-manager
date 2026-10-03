import { localUsersDisabled } from "@/src/lib/auth-policy";
import UsersClient from "./UsersClient";
import { isDemoAdmin } from "@/src/lib/demo-mode";
import { lastSessionByUser, listUsers, usersWithPassword } from "@/src/lib/models/user";
import { listGroups } from "@/src/lib/models/groups";
import { requireAdmin } from "@/src/lib/auth";
import { resolveAvatar } from "@/src/lib/avatar";
import { isGravatarEnabled } from "@/src/lib/settings";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { emailReady } from "@/src/lib/email/config";
import { passkeyCountsByUser } from "@/src/lib/passkeys";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("users") };
}

export default async function UsersPage() {
  const session = await requireAdmin();
  const [allUsers, gravatarEnabled, lastSessions, allGroups, withPassword] = await Promise.all([
    listUsers(),
    isGravatarEnabled(),
    // Best-effort: a failure here must not take the page with it.
    lastSessionByUser().catch(() => new Map<number, string>()),
    listGroups().catch(() => []),
    usersWithPassword().catch(() => new Set<number>()),
  ]);
  const passkeyCounts = await passkeyCountsByUser(allUsers.map((user) => user.id)).catch(
    () => new Map<number, number>(),
  );
  // Icons resolve here: Gravatar hashing needs node:crypto.
  const safeUsers = allUsers.map(({ passwordHash, ...rest }) => ({
    ...rest,
    avatar: resolveAvatar(rest, 72, { gravatar: gravatarEnabled }),
    lastSessionAt: lastSessions.get(rest.id) ?? null,
    hasPassword: passwordHash !== null || withPassword.has(rest.id),
    passkeyCount: passkeyCounts.get(rest.id) ?? 0,
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
    />
  );
}
