"use client";

/**
 * Users as a list-detail page. Creating and editing happen in dialogs, so the list never reflows
 * under a form.
 */
import { useEffect, useMemo, useState } from "react";
import { ViewAsDialog } from "@/components/users/ViewAsDialog";
import {
  Ban,
  CheckCircle2,
  Eye,
  LogIn,
  Pencil,
  Plus,
  Trash2,
  User,
  UserCog,
  Users as UsersIcon,
} from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { AppDialog } from "@/components/ui/AppDialog";
import { SplitPage } from "@/components/ui/SplitPage";
import { Fab } from "@/src/components/mobile/Fab";
import { SearchField } from "@/components/ui/SearchField";
import { EmailInput } from "@/src/components/ui/EmailInput";
import { GeneratedPasswordField } from "@/src/components/ui/GeneratedPasswordField";
import { AUTOFILL_EMAIL, NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { Timestamp } from "@/components/ui/Timestamp";
import { UserAvatar } from "@/src/components/UserAvatar";
import type { ResolvedAvatar } from "@/src/lib/users/avatar";
import { isUsableSignInUsername } from "@/src/lib/auth/login-username";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  createUserAction,
  updateUserRoleAction,
  updateUserStatusAction,
  updateUserInfoAction,
  deleteUserAction,
  resetUserTwoFactorAction,
  removeUserPasskeysAction,
  sendEmailedLinkAction,
} from "./actions";
import { addGroupMemberAction, removeGroupMemberAction } from "../groups/actions";
import type { AccountSource } from "@/src/lib/users/account-source";
import type { MfaPolicyMode } from "@/src/lib/auth/two-factor/mfa-policy";
import { isSignInMethod } from "@/src/lib/auth/sign-in-methods";
import { Token } from "@astryxdesign/core/Token";
import { StatusDot } from "@astryxdesign/core/StatusDot";

type Role = "admin" | "operator" | "user" | "viewer";

type UserEntry = {
  id: number;
  twoFactorEnabled: boolean;
  /** The admin looking at the page, who turns their own 2FA off from their Profile instead. */
  isSelf: boolean;
  email: string;
  name: string | null;
  /** The login page's username; null until an administrator sets one. */
  username: string | null;
  role: Role;
  provider: string | null;
  subject: string | null;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  avatar: ResolvedAvatar;
  /** Most recent session start, or null when no session of theirs is still on file. */
  lastSessionAt: string | null;
  /** Whether they have a login password at all - an SSO-only user does not. */
  hasPassword: boolean;
  passkeyCount: number;
  /** When it was last set; null when there is none, or it predates the record. */
  passwordChangedAt: string | null;
  /** The shared demo account, which cannot be disabled, deleted or demoted. */
  isDemoAdmin: boolean;
  /** Disabled by the auto-disable after failed sign-ins, not by an administrator. */
  disabledByFailedSignIns?: boolean;
  accountSource: AccountSource;
  /** The last completed sign-in, recorded since this release; older ones fall back to sessions. */
  lastSignInAt: string | null;
  lastSignInMethod: string | null;
};

/** A group, and who is in it - enough to show and change one user's memberships. */
export type GroupSummary = {
  id: number;
  name: string;
  source: string;
  memberIds: number[];
};

type Props = {
  users: UserEntry[];
  groups?: GroupSummary[];
  /** False in OIDC-only mode: accounts come from the IdP, not from this page. */
  localUsersEnabled?: boolean;
  /** Email is set up, so accounts can be invited and sent password links. */
  emailEnabled?: boolean;
  mfaPolicyMode?: MfaPolicyMode;
};

type StatusFilter = "all" | "active" | "disabled";

const ROLE_OPTIONS = [
  { value: "admin", labelKey: "roles.admin" },
  { value: "operator", labelKey: "roles.operator" },
  { value: "user", labelKey: "roles.user" },
  { value: "viewer", labelKey: "roles.viewer" },
] as const;

/** Role tint. Admin reads as elevated privilege, the rest are informational. */
const ROLE_VARIANTS: Record<Role, "red" | "blue" | "neutral"> = {
  admin: "red",
  // Elevated, but only over what their groups were granted - not the whole instance.
  operator: "blue",
  user: "blue",
  viewer: "neutral",
};

