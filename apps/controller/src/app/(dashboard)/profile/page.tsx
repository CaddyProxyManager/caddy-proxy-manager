import { localUsersDisabled } from "@/src/lib/auth-policy";
import { requireUser, getCurrentSessionId } from "@/src/lib/auth";
import { getUserById, listUserOAuthProviders } from "@/src/lib/models/user";
import { getProviderDisplayList } from "@/src/lib/models/oauth-providers";
import { listApiTokens } from "@/src/lib/models/api-tokens";
import { listUserSessions } from "@/src/lib/models/sessions";
import { resolveAvatar } from "@/src/lib/avatar";
import { isGravatarEnabled } from "@/src/lib/settings";
import ProfileClient from "./ProfileClient";
import { isDemoAdmin } from "@/src/lib/demo-mode";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("profile") };
}

export default async function ProfilePage() {
  const session = await requireUser();
  const userId = Number(session.user.id);

  // Everything keys off the session's user id alone, so nothing has to wait for the user row.
  const [
    user,
    linkedProviders,
    enabledProviders,
    apiTokens,
    userSessions,
    currentSessionId,
    gravatarEnabled,
  ] = await Promise.all([
    getUserById(userId),
    // The accounts table is authoritative; users.provider/subject are a projection (#261).
    listUserOAuthProviders(userId),
    getProviderDisplayList(),
    listApiTokens(userId),
    listUserSessions(userId),
    getCurrentSessionId(),
    isGravatarEnabled(),
  ]);
  if (!user) {
    redirect("/login");
  }

  const sessions = userSessions.map((s) => ({ ...s, current: s.id === currentSessionId }));

  return (
    <ProfileClient
      user={{
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider,
        subject: user.subject,
        hasPassword: Boolean(user.passwordHash),
        twoFactorEnabled: user.twoFactorEnabled,
        role: user.role,
        avatarUrl: user.avatarUrl,
      }}
      linkedProviders={linkedProviders}
      enabledProviders={enabledProviders}
      apiTokens={apiTokens}
      sessions={sessions}
      localPasswordsEnabled={!(await localUsersDisabled())}
      passwordLocked={isDemoAdmin(userId)}
      avatar={resolveAvatar(user, 160, { gravatar: gravatarEnabled })}
    />
  );
}
