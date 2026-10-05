import { localUsersDisabled } from "@/src/lib/auth/policy";
import { requireUser, getCurrentSessionId } from "@/src/lib/auth";
import {
  getPasswordSignInUsername,
  getUserById,
  getUserPasswordHash,
  listUserOAuthProviders,
} from "@/src/lib/models/user";
import { getProviderDisplayList } from "@/src/lib/models/oauth-providers";
import { ldapDirectoryNames } from "@/src/lib/models/ldap-directories";
import { listApiTokens } from "@/src/lib/models/api-tokens";
import { listUserSessions } from "@/src/lib/models/sessions";
import { resolveAvatar } from "@/src/lib/users/avatar";
import { isGravatarEnabled } from "@/src/lib/settings";
import ProfileClient from "./ProfileClient";
import { isDemoAdmin } from "@/src/lib/demo/mode";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { listUserPasskeys } from "@/src/lib/auth/passkeys";
import { passkeyRpId } from "@/src/lib/auth/passkeys/relying-party";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("profile") };
}

export default async function ProfilePage() {
  const session = await requireUser();
  const userId = Number(session.user.id);

  // Only administrators are notified, so only they have anything to choose. Started now, beside
  // the reads below, rather than after them.
  const notificationsView =
    session.user.role === "admin"
      ? import("@/src/lib/notifications/audience").then(({ notificationProfileView }) =>
          notificationProfileView({ id: userId, email: session.user.email }),
        )
      : Promise.resolve(null);
  // Awaited below; marked handled now so a failure while the rest load is not reported twice.
  notificationsView.catch(() => {});

  // Everything keys off the session's user id alone, so nothing has to wait for the user row.
  const [
    user,
    linkedProviders,
    enabledProviders,
    apiTokens,
    userSessions,
    currentSessionId,
    gravatarEnabled,
    passkeys,
    publicBaseUrl,
    directoryNames,
  ] = await Promise.all([
    getUserById(userId),
    // The accounts table is authoritative; users.provider/subject are a projection (#261).
    listUserOAuthProviders(userId),
    getProviderDisplayList(),
    listApiTokens(userId),
    listUserSessions(userId),
    getCurrentSessionId(),
    isGravatarEnabled(),
    listUserPasskeys(userId),
    getPublicBaseUrl(),
    ldapDirectoryNames(),
  ]);
  if (!user) {
    redirect("/login");
  }

  // Self-registered users keep the hash on the credential account only.
  const [passwordHash, signInUsername] = await Promise.all([
    getUserPasswordHash(user),
    getPasswordSignInUsername(userId),
  ]);
  // A directory account without a local password: the directory owns that password.
  const directoryLink = linkedProviders.find((link) => directoryNames.has(link.providerId));
  const managedByDirectory =
    !passwordHash && directoryLink ? (directoryNames.get(directoryLink.providerId) ?? null) : null;
  const sessions = userSessions.map((s) => ({ ...s, current: s.id === currentSessionId }));
  const notifications = await notificationsView;

  return (
    <ProfileClient
      user={{
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider,
        subject: user.subject,
        hasPassword: Boolean(passwordHash),
        signInUsername,
        twoFactorEnabled: user.twoFactorEnabled,
        role: user.role,
        avatarUrl: user.avatarUrl,
      }}
      linkedProviders={linkedProviders}
      enabledProviders={enabledProviders}
      directories={[...directoryNames].map(([id, name]) => ({ id, name }))}
      managedByDirectory={managedByDirectory}
      apiTokens={apiTokens}
      sessions={sessions}
      localPasswordsEnabled={!(await localUsersDisabled())}
      passkeys={passkeys}
      passkeyRpId={passkeyRpId(publicBaseUrl)}
      passwordLocked={isDemoAdmin(userId)}
      avatar={resolveAvatar(user, 160, { gravatar: gravatarEnabled })}
      notifications={notifications}
    />
  );
}