function userLabel(user: Pick<UserEntry, "name" | "email">) {
  return user.name ?? user.email.split("@")[0];
}

/** A password and nothing else: what the banner and the rail's warning point at. */
function lacksSecondFactor(user: UserEntry) {
  return user.hasPassword && !user.twoFactorEnabled && user.passkeyCount === 0;
}

/** "local" is the absence of an external provider, so anything else names an IdP. */
function isExternal(user: UserEntry) {
  return !!user.provider && user.provider !== "local" && user.provider !== "credentials";
}

export default function UsersClient({
  users,
  groups = [],
  localUsersEnabled = true,
  emailEnabled = false,
  mfaPolicyMode = "off",
}: Props) {
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const [noMfaOnly, setNoMfaOnly] = useState(false);
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const tSignInOverview = useTranslations("signInOverview");
  const tNav = useTranslations("nav");
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<number | null>(users[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A just-created account is selected once the refreshed list delivers it: its id is only known
  // after the server has rendered the row, so the create dialog hands over the email instead.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingEmail) return;
    const created = users.find((u) => u.email.toLowerCase() === pendingEmail);
    if (created) {
      setPendingEmail(null);
      setSelectedId(created.id);
    }
  }, [users, pendingEmail]);

  // A deleted selection falls back to the first account rather than an empty pane. Keyed on the
  // list alone: a record just created is selected before the refreshed list delivers it, and
  // checking on every selection change would throw that selection away.
  useEffect(() => {
    setSelectedId((current) =>
      current !== null && !users.some((entry) => entry.id === current)
        ? (users[0]?.id ?? null)
        : current,
    );
  }, [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (noMfaOnly && !(u.role === "admin" && lacksSecondFactor(u))) return false;
      if (status === "active" && u.status !== "active") return false;
      if (status === "disabled" && u.status === "active") return false;
      if (!q) return true;
      return (
        (u.name ?? "").toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.includes(q)
      );
    });
  }, [users, search, status, noMfaOnly]);

  const adminsWithoutMfa = users.filter(
    (u) => u.role === "admin" && u.status === "active" && lacksSecondFactor(u),
  );

  const selected = users.find((u) => u.id === selectedId) ?? null;
  const activeCount = users.filter((u) => u.status === "active").length;

  const refresh = (message: string | null = null) => {
    setError(message);
    if (message === null) router.refresh();
  };

  const rail = (open: () => void) => (
    <VStack gap={3} padding={3}>
      <div className="cpm-list-header cpm-list-header-inset">
        <HStack justify="between" vAlign="center" gap={2}>
          <Heading level={1}>{tNav("users")}</Heading>
          <IconButton
            variant="secondary"
            size="lg"
            icon={<Eye />}
            label={t("viewAs.open")}
            tooltip={t("viewAs.open")}
            onClick={() => setViewAsOpen(true)}
          />
          {localUsersEnabled && (
            <Button
              variant="primary"
              size="lg"
              icon={<Plus />}
              label={t("createUser")}
              onClick={() => setCreateOpen(true)}
              className="cpm-desktop-only"
            />
          )}
        </HStack>
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={t("searchPlaceholder")}
          label={t("searchLabel")}
          width="100%"
        />
        <SegmentedControl
          label={t("statusFilterLabel")}
          size="sm"
          layout="fill"
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
        >
          <SegmentedControlItem value="all" label={t("filterAll")} />
          <SegmentedControlItem value="active" label={t("filterActive")} />
          <SegmentedControlItem value="disabled" label={t("filterDisabled")} />
        </SegmentedControl>
        {noMfaOnly && (
          <HStack>
            <Token
              size="sm"
              color="orange"
              label={t("mfa.filterToken")}
              onRemove={() => setNoMfaOnly(false)}
            />
          </HStack>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState headingLevel={2} icon={<UserCog />} title={t("noUsersFound")} isCompact />
      ) : (
        <List>
          {filtered.map((user) => (
            <ListItem
              key={user.id}
              isSelected={user.id === selectedId}
              startContent={
                <UserAvatar avatar={user.avatar} alt={userLabel(user)} size="sm" tooltip={false} />
              }
              label={userLabel(user)}
              description={user.email}
              endContent={
                <HStack gap={1} vAlign="center">
                  {user.role === "admin" && lacksSecondFactor(user) && (
                    <StatusDot
                      variant="warning"
                      label={t("mfa.noSecondFactorShort")}
                      tooltip={t("mfa.noSecondFactorShort")}
                    />
                  )}
                  {user.status !== "active" && <Badge variant="error" label={t("disabledBadge")} />}
                  <Badge variant={ROLE_VARIANTS[user.role]} label={user.role} />
                </HStack>
              }
              onClick={() => {
                setSelectedId(user.id);
                open();
              }}
            />
          ))}
        </List>
      )}

      <HStack>
        <Button
          variant="ghost"
          size="sm"
          icon={<LogIn />}
          label={tSignInOverview("title")}
          href="/users/sign-in"
        />
      </HStack>

      {/* Totals at the foot: the rail scrolls, and these describe the whole set. */}
      <Text type="supporting" color="secondary">
        {t("railSummary", { count: filtered.length, active: activeCount, total: users.length })}
      </Text>
    </VStack>
  );

  return (
    <SplitPage
      storageKey="users-rail"
      railLabel={tNav("users")}
      resizeLabel={t("resizeRail")}
      backLabel={t("backToUsers")}
      hasSelection={selected !== null}
      rail={rail}
      phoneExtras={
        localUsersEnabled ? (
          <Fab label={t("createUser")} onClick={() => setCreateOpen(true)} />
        ) : undefined
      }
      detail={
        <VStack gap={4}>
          {error && (
            <Banner status="error" title={tCommon("somethingWentWrong")} description={error} />
          )}
          {adminsWithoutMfa.length > 0 && (
            <AdminsWithoutMfaBanner
              admins={adminsWithoutMfa}
              policyMode={mfaPolicyMode}
              onShow={() => {
                setNoMfaOnly(true);
                setStatus("all");
                setSearch("");
                setSelectedId(adminsWithoutMfa[0]?.id ?? null);
              }}
            />
          )}
          <ViewAsDialog
            open={viewAsOpen}
            onClose={() => setViewAsOpen(false)}
            groups={groups.map(({ id, name }) => ({ id, name }))}
          />
          {selected ? (
            <UserDetail
              // Remounted per user, so an open dialog or a half-typed field never carries across.
              key={selected.id}
              user={selected}
              groups={groups}
              canSendEmailedLink={localUsersEnabled && emailEnabled}
              onDone={refresh}
            />
          ) : (
            <EmptyState
              icon={<UserCog />}
              title={t("selectionEmptyTitle")}
              description={tCommon("selectionEmptyDescription")}
            />
          )}
        </VStack>
      }
    >
      {localUsersEnabled && (
        <CreateUserDialog
          open={createOpen}
          emailEnabled={emailEnabled}
          onClose={() => setCreateOpen(false)}
          onError={setError}
          onCreated={(email) => {
            setCreateOpen(false);
            setError(null);
            setSearch("");
            setStatus("all");
            setPendingEmail(email.toLowerCase());
            router.refresh();
          }}
        />
      )}
    </SplitPage>
  );
}

