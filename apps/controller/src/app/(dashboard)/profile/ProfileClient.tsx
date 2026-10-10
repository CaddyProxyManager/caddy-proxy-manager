"use client";

import { type ReactNode, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_NEW_PASSWORD,
} from "@/components/ui/native-input-attrs";
import { UserAvatar } from "@/src/components/UserAvatar";
import type { ResolvedAvatar } from "@/src/lib/users/avatar";
import { MAX_AVATAR_FILE_KB } from "@/src/lib/users/avatar-limits";
import { authClient } from "@/src/lib/auth/client";
import {
  Bell,
  KeyRound,
  Link,
  Lock,
  LogIn,
  LogOut,
  Monitor,
  ShieldCheck,
  Trash2,
  Unlink,
  User,
} from "lucide-react";
import { TwoFactorSection } from "./TwoFactorSection";
import { ProfileSection } from "./ProfileSection";
import { ApiTokensSection } from "./ApiTokensSection";
import { DisplaySection } from "./DisplaySection";
import type { DisplayPreferences } from "@/src/lib/users/display-preferences";
import type { ApproximatePlace } from "@/src/lib/geoip/lookup";
import { regionName } from "@/src/lib/locale/region-names";
import { FlagIcon } from "@/src/components/ui/CountryFlag";
import { PasskeySection } from "./PasskeySection";
import { type DeviceWords, describeDevice } from "./device";
import { NotificationsSection, type NotificationsSectionProps } from "./NotificationsSection";
import type { PasskeySummary } from "@/src/lib/auth/passkeys";
import type { ApiToken } from "@/lib/models/api-tokens";
import { revokeSessionAction, revokeOtherSessionsAction } from "./session-actions";
import { passwordPolicyHint, passwordPolicyMessage } from "@/src/lib/auth/password/policy-message";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { TIMESTAMP_STYLES, UtcTooltip } from "@/components/ui/Timestamp";
import { GeneratedPasswordField } from "@/src/components/ui/GeneratedPasswordField";

interface ActiveSession {
  id: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
  /** From GeoIP, when the database is present. */
  place: ApproximatePlace | null;
}

interface UserData {
  id: number;
  email: string;
  name: string | null;
  provider: string | null;
  subject: string | null;
  /** Never the hash itself - this crosses to the browser. */
  hasPassword: boolean;
  /** What the login page signs them in with; null when it cannot without OAuth. */
  signInUsername: string | null;
  twoFactorEnabled: boolean;
  role: string;
  avatarUrl: string | null;
}

interface ProfileClientProps {
  user: UserData;
  /** From the authoritative accounts table (#261). */
  linkedProviders: Array<{ providerId: string; accountId: string }>;
  enabledProviders: Array<{
    id: string;
    name: string;
    autoLink: boolean;
    protocol?: "oidc" | "saml";
  }>;
  apiTokens: ApiToken[];
  sessions: ActiveSession[];
  /** False in OIDC-only mode: local passwords do not exist. */
  localPasswordsEnabled?: boolean;
  /** The shared demo account, whose password every visitor signs in with. */
  passwordLocked?: boolean;
  /** Resolved on the server, including the Gravatar fallback. */
  avatar: ResolvedAvatar;
  passkeys?: PasskeySummary[];
  /** The Public URL's hostname; null when it does not parse. */
  passkeyRpId?: string | null;
  /** Every LDAP directory, for naming an account linked to one. */
  directories?: Array<{ id: string; name: string }>;
  /** The directory whose password this account signs in with, when it has none of its own. */
  managedByDirectory?: string | null;
  /** An administrator's notification choices; null for everyone else, who is never notified. */
  notifications?: NotificationsSectionProps | null;
  displayPreferences: DisplayPreferences;
}

