"use client";

import { type ReactNode, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { DateTimeInput, type ISODateTimeString } from "@astryxdesign/core/DateTimeInput";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import {
  AUTOFILL_CURRENT_PASSWORD,
  AUTOFILL_NEW_PASSWORD,
} from "@/components/ui/native-input-attrs";
import { UserAvatar } from "@/src/components/UserAvatar";
import type { ResolvedAvatar } from "@/src/lib/avatar";
import { MAX_AVATAR_FILE_KB } from "@/src/lib/avatar-limits";
import { authClient } from "@/src/lib/auth-client";
import {
  Key,
  Link,
  LogIn,
  Lock,
  LogOut,
  Monitor,
  Plus,
  Rows3,
  ShieldCheck,
  Trash2,
  Unlink,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { TwoFactorSection } from "./TwoFactorSection";
import type { ApiToken } from "@/lib/models/api-tokens";
import { createApiTokenAction, deleteApiTokenAction } from "../api-tokens/actions";
import { revokeSessionAction, revokeOtherSessionsAction } from "./session-actions";
import { saveTableDensityAction } from "./display-actions";
import { useSetTableDensity, useTableDensity } from "@/components/ui/TableDensity";
import { isTableDensity, TABLE_DENSITIES } from "@/src/lib/table-density";
import { passwordPolicyHint, passwordPolicyMessage } from "@/src/lib/password-policy-message";
import { useFormatter, useNow, useTranslations } from "next-intl";
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
}

type DeviceWords = {
  unknown: string;
  browser: string;
  onOs: (browser: string, os: string) => string;
};

/** Only the prose words are passed in; browser and OS names are the same in every language. */
function describeDevice(ua: string | null, words: DeviceWords): string {
  if (!ua) return words.unknown;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : words.browser;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /iPhone|iPad|iOS/.test(ua)
          ? "iOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? words.onOs(browser, os) : browser;
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
  enabledProviders: Array<{ id: string; name: string; autoLink: boolean }>;
  apiTokens: ApiToken[];
  sessions: ActiveSession[];
  /** False in OIDC-only mode: local passwords do not exist. */
  localPasswordsEnabled?: boolean;
  /** The shared demo account, whose password every visitor signs in with. */
  passwordLocked?: boolean;
  /** Resolved on the server, including the Gravatar fallback. */
  avatar: ResolvedAvatar;
}

function ProfileSection({
  icon,
  title,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card padding={6}>
      <VStack gap={4}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <HStack gap={2} vAlign="center">
            <Icon icon={icon} color="accent" />
            <Heading level={2}>{title}</Heading>
          </HStack>
          {action}
        </HStack>
        <Divider />
        {children}
      </VStack>
    </Card>
  );
}

/** Table density, applied optimistically; a refused save restores the old one. */
function DisplaySection({ onError }: { onError: (message: string) => void }) {
  const t = useTranslations("profile");
  const density = useTableDensity();
  const setDensity = useSetTableDensity();
  const [saving, setSaving] = useState(false);

  const choose = async (next: string) => {
    if (!isTableDensity(next) || next === density) return;
    const previous = density;
    setDensity(next);
    setSaving(true);
    try {
      const result = await saveTableDensityAction(next);
      if (!result.ok) {
        setDensity(previous);
        onError(result.error);
      }
    } catch {
      setDensity(previous);
      onError(t("tableDensitySaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProfileSection icon={Rows3} title={t("display")}>
      <VStack gap={2}>
        <SegmentedControl
          label={t("tableDensity")}
          value={density}
          onChange={choose}
          isDisabled={saving}
        >
          {TABLE_DENSITIES.map((option) => (
            <SegmentedControlItem
              key={option}
              value={option}
              label={t(`tableDensityOptions.${option}`)}
            />
          ))}
        </SegmentedControl>
        <Text type="body" size="sm" color="secondary">
          {t("tableDensityHelp")}
        </Text>
      </VStack>
    </ProfileSection>
  );
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
}: ProfileClientProps) {
  const t = useTranslations("profile");
  // Unscoped as well, for the password rule - it is shared with every other password field.
  const tRoot = useTranslations();
  // `now` is passed explicitly, or next-intl reports an environment fallback on every call.
  const format = useFormatter();
  const now = useNow();
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
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [tokenExpiresAt, setTokenExpiresAt] = useState<ISODateTimeString | undefined>(undefined);

  const getProviderName = (provider: string) => {
    if (provider === "credentials") return t("providerCredentials");
    if (provider === "oauth2") return "OAuth2";
    if (provider === "authentik") return "Authentik";
    return provider;
  };

  const hasPassword = user.hasPassword;
  // From accounts rows, not the stale-prone users.provider projection (#261).
  const linkedNames = linkedProviders.map(
    (link) =>
      enabledProviders.find((p) => p.id === link.providerId)?.name ??
      getProviderName(link.providerId),
  );
  const hasOAuth = linkedNames.length > 0;

  const handlePasswordChange = async () => {
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError(t("passwordsDoNotMatch"));
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
        setError(data.error || t("passwordChangeFailed"));
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

  const handleCreateToken = async (formData: FormData) => {
    setError(null);
    setNewToken(null);
    const result = await createApiTokenAction(formData);
    if ("error" in result) {
      setError(result.error);
    } else {
      setNewToken(result.rawToken);
      setSuccess(t("apiTokenCreated"));
      setTokenName("");
      setTokenExpiresAt(undefined);
    }
  };

  const formatDate = (iso: string | null): string => {
    if (!iso) return t("never");
    return format.dateTime(new Date(iso), TIMESTAMP_STYLES.dateTimeShort);
  };

  /** A line stating a time gets the UTC instant as its tooltip; "never" has none to give. */
  const withUtc = (iso: string | null, line: ReactNode) =>
    iso ? <UtcTooltip value={iso}>{line}</UtcTooltip> : line;

  const isExpired = (expiresAt: string | null): boolean => {
    if (!expiresAt) return false;
    return new Date(expiresAt) <= new Date();
  };

  return (
    <VStack gap={6}>
      <Heading level={1}>{t("title")}</Heading>

      {error && (
        <Banner
          status="error"
          title={t("errorTitle")}
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
              <MetadataListItem label={t("email")}>{user.email}</MetadataListItem>
              <MetadataListItem label={t("name")}>{user.name || t("notSet")}</MetadataListItem>
              {user.signInUsername && (
                <MetadataListItem label={t("signInUsername")}>
                  {user.signInUsername}
                </MetadataListItem>
              )}
              <MetadataListItem label={t("role")}>
                <Badge label={user.role} />
              </MetadataListItem>
              <MetadataListItem label={t("authenticationMethod")}>
                <Badge
                  variant={user.provider === "credentials" ? "neutral" : "info"}
                  label={getProviderName(user.provider ?? "")}
                />
              </MetadataListItem>
              {hasPassword && (
                <MetadataListItem label={t("password")}>
                  <Badge variant="success" label={t("passwordIsSet")} />
                </MetadataListItem>
              )}
            </MetadataList>
          </VStack>
        </ProfileSection>

        <DisplaySection onError={setError} />

        {localPasswordsEnabled && (
          <ProfileSection icon={Lock} title={t("passwordManagement")}>
            {passwordLocked ? (
              <Text type="body" size="sm" color="secondary">
                {t("demoPasswordLocked")}
              </Text>
            ) : hasPassword ? (
              <VStack gap={2}>
                <Text type="body" size="sm" color="secondary">
                  {t("passwordManagementDescription")}
                </Text>
                <HStack>
                  <Button
                    variant="secondary"
                    label={t("changePassword")}
                    onClick={() => setPasswordDialogOpen(true)}
                  />
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
                  <Button label={t("setPassword")} onClick={() => setPasswordDialogOpen(true)} />
                </HStack>
              </VStack>
            )}
          </ProfileSection>
        )}

        {localPasswordsEnabled && (
          <ProfileSection icon={ShieldCheck} title={t("twoFactor.title")}>
            <TwoFactorSection
              enabled={user.twoFactorEnabled}
              hasPassword={hasPassword}
              locked={passwordLocked}
            />
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
                        <Text type="body" size="xsm" color="secondary">
                          {t("signedIn", {
                            when: format.relativeTime(new Date(s.createdAt), now),
                          })}
                        </Text>,
                      )}
                      {s.ipAddress && (
                        <Text type="body" size="xsm" color="secondary">
                          {t("ipAddress", { address: s.ipAddress })}
                        </Text>
                      )}
                      {withUtc(
                        s.expiresAt,
                        <Text type="body" size="xsm" color="secondary">
                          {t("expiresOn", { date: formatDate(s.expiresAt) })}
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
                          label={t("unlinkOauthAccount")}
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
                  {enabledProviders.map((provider) => (
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

        <ProfileSection icon={Key} title={t("apiTokens")}>
          <VStack gap={4}>
            <Text type="body" size="sm" color="secondary">
              {t("apiTokensDescription")}
            </Text>

            {newToken && (
              <VStack gap={2}>
                <Text type="body" size="sm" weight="semibold">
                  {t("tokenCopyWarning")}
                </Text>
                <CodeBlock code={newToken} width="100%" />
              </VStack>
            )}

            {apiTokens.length > 0 && (
              <List hasDividers>
                {apiTokens.map((token) => {
                  const expired = isExpired(token.expiresAt);
                  return (
                    <ListItem
                      key={token.id}
                      startContent={<Icon icon={Key} size="sm" color="secondary" />}
                      label={token.name}
                      description={
                        <HStack gap={3} wrap="wrap" vAlign="center">
                          {withUtc(
                            token.createdAt,
                            <Text type="body" size="xsm" color="secondary">
                              {t("createdOn", { date: formatDate(token.createdAt) })}
                            </Text>,
                          )}
                          {withUtc(
                            token.lastUsedAt,
                            <Text type="body" size="xsm" color="secondary">
                              {t("used", { when: formatDate(token.lastUsedAt) })}
                            </Text>,
                          )}
                          {token.expiresAt &&
                            withUtc(
                              token.expiresAt,
                              <Text type="body" size="xsm" color="secondary">
                                {expired
                                  ? t("expiredOn", { date: formatDate(token.expiresAt) })
                                  : t("expiresOn", { date: formatDate(token.expiresAt) })}
                              </Text>,
                            )}
                        </HStack>
                      }
                      endContent={
                        <HStack gap={2} vAlign="center">
                          {expired && <Badge variant="error" label={t("expired")} />}
                          <form action={deleteApiTokenAction.bind(null, token.id)}>
                            <IconButton
                              type="submit"
                              variant="ghost"
                              size="sm"
                              label={t("deleteTokenNamed", { name: token.name })}
                              tooltip={t("deleteToken")}
                              icon={<Trash2 />}
                            />
                          </form>
                        </HStack>
                      }
                    />
                  );
                })}
              </List>
            )}

            {apiTokens.length === 0 && !newToken && (
              <EmptyState
                icon={<Key />}
                title={t("noApiTokensYet")}
                description={t("tokensEmptyDescription")}
                isCompact
              />
            )}

            <form action={handleCreateToken}>
              <VStack gap={3}>
                <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
                  <TextInput
                    label={t("name")}
                    isRequired
                    size="sm"
                    htmlName="name"
                    value={tokenName}
                    onChange={setTokenName}
                    placeholder={t("tokenNamePlaceholder")}
                  />
                  <VStack gap={0}>
                    <DateTimeInput
                      label={t("expiresAt")}
                      isOptional
                      size="sm"
                      value={tokenExpiresAt}
                      onChange={setTokenExpiresAt}
                    />
                    {/* DateTimeInput has no htmlName, hence the hidden field. */}
                    <input type="hidden" name="expires_at" value={tokenExpiresAt ?? ""} />
                  </VStack>
                </Grid>
                <HStack justify="end">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    icon={<Plus />}
                    label={t("createToken")}
                  />
                </HStack>
              </VStack>
            </form>
          </VStack>
        </ProfileSection>
      </VStack>

      <AppDialog
        open={passwordDialogOpen}
        onClose={() => setPasswordDialogOpen(false)}
        title={hasPassword ? t("changePassword") : t("setPassword")}
        maxWidth="sm"
        submitLabel={hasPassword ? t("changePassword") : t("setPassword")}
        onSubmit={handlePasswordChange}
        isSubmitting={loading}
      >
        <VStack gap={3}>
          {hasPassword && (
            <TextInput
              {...AUTOFILL_CURRENT_PASSWORD}
              label={t("currentPassword")}
              type="password"
              value={currentPassword}
              onChange={setCurrentPassword}
            />
          )}
          <GeneratedPasswordField
            label={t("newPassword")}
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
            {...AUTOFILL_NEW_PASSWORD}
            label={t("confirmNewPassword")}
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
        submitLabel={t("unlinkOauth")}
        onSubmit={handleUnlinkOAuth}
        isSubmitting={loading}
      >
        <VStack gap={3}>
          <Text type="body" size="sm" color="secondary">
            {t("unlinkOauthConfirm", { providers: linkedNames.join(", ") })}
          </Text>
          <TextInput
            {...AUTOFILL_CURRENT_PASSWORD}
            label={t("currentPassword")}
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
        submitLabel={t("removePassword")}
        onSubmit={handleRemovePassword}
        isSubmitting={loading}
      >
        <VStack gap={3}>
          <Text type="body" size="sm" color="secondary">
            {t("removePasswordDescription", { providers: linkedNames.join(", ") })}
          </Text>
          <TextInput
            {...AUTOFILL_CURRENT_PASSWORD}
            label={t("currentPassword")}
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