function UserDetail({
  user,
  groups,
  canSendEmailedLink,
  onDone,
}: {
  user: UserEntry;
  groups: GroupSummary[];
  canSendEmailedLink: boolean;
  /** null after a successful change, the message after a failed one. */
  onDone: (message: string | null) => void;
}) {
  const t = useTranslations("users");
  const tProfile = useTranslations("profile");
  const tCommon = useTranslations("common");
  const isDisabled = user.status !== "active";
  const [confirmKind, setConfirmKind] = useState<
    "disable" | "delete" | "reset2fa" | "removePasskeys" | null
  >(null);
  const [editOpen, setEditOpen] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  const name = userLabel(user);

  return (
    <VStack gap={5}>
      <HStack gap={4} vAlign="start" justify="between" wrap="wrap">
        <HStack gap={4} vAlign="center">
          <UserAvatar avatar={user.avatar} alt={name} size={48} tooltip={false} />
          <VStack gap={1}>
            <HStack gap={2} vAlign="center" wrap="wrap">
              <Heading level={2}>{name}</Heading>
              <Badge variant={ROLE_VARIANTS[user.role]} label={user.role} />
              {isDisabled && <Badge variant="error" label={t("disabledBadge")} />}
            </HStack>
            <Text type="body" size="sm" color="secondary">
              {user.email}
            </Text>
          </VStack>
        </HStack>

        <HStack gap={1} vAlign="center">
          <Button
            variant="secondary"
            size="sm"
            icon={<Pencil />}
            label={tCommon("edit")}
            aria-label={t("editUserNamed", { name })}
            onClick={() => setEditOpen(true)}
          />
          {user.isDemoAdmin ? null : isDisabled ? (
            <IconButton
              variant="ghost"
              size="sm"
              label={t("enableUserNamed", { name })}
              tooltip={t("enableUser")}
              icon={<CheckCircle2 />}
              onClick={async () => {
                const result = await updateUserStatusAction(user.id, "active");
                onDone(result.status === "error" ? (result.message ?? null) : null);
              }}
            />
          ) : (
            <IconButton
              variant="ghost"
              size="sm"
              label={t("disableUserNamed", { name })}
              tooltip={t("disableUser")}
              icon={<Ban />}
              onClick={() => setConfirmKind("disable")}
            />
          )}
          {!user.isDemoAdmin && (
            <IconButton
              variant="ghost"
              size="sm"
              label={t("deleteUserNamed", { name })}
              tooltip={t("deleteUser")}
              icon={<Trash2 />}
              onClick={() => setConfirmKind("delete")}
            />
          )}
        </HStack>
      </HStack>

      {isDisabled && (
        <Banner
          status="warning"
          title={t("disabledBannerTitle")}
          description={
            user.disabledByFailedSignIns
              ? t("disabledByFailedSignInsDescription")
              : t("disabledBannerDescription")
          }
        />
      )}

      <Card>
        <VStack gap={3}>
          <Heading level={3}>{t("details")}</Heading>
          <MetadataList>
            <MetadataListItem label={tCommon("email")}>{user.email}</MetadataListItem>
            <MetadataListItem label={t("signInUsername")}>
              {isUsableSignInUsername(user.username) ? user.username : t("signInUsernameNone")}
            </MetadataListItem>
            <MetadataListItem label={tCommon("role")}>{t(`roles.${user.role}`)}</MetadataListItem>
            <MetadataListItem label={t("accountSource.label")}>
              {t(`accountSource.${user.accountSource}`)}
            </MetadataListItem>
            <MetadataListItem label={t("signInMethod")}>
              {isExternal(user)
                ? t("signInExternal", { provider: user.provider ?? "" })
                : t("signInLocal")}
            </MetadataListItem>
            <MetadataListItem label={t("mfa.secondFactor")}>
              {user.twoFactorEnabled && user.passkeyCount > 0
                ? t("mfa.both")
                : user.twoFactorEnabled
                  ? t("mfa.totp")
                  : user.passkeyCount > 0
                    ? t("mfa.passkey")
                    : user.hasPassword
                      ? t("mfa.none")
                      : t("mfa.notApplicable")}
            </MetadataListItem>
            {isExternal(user) && user.subject && (
              <MetadataListItem label={t("subject")}>
                <Text type="code" size="sm">
                  {user.subject}
                </Text>
              </MetadataListItem>
            )}
            <MetadataListItem label={t("lastSignIn")}>
              {user.lastSignInAt ? (
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Timestamp value={user.lastSignInAt} style="dateTimeShort" />
                  {isSignInMethod(user.lastSignInMethod) && (
                    <Token size="sm" label={t(`lastSignInMethods.${user.lastSignInMethod}`)} />
                  )}
                </HStack>
              ) : user.lastSessionAt ? (
                <Timestamp value={user.lastSessionAt} style="dateTimeShort" />
              ) : (
                t("noActiveSession")
              )}
            </MetadataListItem>
            <MetadataListItem label={t("passwordChanged")}>
              <HStack gap={2} vAlign="center" wrap="wrap">
                <Text type="body" size="sm">
                  {!user.hasPassword ? (
                    t("passwordNone")
                  ) : user.passwordChangedAt ? (
                    <Timestamp value={user.passwordChangedAt} style="dateTimeShort" />
                  ) : (
                    t("passwordChangedUnknown")
                  )}
                </Text>
                {/* SSO accounts never had a password to reset, and should not be handed one. */}
                {canSendEmailedLink && !isExternal(user) && !user.isDemoAdmin && !isDisabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={user.hasPassword ? t("sendResetLink") : t("sendInvite")}
                    isLoading={sendingLink}
                    isDisabled={sendingLink}
                    onClick={async () => {
                      setSendingLink(true);
                      try {
                        const result = await sendEmailedLinkAction(user.id);
                        if (result.status === "error") {
                          onDone(result.message ?? null);
                        } else if (result.message) {
                          toast.success(result.message);
                        }
                      } finally {
                        setSendingLink(false);
                      }
                    }}
                  />
                )}
              </HStack>
            </MetadataListItem>
            {user.hasPassword && (
              <MetadataListItem label={tCommon("twoFactorSignIn")}>
                <HStack gap={2} vAlign="center">
                  <Text type="body" size="sm">
                    {user.twoFactorEnabled ? t("twoFactorOn") : t("twoFactorOff")}
                  </Text>
                  {user.twoFactorEnabled && !user.isSelf && (
                    <Button
                      variant="ghost"
                      size="sm"
                      label={t("resetTwoFactor")}
                      onClick={() => setConfirmKind("reset2fa")}
                    />
                  )}
                </HStack>
              </MetadataListItem>
            )}
            <MetadataListItem label={tProfile("passkeys.title")}>
              <HStack gap={2} vAlign="center">
                <Text type="body" size="sm">
                  {t("passkeyCount", { count: user.passkeyCount })}
                </Text>
                {user.passkeyCount > 0 && !user.isSelf && (
                  <Button
                    variant="ghost"
                    size="sm"
                    label={t("removePasskeys")}
                    onClick={() => setConfirmKind("removePasskeys")}
                  />
                )}
              </HStack>
            </MetadataListItem>
            <MetadataListItem label={t("created")}>
              <Timestamp value={user.createdAt} style="date" />
            </MetadataListItem>
          </MetadataList>
        </VStack>
      </Card>

      <GroupsCard user={user} groups={groups} onDone={onDone} />

      <EditUserDialog
        open={editOpen}
        user={user}
        onClose={() => setEditOpen(false)}
        onDone={(message) => {
          if (message === null) setEditOpen(false);
          onDone(message);
        }}
      />

      {/* Not window.confirm: unstyled, and not announced as a dialog. */}
      <AlertDialog
        isOpen={confirmKind !== null}
        onOpenChange={(open) => !open && setConfirmKind(null)}
        title={
          confirmKind === "delete"
            ? t("deleteUser")
            : confirmKind === "reset2fa"
              ? t("resetTwoFactor")
              : confirmKind === "removePasskeys"
                ? t("removePasskeys")
                : t("disableUser")
        }
        description={
          confirmKind === "delete"
            ? t("deleteUserConfirm", { name: user.name ?? user.email })
            : confirmKind === "reset2fa"
              ? t("resetTwoFactorConfirm", { name: user.name ?? user.email })
              : confirmKind === "removePasskeys"
                ? t("removePasskeysConfirm", { name: user.name ?? user.email })
                : t("disableUserConfirm", { name: user.name ?? user.email })
        }
        actionLabel={
          confirmKind === "delete"
            ? t("deleteUser")
            : confirmKind === "reset2fa"
              ? t("resetTwoFactor")
              : confirmKind === "removePasskeys"
                ? t("removePasskeys")
                : t("disableUser")
        }
        onAction={async () => {
          const result =
            confirmKind === "delete"
              ? await deleteUserAction(user.id)
              : confirmKind === "reset2fa"
                ? await resetUserTwoFactorAction(user.id)
                : confirmKind === "removePasskeys"
                  ? await removeUserPasskeysAction(user.id)
                  : await updateUserStatusAction(user.id, "disabled");
          setConfirmKind(null);
          onDone(result.status === "error" ? (result.message ?? null) : null);
        }}
      />
    </VStack>
  );
}