export default function ProfileClient({
  user,
  linkedProviders,
  enabledProviders,
  apiTokens,
  sessions,
  localPasswordsEnabled = true,
  passwordLocked = false,
  avatar,
  passkeys = [],
  passkeyRpId = null,
  directories = [],
  managedByDirectory = null,
  notifications = null,
  displayPreferences,
}: ProfileClientProps) {
  const t = useTranslations("profile");
  const tUsers = useTranslations("users");
  const tCommon = useTranslations("common");
  const tAuth = useTranslations("auth");
  // Unscoped as well, for the password rule - it is shared with every other password field.
  const tRoot = useTranslations();
  // `now` is passed explicitly, or next-intl reports an environment fallback on every call.
  const format = useFormatter();
  const now = useNow();
  const locale = useLocale();
  const deviceWords: DeviceWords = {
    unknown: t("deviceUnknown"),
    browser: t("deviceBrowser"),
    onOs: (browser, os) => t("deviceOnOs", { browser, os }),
  };
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [unlinkDialogOpen, setUnlinkDialogOpen] = useState(false);
  const [removePasswordDialogOpen, setRemovePasswordDialogOpen] = useState(false);
  const [removePasswordCurrent, setRemovePasswordCurrent] = useState("");
  const [unlinkCurrentPassword, setUnlinkCurrentPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(user.avatarUrl);

  const getProviderName = (provider: string) => {
    if (provider === "credentials") return t("providerCredentials");
    if (provider === "oauth2") return "OAuth2";
    if (provider === "authentik") return "Authentik";
    return directories.find((d) => d.id === provider)?.name ?? provider;
  };

  const hasPassword = user.hasPassword;
  // From accounts rows, not the stale-prone users.provider projection (#261).
  const linkedNames = linkedProviders.map(
    (link) =>
      enabledProviders.find((p) => p.id === link.providerId)?.name ??
      getProviderName(link.providerId),
  );
  const hasOAuth = linkedNames.length > 0;
  // What is left once the password goes: the remove-password route refuses when it is nothing.
  const otherSignInMethods =
    passkeys.length > 0 ? [...linkedNames, t("passkeys.signInMethod")] : linkedNames;

  const handlePasswordChange = async () => {
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError(tCommon("passwordsDoNotMatch"));
      return;
    }

    const policyError = passwordPolicyMessage(
      tRoot,
      newPassword,
      tRoot("passwordPolicy.subject.password"),
    );
    if (policyError) {
      setError(policyError);
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || tAuth("passwordChange.failed"));
        setLoading(false);
        return;
      }

      setSuccess(t("passwordChanged"));
      setPasswordDialogOpen(false);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setLoading(false);
    } catch {
      setError(t("passwordChangeError"));
      setLoading(false);
    }
  };

  const handleUnlinkOAuth = async () => {
    if (!hasPassword) {
      setError(t("unlinkPasswordRequired"));
      return;
    }

    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      const response = await fetch("/api/user/unlink-oauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: unlinkCurrentPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t("unlinkFailed"));
        setLoading(false);
        return;
      }

      setSuccess(t("oauthUnlinked"));
      setUnlinkDialogOpen(false);
      setUnlinkCurrentPassword("");
      setLoading(false);

      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setError(t("unlinkError"));
      setLoading(false);
    }
  };

  const handleRemovePassword = async () => {
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      const response = await fetch("/api/user/remove-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: removePasswordCurrent }),
      });
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t("removePasswordFailed"));
        setLoading(false);
        return;
      }

      setSuccess(t("passwordRemoved"));
      setRemovePasswordDialogOpen(false);
      setRemovePasswordCurrent("");
      setLoading(false);
      setTimeout(() => window.location.reload(), 1500);
    } catch {
      setError(t("removePasswordFailed"));
      setLoading(false);
    }
  };

  const handleLinkOAuth = async (providerId: string) => {
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      // linkSocial, not signIn.social, so an unrelated IdP account cannot swap the session user.
      const { error: linkError } = await authClient.linkSocial({
        provider: providerId,
        callbackURL: "/profile",
      });

      if (linkError) {
        setError(linkError.message || t("linkStartFailed"));
        setLoading(false);
      }
      // On success the client follows the provider redirect.
    } catch {
      setError(t("linkError"));
      setLoading(false);
    }
  };

  const handleAvatarUpload = async (selected: File | File[] | null) => {
    const file = Array.isArray(selected) ? selected[0] : selected;
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError(t("avatarMustBeImage"));
      return;
    }

    if (file.size > MAX_AVATAR_FILE_KB * 1024) {
      setError(t("avatarTooLarge", { max: MAX_AVATAR_FILE_KB }));
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result as string;

        const response = await fetch("/api/user/update-avatar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ avatarUrl: base64 }),
        });

        const data = await response.json();

        if (!response.ok) {
          setError(data.error || t("avatarUploadFailed"));
          setLoading(false);
          return;
        }

        setAvatarUrl(base64);
        setSuccess(t("avatarUpdated"));
        setLoading(false);

        setTimeout(() => window.location.reload(), 1000);
      };

      reader.readAsDataURL(file);
    } catch {
      setError(t("avatarUploadError"));
      setLoading(false);
    }
  };

  const handleAvatarDelete = async () => {
    setError(null);
    setLoading(true);

    try {
      const response = await fetch("/api/user/update-avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: null }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t("avatarDeleteFailed"));
        setLoading(false);
        return;
      }

      setAvatarUrl(null);
      setSuccess(t("avatarRemoved"));
      setLoading(false);

      setTimeout(() => window.location.reload(), 1000);
    } catch {
      setError(t("avatarDeleteError"));
      setLoading(false);
    }
  };

  const placeLine = (place: ApproximatePlace) => {
    const country = place.countryCode ? regionName(place.countryCode, locale) : null;
    return place.city && country
      ? t("sessionPlaceCity", { city: place.city, country })
      : t("sessionPlace", { place: place.city ?? country ?? "" });
  };

  const formatDate = (iso: string | null): string => {
    if (!iso) return tCommon("never");
    return format.dateTime(new Date(iso), TIMESTAMP_STYLES.dateTimeShort);
  };

  /** A line stating a time gets the UTC instant as its tooltip; "never" has none to give. */
  const withUtc = (iso: string | null, line: ReactNode) =>
    iso ? <UtcTooltip value={iso}>{line}</UtcTooltip> : line;

  return (
    <VStack gap={6}>
      <Heading level={1}>{t("title")}</Heading>

      {error && (
        <Banner
          status="error"
          title={tCommon("somethingWentWrong")}
          description={error}
          isDismissable
          onDismiss={() => setError(null)}
        />
      )}

      {success && (
        <Banner status="success" title={success} isDismissable onDismiss={() => setSuccess(null)} />
      )}

      <VStack gap={4}>
        <ProfileSection icon={User} title={t("accountInformation")}>
          <VStack gap={4}>
            <VStack gap={2}>
              <Text type="body" size="sm" color="secondary">
                {t("profilePicture")}
              </Text>
              <HStack gap={4} vAlign="center">
                <UserAvatar
                  // Local state, so an upload or removal shows immediately.
                  avatar={{ ...avatar, imageUrl: avatarUrl }}
                  alt={user.name || user.email}
                  size="xl"
                />
                <HStack gap={2} vAlign="center">
                  <FileInput
                    label={t("uploadProfilePicture")}
                    isLabelHidden
                    accept="image/*"
                    value={null}
                    onChange={handleAvatarUpload}
                    isDisabled={loading}
                    description={t("avatarUploadHelp", { max: MAX_AVATAR_FILE_KB })}
                  />
                  {avatarUrl && (
                    <IconButton
                      variant="ghost"
                      label={t("removeProfilePicture")}
                      tooltip={t("removePicture")}
                      icon={<Trash2 />}
                      isDisabled={loading}
                      onClick={handleAvatarDelete}
                    />
                  )}
                </HStack>
              </HStack>
            </VStack>

            <Divider />

            <MetadataList>
              <MetadataListItem label={tCommon("email")}>{user.email}</MetadataListItem>
              <MetadataListItem label={tCommon("name")}>
                {user.name || t("notSet")}
              </MetadataListItem>
              {user.signInUsername && (
                <MetadataListItem label={tUsers("signInUsername")}>
                  {user.signInUsername}
                </MetadataListItem>
              )}
              <MetadataListItem label={tCommon("role")}>
                <Badge label={user.role} />
              </MetadataListItem>
              <MetadataListItem label={t("authenticationMethod")}>
                <Badge
                  variant={user.provider === "credentials" ? "neutral" : "info"}
                  label={getProviderName(user.provider ?? "")}
                />
              </MetadataListItem>
              {hasPassword && (
                <MetadataListItem label={tCommon("password")}>
                  <Badge variant="success" label={t("passwordIsSet")} />
                </MetadataListItem>
              )}
            </MetadataList>
          </VStack>
        </ProfileSection>

        <DisplaySection preferences={displayPreferences} onError={setError} />

        {notifications && (
          <ProfileSection icon={Bell} title={t("notifications.title")}>
            <NotificationsSection {...notifications} />
          </ProfileSection>
        )}

        {localPasswordsEnabled && (
          <ProfileSection icon={Lock} title={t("passwordManagement")}>
            {passwordLocked ? (
              <Text type="body" size="sm" color="secondary">
                {t("demoPasswordLocked")}
              </Text>
            ) : managedByDirectory ? (
              // No local password for a directory account: it would outlive the directory's.
              <Text type="body" size="sm" color="secondary">
                {t("passwordManagedBy", { directory: managedByDirectory })}
              </Text>
            ) : hasPassword ? (
              <VStack gap={2}>
                <Text type="body" size="sm" color="secondary">
                  {t("passwordManagementDescription")}
                </Text>
                <HStack gap={2} wrap="wrap">
                  <Button
                    variant="secondary"
                    label={tCommon("change")}
                    onClick={() => setPasswordDialogOpen(true)}
                  />
                  {/* With a provider it sits beside the link, under single sign-on instead. */}
                  {!hasOAuth && passkeys.length > 0 && (
                    <Button
                      variant="secondary"
                      icon={<Lock />}
                      label={t("removePassword")}
                      onClick={() => setRemovePasswordDialogOpen(true)}
                    />
                  )}
                </HStack>
              </VStack>
            ) : (
              <VStack gap={3}>
                <Banner
                  status="warning"
                  title={t("oauthOnlyTitle")}
                  description={t("oauthPasswordDescription")}
                />
                <HStack>
                  <Button
                    label={tCommon("setPassword")}
                    onClick={() => setPasswordDialogOpen(true)}
                  />
                </HStack>
              </VStack>
            )}
          </ProfileSection>
        )}

        {localPasswordsEnabled && (
          <ProfileSection id="two-factor" icon={ShieldCheck} title={tCommon("twoFactorSignIn")}>
            <TwoFactorSection
              enabled={user.twoFactorEnabled}
              hasPassword={hasPassword}
              locked={passwordLocked}
            />
          </ProfileSection>
        )}

        {localPasswordsEnabled && (
          <ProfileSection icon={KeyRound} title={t("passkeys.title")}>
            <PasskeySection passkeys={passkeys} rpId={passkeyRpId} locked={passwordLocked} />
          </ProfileSection>
        )}

        <ProfileSection
          icon={Monitor}
          title={t("activeSessions")}
          action={
            sessions.some((s) => !s.current) ? (
              <form action={revokeOtherSessionsAction}>
                <Button
                  type="submit"
                  variant="destructive"
                  size="sm"
                  icon={<LogOut />}
                  label={t("revokeOtherSessionsLabel")}
                />
              </form>
            ) : undefined
          }
        >
          <VStack gap={4}>
            <Text type="body" size="sm" color="secondary">
              {t("sessionsDescription")}
            </Text>

            <List hasDividers>
              {sessions.map((s) => (
                <ListItem
                  key={s.id}
                  startContent={<Icon icon={Monitor} size="sm" color="secondary" />}
                  label={describeDevice(s.userAgent, deviceWords)}
                  description={
                    <HStack gap={3} wrap="wrap" vAlign="center">
                      {withUtc(
                        s.createdAt,
                        <Text type="body" size="sm" color="secondary">
                          {t("signedIn", {
                            when: format.relativeTime(new Date(s.createdAt), now),
                          })}
                        </Text>,
                      )}
                      {s.ipAddress && (
                        <Text type="body" size="sm" color="secondary">
                          {t("ipAddress", { address: s.ipAddress })}
                        </Text>
                      )}
                      {s.place && (
                        <HStack gap={2} vAlign="center">
                          {s.place.countryCode && <FlagIcon code={s.place.countryCode} />}
                          <Text type="body" size="sm" color="secondary">
                            {placeLine(s.place)}
                          </Text>
                        </HStack>
                      )}
                      {withUtc(
                        s.expiresAt,
                        <Text type="body" size="sm" color="secondary">
                          {tCommon("expiresOn", { date: formatDate(s.expiresAt) })}
                        </Text>,
                      )}
                    </HStack>
                  }
                  endContent={
                    s.current ? (
                      <Badge variant="success" label={t("thisDevice")} />
                    ) : (
                      <form action={revokeSessionAction.bind(null, s.id)}>
                        <IconButton
                          type="submit"
                          variant="ghost"
                          size="sm"
                          label={t("revokeSessionOn", {
                            device: describeDevice(s.userAgent, deviceWords),
                          })}
                          tooltip={t("revokeSession")}
                          icon={<Trash2 />}
                        />
                      </form>
                    )
                  }
                />
              ))}
            </List>
          </VStack>
        </ProfileSection>

        {enabledProviders.length > 0 && (
          <ProfileSection icon={Link} title={t("oauthConnections")}>
            {hasOAuth ? (
              <VStack gap={2}>
                <Text type="body" size="sm" color="secondary">
                  {t("linkedTo", {
                    count: linkedNames.length,
                    providers: linkedNames.join(", "),
                  })}
                </Text>

                {!localPasswordsEnabled ? (
                  <Banner
                    status="info"
                    title={t("unlinkDisabledTitle")}
                    description={t("oauthOnlyDescription")}
                  />
                ) : hasPassword ? (
                  <VStack gap={2}>
                    {!user.signInUsername && (
                      <Banner
                        status="info"
                        title={t("unlinkDisabledTitle")}
                        description={t("unlinkSignInUnavailable")}
                      />
                    )}
                    <HStack gap={2} wrap="wrap">
                      {user.signInUsername && (
                        <Button
                          variant="secondary"
                          icon={<Unlink />}
                          label={t("unlink")}
                          onClick={() => setUnlinkDialogOpen(true)}
                        />
                      )}
                      {/* The other way to end up with one sign-in method: keep the provider, drop
                          the password. */}
                      <Button
                        variant="secondary"
                        icon={<Lock />}
                        label={t("removePassword")}
                        onClick={() => setRemovePasswordDialogOpen(true)}
                      />
                    </HStack>
                  </VStack>
                ) : (
                  <Banner
                    status="info"
                    title={t("unlinkPasswordRequiredTitle")}
                    description={t("unlinkPasswordRequiredDescription")}
                  />
                )}
              </VStack>
            ) : (
              <VStack gap={3}>
                <Text type="body" size="sm" color="secondary">
                  {t("oauthLinkDescription")}
                </Text>
                <VStack gap={2}>
                  {/* SAML has no link-from-a-session step; its account links by email domain. */}
                  {enabledProviders
                    .filter((provider) => provider.protocol !== "saml")
                    .map((provider) => (
                      <Button
                        key={provider.id}
                        variant="secondary"
                        width="100%"
                        icon={<LogIn />}
                        label={t("linkProvider", { provider: provider.name })}
                        onClick={() => handleLinkOAuth(provider.id)}
                      />
                    ))}
                </VStack>
              </VStack>
            )}
          </ProfileSection>
        )}

        <ApiTokensSection
          tokens={apiTokens}
          formatDate={formatDate}
          withUtc={withUtc}
          onError={setError}
          onCreated={() => setSuccess(t("apiTokenCreated"))}
        />
      </VStack>

      <AppDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
        title={hasPassword ? t("changePassword") : tCommon("setPassword")}
        maxWidth="sm"
        submitLabel={hasPassword ? tCommon("change") : tCommon("setPassword")}
        onSubmit={handlePasswordChange}
        isSubmitting={loading}
      >
        <VStack gap={3}>
          {hasPassword && (
            <TextInput
              startIcon={KeyRound}
              {...AUTOFILL_CURRENT_PASSWORD}
              label={tCommon("currentPassword")}
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
            />
          )}
          <GeneratedPasswordField
            label={tCommon("newPassword")}
            value={newPassword}
            onChange={setNewPassword}
            // Fill the confirmation too: nobody can retype a generated value from memory.
            onGenerate={(generated) => {
              setNewPassword(generated);
              setConfirmPassword(generated);
            }}
            description={passwordPolicyHint(tRoot)}
          />
          <TextInput
            startIcon={KeyRound}
            {...AUTOFILL_NEW_PASSWORD}
            label={tCommon("confirmNewPassword")}
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
          />
        </VStack>
      </AppDialog>

      <AppDialog
        open={unlinkDialogOpen}
        onClose={() => {
          setUnlinkDialogOpen(false);
          setUnlinkCurrentPassword("");
        }}
        title={t("unlinkOauthAccount")}
        maxWidth="sm"
        submitLabel={t("unlink")}
        onSubmit={handleUnlinkOAuth}
        isSubmitting={loading}
      >
        <VStack gap={3}>
          <Text type="body" size="sm" color="secondary">
            {t("unlinkOauthConfirm", { providers: linkedNames.join(", ") })}
          </Text>
          <TextInput
            startIcon={KeyRound}
            {...AUTOFILL_CURRENT_PASSWORD}
            label={tCommon("currentPassword")}
            type="password"
            value={unlinkCurrentPassword}
            onChange={setUnlinkCurrentPassword}
            isRequired
          />
        </VStack>
      </AppDialog>

      <AppDialog
        open={removePasswordDialogOpen}
        onClose={() => {
          setRemovePasswordDialogOpen(false);
          setRemovePasswordCurrent("");
        }}
        title={t("removePassword")}
        maxWidth="sm"
        submitLabel={tCommon("remove")}
        onSubmit={handleRemovePassword}
        isSubmitting={loading}
      >
        <VStack gap={3}>
          <Text type="body" size="sm" color="secondary">
            {t("removePasswordDescription", { providers: otherSignInMethods.join(", ") })}
          </Text>
          <TextInput
            startIcon={KeyRound}
            {...AUTOFILL_CURRENT_PASSWORD}
            label={tCommon("currentPassword")}
            type="password"
            value={removePasswordCurrent}
            onChange={setRemovePasswordCurrent}
            isRequired
          />
        </VStack>
      </AppDialog>
    </VStack>
  );
}