/** Administrators who sign in with a password alone, and the two ways to deal with them. */
function AdminsWithoutMfaBanner({
  admins,
  policyMode,
  onShow,
}: {
  admins: UserEntry[];
  policyMode: MfaPolicyMode;
  onShow: () => void;
}) {
  const t = useTranslations("users");
  const format = useFormatter();
  const names = format.list(admins.map(userLabel));
  return (
    <Banner
      status="warning"
      title={t("mfa.bannerTitle", { count: admins.length })}
      description={
        policyMode === "off"
          ? t("mfa.bannerDescriptionOff", { names })
          : t("mfa.bannerDescriptionPolicy", { names })
      }
      endContent={
        <HStack gap={2} wrap="wrap">
          <Button variant="secondary" size="sm" label={t("mfa.show")} onClick={onShow} />
          {policyMode === "off" && (
            <Button
              variant="secondary"
              size="sm"
              label={t("mfa.requireAction")}
              href="/settings/authentication#two-factor"
            />
          )}
        </HStack>
      }
    />
  );
}

/** The groups this account is in, with the ones it is not in a pick away. */
function GroupsCard({
  user,
  groups,
  onDone,
}: {
  user: UserEntry;
  groups: GroupSummary[];
  onDone: (message: string | null) => void;
}) {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const memberOf = groups.filter((g) => g.memberIds.includes(user.id));
  const available = groups.filter((g) => !g.memberIds.includes(user.id));
  const [adding, setAdding] = useState("");

  return (
    <Card>
      <VStack gap={3}>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={3}>{tNav("groups")}</Heading>
          <Badge label={t("groupCount", { count: memberOf.length })} />
        </HStack>
        {memberOf.length === 0 ? (
          <Text type="body" size="sm" color="secondary">
            {groups.length === 0 ? t("noGroupsExist") : t("notInAnyGroup")}
          </Text>
        ) : (
          <List hasDividers>
            {memberOf.map((group) => (
              <ListItem
                key={group.id}
                startContent={<UsersIcon size={16} />}
                label={group.name}
                description={group.source === "oidc" ? t("groupFromIdp") : undefined}
                endContent={
                  <Button
                    variant="ghost"
                    size="sm"
                    label={tCommon("remove")}
                    aria-label={t("removeFromGroupNamed", { group: group.name })}
                    onClick={async () => {
                      try {
                        await removeGroupMemberAction(group.id, user.id);
                        onDone(null);
                      } catch {
                        onDone(t("groupChangeFailed"));
                      }
                    }}
                  />
                }
              />
            ))}
          </List>
        )}
        {available.length > 0 && (
          <HStack gap={2} vAlign="end" wrap="wrap">
            <Selector
              label={t("addToGroup")}
              size="sm"
              placeholder={t("chooseGroup")}
              options={available.map((g) => ({ value: String(g.id), label: g.name }))}
              value={adding}
              onChange={(v) => setAdding(v as string)}
            />
            <Button
              size="sm"
              variant="secondary"
              label={tCommon("add")}
              isDisabled={adding === ""}
              onClick={async () => {
                try {
                  await addGroupMemberAction(Number(adding), user.id);
                  setAdding("");
                  onDone(null);
                } catch {
                  onDone(t("groupChangeFailed"));
                }
              }}
            />
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

type SetupMethod = "password" | "invite";

function CreateUserDialog({
  open,
  emailEnabled,
  onClose,
  onError,
  onCreated,
}: {
  open: boolean;
  emailEnabled: boolean;
  onClose: () => void;
  onError: (message: string | null) => void;
  onCreated: (email: string) => void;
}) {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const roleOptions = ROLE_OPTIONS.map((role) => ({ value: role.value, label: t(role.labelKey) }));
  const [role, setRole] = useState<Role>("user");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [method, setMethod] = useState<SetupMethod>("password");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const invite = emailEnabled && method === "invite";

  useEffect(() => {
    if (!open) {
      setRole("user");
      setEmail("");
      setName("");
      setUsername("");
      setPassword("");
      setMethod("password");
      setDialogError(null);
    }
  }, [open]);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("createUser")}
      maxWidth="md"
      submitLabel={tCommon("create")}
      isSubmitting={submitting}
      onSubmit={() =>
        (document.getElementById("create-user-form") as HTMLFormElement | null)?.requestSubmit()
      }
    >
      <form
        id="create-user-form"
        action={async (formData) => {
          formData.set("role", role);
          if (invite) {
            formData.set("invite", "on");
            formData.delete("password");
          }
          setSubmitting(true);
          try {
            const result = await createUserAction(formData);
            if (result.status === "error") {
              setDialogError(result.message ?? null);
              return;
            }
            onError(null);
            onCreated(email);
            // A message on success: the account exists, but its invitation did not go out.
            if (result.message) toast.warning(result.message);
            else if (invite) toast.success(t("inviteSent", { email }));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <VStack gap={3}>
          {dialogError && (
            <Banner
              status="error"
              title={tCommon("somethingWentWrong")}
              description={dialogError}
            />
          )}
          <EmailInput
            {...NATIVE_REQUIRED}
            {...AUTOFILL_EMAIL}
            data-testid="create-email"
            label={tCommon("email")}
            htmlName="email"
            value={email}
            onChange={setEmail}
            placeholder={t("emailPlaceholder")}
            isRequired
            hasAutoFocus
          />
          <TextInput
            data-testid="create-name"
            label={tCommon("name")}
            isOptional
            htmlName="name"
            value={name}
            onChange={setName}
            placeholder={t("displayName")}
          />
          <TextInput
            startIcon={User}
            data-testid="create-username"
            label={t("signInUsername")}
            isOptional
            htmlName="username"
            value={username}
            onChange={setUsername}
            description={t("signInUsernameCreateHelp")}
            autoComplete="off"
          />
          <Selector
            data-testid="create-role"
            label={tCommon("role")}
            options={roleOptions}
            value={role}
            onChange={(v) => setRole(v as Role)}
          />
          {emailEnabled && (
            <SegmentedControl
              label={t("setupMethod")}
              layout="fill"
              value={method}
              onChange={(v) => setMethod(v as SetupMethod)}
            >
              <SegmentedControlItem value="password" label={t("setupMethodPassword")} />
              <SegmentedControlItem value="invite" label={t("setupMethodInvite")} />
            </SegmentedControl>
          )}
          {invite ? (
            <Text type="body" size="sm" color="secondary">
              {t("inviteHelp")}
            </Text>
          ) : (
            <GeneratedPasswordField
              data-testid="create-password"
              label={tCommon("password")}
              htmlName="password"
              value={password}
              onChange={setPassword}
              placeholder={t("passwordPlaceholder")}
              isRequired
              minLength={8}
            />
          )}
        </VStack>
      </form>
    </AppDialog>
  );
}

function EditUserDialog({
  open,
  user,
  onClose,
  onDone,
}: {
  open: boolean;
  user: UserEntry;
  onClose: () => void;
  onDone: (message: string | null) => void;
}) {
  const t = useTranslations("users");
  const tCommon = useTranslations("common");
  const roleOptions = ROLE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(option.labelKey),
  }));
  const [role, setRole] = useState(user.role);
  const [name, setName] = useState(user.name ?? "");
  const [email, setEmail] = useState(user.email);
  const [username, setUsername] = useState(user.username ?? "");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setRole(user.role);
      setName(user.name ?? "");
      setEmail(user.email);
      setUsername(user.username ?? "");
    }
  }, [open, user]);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("editingNamed", { name: user.name ?? user.email })}
      maxWidth="md"
      submitLabel={tCommon("save")}
      isSubmitting={submitting}
      onSubmit={() =>
        (document.getElementById("edit-user-form") as HTMLFormElement | null)?.requestSubmit()
      }
    >
      <form
        id="edit-user-form"
        action={async (formData) => {
          setSubmitting(true);
          try {
            const info = await updateUserInfoAction(user.id, formData);
            if (info.status === "error") return onDone(info.message ?? null);
            if (role !== user.role) {
              const roleResult = await updateUserRoleAction(user.id, role);
              if (roleResult.status === "error") return onDone(roleResult.message ?? null);
            }
            onDone(null);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <VStack gap={3}>
          <TextInput
            label={tCommon("name")}
            htmlName="name"
            value={name}
            onChange={setName}
            placeholder={t("displayName")}
          />
          <EmailInput
            {...AUTOFILL_EMAIL}
            label={tCommon("email")}
            htmlName="email"
            value={email}
            onChange={setEmail}
            placeholder={t("emailAddress")}
          />
          <TextInput
            startIcon={User}
            label={t("signInUsername")}
            htmlName="username"
            value={username}
            onChange={setUsername}
            description={t("signInUsernameHelp")}
            autoComplete="off"
          />
          <Selector
            label={tCommon("role")}
            options={roleOptions}
            value={role}
            onChange={(v) => setRole(v as Role)}
            isDisabled={user.isDemoAdmin}
            disabledMessage={user.isDemoAdmin ? t("demoAdminRoleLocked") : undefined}
          />
        </VStack>
      </form>
    </AppDialog>
  );
}
