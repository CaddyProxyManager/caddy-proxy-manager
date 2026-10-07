"use client";

/**
 * Groups as a list-detail page. Access (IdP names and managed resources) gets its own tab rather
 * than hiding behind a dialog with nothing on the page to say so.
 */
import { useEffect, useMemo, useState } from "react";
import { startViewAsAction } from "../view-as/actions";
import {
  Eye,
  Globe,
  Network,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Selector } from "@astryxdesign/core/Selector";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { AppDialog } from "@/components/ui/AppDialog";
import { SearchField } from "@/components/ui/SearchField";
import { SplitPage } from "@/components/ui/SplitPage";
import { Fab } from "@/src/components/mobile/Fab";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createGroupAction,
  updateGroupAction,
  deleteGroupAction,
  addGroupMembersAction,
  removeGroupMemberAction,
  setGroupGrantsAction,
  setGroupMappingsAction,
  setGroupRoleAction,
} from "./actions";
import {
  GroupAccessDialog,
  type GroupAccess,
  type NamedResource,
  type ProviderOption,
} from "@/components/groups/GroupAccessDialog";

type GroupMember = {
  userId: number;
  email: string;
  name: string | null;
  createdAt: string;
};

type Group = {
  id: number;
  name: string;
  description: string | null;
  source: string;
  /** A role every member holds besides their own. */
  role: string | null;
  members: GroupMember[];
  createdAt: string;
  updatedAt: string;
};

type UserEntry = {
  id: number;
  email: string;
  name: string | null;
  role: string;
};

type Props = {
  groups: Group[];
  users: UserEntry[];
  providers?: ProviderOption[];
  proxyHosts?: NamedResource[];
  l4ProxyHosts?: NamedResource[];
  agents?: NamedResource[];
  /** Group id → what that group is mapped from and what it may manage. */
  access?: Record<number, GroupAccess>;
  /** The roles a group may give: every one but admin, made ones by name. */
  roles?: { key: string; name: string | null }[];
};

type DetailTab = "members" | "access";

function displayName(entry: { name: string | null; email: string }) {
  return entry.name ?? entry.email.split("@")[0];
}

function emptyAccess(): GroupAccess {
  return {
    mappings: [],
    proxyHostIds: [],
    l4ProxyHostIds: [],
    agentIds: [],
    capability: "manage",
  };
}

/** What a group manages, as counts - the shape of the grant without opening it. */
function grantCounts(entry: GroupAccess | undefined) {
  const proxyHosts = entry?.proxyHostIds.length ?? 0;
  const l4Hosts = entry?.l4ProxyHostIds.length ?? 0;
  const agents = entry?.agentIds.length ?? 0;
  return { proxyHosts, l4Hosts, agents, total: proxyHosts + l4Hosts + agents };
}

export default function GroupsClient({
  groups,
  users,
  providers = [],
  proxyHosts = [],
  l4ProxyHosts = [],
  agents = [],
  access = {},
  roles = [],
}: Props) {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<number | null>(groups[0]?.id ?? null);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  // A deleted selection falls back to the first group rather than an empty pane. Keyed on the
  // list alone: a record just created is selected before the refreshed list delivers it, and
  // checking on every selection change would throw that selection away.
  useEffect(() => {
    setSelectedId((current) =>
      current !== null && !groups.some((entry) => entry.id === current)
        ? (groups[0]?.id ?? null)
        : current,
    );
  }, [groups]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.description ?? "").toLowerCase().includes(q) ||
        g.members.some(
          (m) => m.email.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
        ),
    );
  }, [groups, search]);

  const selected = groups.find((g) => g.id === selectedId) ?? null;
  const membershipCount = groups.reduce((sum, group) => sum + group.members.length, 0);

  const rail = (open: () => void) => (
    <VStack gap={3} padding={3}>
      <div className="cpm-list-header cpm-list-header-inset">
        <HStack justify="between" vAlign="center" gap={2}>
          <Heading level={1}>{tNav("groups")}</Heading>
          <Button
            variant="primary"
            size="lg"
            icon={<Plus />}
            label={tCommon("new")}
            onClick={() => setCreateOpen(true)}
            className="cpm-desktop-only"
          />
        </HStack>
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder={t("searchPlaceholder")}
          label={t("searchLabel")}
          width="100%"
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          headingLevel={2}
          icon={<Users />}
          title={t("noGroupsYet")}
          description={t("emptyDescription")}
          isCompact
          actions={
            <Button
              variant="ghost"
              size="sm"
              label={tCommon("new")}
              onClick={() => setCreateOpen(true)}
            />
          }
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          headingLevel={2}
          title={t("noGroupsMatch", { query: search })}
          isCompact
          actions={
            <Button
              variant="ghost"
              size="sm"
              label={tCommon("clearSearch")}
              onClick={() => setSearch("")}
            />
          }
        />
      ) : (
        <List>
          {filtered.map((group) => {
            const counts = grantCounts(access[group.id]);
            return (
              <ListItem
                key={group.id}
                isSelected={group.id === selectedId}
                startContent={
                  <Icon
                    icon={Users}
                    size="sm"
                    color={group.id === selectedId ? "accent" : "secondary"}
                  />
                }
                label={group.name}
                description={t("groupRowDescription", {
                  members: group.members.length,
                  resources: counts.total,
                })}
                endContent={
                  group.source === "oidc" ? (
                    <Badge variant="info" label={t("idpShort")} />
                  ) : undefined
                }
                onClick={() => {
                  setSelectedId(group.id);
                  open();
                }}
              />
            );
          })}
        </List>
      )}

      <Text type="supporting" color="secondary">
        {t("railSummary", { groups: groups.length, memberships: membershipCount })}
      </Text>
    </VStack>
  );

  return (
    <SplitPage
      storageKey="groups-rail"
      railLabel={tNav("groups")}
      resizeLabel={t("resizeRail")}
      backLabel={t("backToGroups")}
      hasSelection={selected !== null}
      rail={rail}
      phoneExtras={<Fab label={tCommon("new")} onClick={() => setCreateOpen(true)} />}
      detail={
        selected ? (
          <GroupDetail
            // Remounted per group, so the tab, the member search and any dialog start fresh.
            key={selected.id}
            group={selected}
            users={users}
            providers={providers}
            proxyHosts={proxyHosts}
            l4ProxyHosts={l4ProxyHosts}
            agents={agents}
            access={access[selected.id] ?? emptyAccess()}
            roles={roles}
            onChanged={() => router.refresh()}
          />
        ) : (
          <EmptyState
            headingLevel={2}
            icon={<Users />}
            title={t("selectionEmptyTitle")}
            description={tCommon("selectionEmptyDescription")}
          />
        )
      }
    >
      <GroupFormDialog
        open={createOpen}
        title={t("newGroup")}
        submitLabel={tCommon("create")}
        onClose={() => setCreateOpen(false)}
        onSubmit={async (formData) => {
          const { id } = await createGroupAction(formData);
          setCreateOpen(false);
          setSearch("");
          setSelectedId(id);
          router.refresh();
        }}
      />
    </SplitPage>
  );
}

function GroupDetail({
  group,
  users,
  providers,
  proxyHosts,
  l4ProxyHosts,
  agents,
  access,
  roles,
  onChanged,
}: {
  group: Group;
  users: UserEntry[];
  providers: ProviderOption[];
  proxyHosts: NamedResource[];
  l4ProxyHosts: NamedResource[];
  agents: NamedResource[];
  access: GroupAccess;
  roles: { key: string; name: string | null }[];
  onChanged: () => void;
}) {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const [tab, setTab] = useState<DetailTab>("members");
  const [editOpen, setEditOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [viewAsError, setViewAsError] = useState<string | null>(null);
  const counts = grantCounts(access);
  const isIdp = group.source === "oidc";

  return (
    <VStack gap={4}>
      <HStack gap={4} vAlign="start" justify="between" wrap="wrap">
        <HStack gap={4} vAlign="start">
          <Icon icon={Users} color="accent" />
          <VStack gap={1}>
            <Heading level={2}>{group.name}</Heading>
            <Text type="body" size="sm" color="secondary">
              {group.description || tCommon("noDescription")}
            </Text>
            <HStack gap={2} wrap="wrap" vAlign="center">
              <Badge
                icon={<Users />}
                label={tCommon("memberCount", { count: group.members.length })}
              />
              {isIdp && <Badge variant="info" label={t("idpManaged")} />}
              {counts.total === 0 ? (
                <Badge variant="neutral" label={t("noGrants")} />
              ) : (
                <Badge
                  variant={access.capability === "manage" ? "warning" : "neutral"}
                  label={
                    access.capability === "manage"
                      ? t("capabilityManageShort")
                      : t("capabilityViewShort")
                  }
                />
              )}
            </HStack>
          </VStack>
        </HStack>

        <HStack gap={1} vAlign="center">
          <Button
            variant="primary"
            size="sm"
            icon={<UserPlus />}
            label={tCommon("add")}
            onClick={() => setAddOpen(true)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={t("editGroupNamed", { name: group.name })}
            tooltip={t("editGroup")}
            icon={<Pencil />}
            onClick={() => setEditOpen(true)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={t("accessNamed", { name: group.name })}
            tooltip={t("access")}
            icon={<ShieldCheck />}
            onClick={() => setAccessOpen(true)}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={t("viewAsGroupNamed", { name: group.name })}
            tooltip={t("viewAsGroup")}
            icon={<Eye />}
            onClick={async () => {
              const result = await startViewAsAction("operator", [group.id]);
              if (result.status === "error") {
                setViewAsError(result.message ?? null);
                return;
              }
              window.location.assign("/");
            }}
          />
          <IconButton
            variant="ghost"
            size="sm"
            label={t("deleteGroupNamed", { name: group.name })}
            tooltip={t("deleteGroup")}
            icon={<Trash2 />}
            onClick={() => setConfirmDelete(true)}
          />
        </HStack>
      </HStack>

      {viewAsError && <Banner status="error" title={t("viewAsGroup")} description={viewAsError} />}

      {isIdp && (
        <Banner status="info" title={t("idpManaged")} description={t("idpMembershipHelp")} />
      )}

      <TabList value={tab} onChange={(v) => setTab(v as DetailTab)} size="sm" hasDivider>
        <Tab
          value="members"
          label={tCommon("members")}
          icon={<Users />}
          endContent={<Badge label={group.members.length} />}
        />
        <Tab
          value="access"
          label={t("access")}
          icon={<ShieldCheck />}
          endContent={<Badge label={counts.total} />}
        />
      </TabList>

      {tab === "members" && (
        <MembersTab
          group={group}
          users={users}
          onAdd={() => setAddOpen(true)}
          onChanged={onChanged}
        />
      )}
      {tab === "access" && (
        <AccessTab
          group={group}
          roles={roles}
          onChanged={onChanged}
          access={access}
          providers={providers}
          proxyHosts={proxyHosts}
          l4ProxyHosts={l4ProxyHosts}
          agents={agents}
          onEdit={() => setAccessOpen(true)}
        />
      )}

      <AddMemberDialog
        open={addOpen}
        group={group}
        users={users}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false);
          onChanged();
        }}
      />

      <GroupFormDialog
        open={editOpen}
        title={t("editGroupNamed", { name: group.name })}
        submitLabel={tCommon("save")}
        initial={{ name: group.name, description: group.description ?? "" }}
        onClose={() => setEditOpen(false)}
        onSubmit={async (formData) => {
          await updateGroupAction(group.id, formData);
          setEditOpen(false);
          onChanged();
        }}
      />

      {/* Not window.confirm: unstyled, and not announced as a dialog. */}
      <AlertDialog
        isOpen={confirmDelete}
        onOpenChange={(open) => !open && setConfirmDelete(false)}
        title={t("deleteGroup")}
        description={
          isIdp
            ? t("deleteGroupConfirmIdp", { name: group.name })
            : t("deleteGroupConfirm", { name: group.name })
        }
        actionLabel={t("deleteGroup")}
        onAction={async () => {
          await deleteGroupAction(group.id);
          setConfirmDelete(false);
          onChanged();
        }}
      />

      {accessOpen && (
        <GroupAccessDialog
          open
          groupName={group.name}
          providers={providers}
          proxyHosts={proxyHosts}
          l4ProxyHosts={l4ProxyHosts}
          agents={agents}
          initial={access}
          onClose={() => setAccessOpen(false)}
          onSave={async (next) => {
            setAccessOpen(false);
            // Two tables, two writes. The mapping goes first: if the grants write then fails, the
            // group has gained nothing, the safe half to land alone.
            await setGroupMappingsAction(group.id, next.mappings);
            await setGroupGrantsAction(group.id, [
              ...next.proxyHostIds.map((id) => ({
                resource: { kind: "proxyHost" as const, id },
                capability: next.capability,
              })),
              ...next.l4ProxyHostIds.map((id) => ({
                resource: { kind: "l4ProxyHost" as const, id },
                capability: next.capability,
              })),
              ...next.agentIds.map((id) => ({
                resource: { kind: "agent" as const, id },
                capability: next.capability,
              })),
            ]);
            onChanged();
          }}
        />
      )}
    </VStack>
  );
}

function MembersTab({
  group,
  users,
  onAdd,
  onChanged,
}: {
  group: Group;
  users: UserEntry[];
  onAdd: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const [query, setQuery] = useState("");
  const roles = new Map(users.map((u) => [u.id, u.role]));
  const q = query.trim().toLowerCase();
  const shown = q
    ? group.members.filter(
        (m) => m.email.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q),
      )
    : group.members;

  if (group.members.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title={tCommon("noMembersYet")}
        description={t("noMembersDescription")}
        actions={<Button size="sm" variant="secondary" label={tCommon("add")} onClick={onAdd} />}
      />
    );
  }

  return (
    <VStack gap={3}>
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={t("searchMembersPlaceholder")}
        label={t("searchMembers")}
        width="100%"
      />
      {shown.length === 0 ? (
        <Text type="body" size="sm" color="secondary">
          {t("noMembersMatch", { query })}
        </Text>
      ) : (
        <Card padding={0}>
          <List hasDividers>
            {shown.map((member) => (
              <ListItem
                key={member.userId}
                startContent={<Avatar name={displayName(member)} size="sm" />}
                label={displayName(member)}
                description={member.email}
                endContent={
                  <HStack gap={2} vAlign="center">
                    {roles.get(member.userId) && <Badge label={roles.get(member.userId) ?? ""} />}
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label={t("removeMemberFrom", {
                        member: displayName(member),
                        group: group.name,
                      })}
                      tooltip={t("removeMember")}
                      icon={<UserMinus />}
                      onClick={async () => {
                        await removeGroupMemberAction(group.id, member.userId);
                        onChanged();
                      }}
                    />
                  </HStack>
                }
              />
            ))}
          </List>
        </Card>
      )}
    </VStack>
  );
}

function AccessTab({
  group,
  roles,
  onChanged,
  access,
  providers,
  proxyHosts,
  l4ProxyHosts,
  agents,
  onEdit,
}: {
  group: Group;
  roles: { key: string; name: string | null }[];
  onChanged: () => void;
  access: GroupAccess;
  providers: ProviderOption[];
  proxyHosts: NamedResource[];
  l4ProxyHosts: NamedResource[];
  agents: NamedResource[];
  onEdit: () => void;
}) {
  const t = useTranslations("groups");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const counts = grantCounts(access);
  const nameOf = (list: NamedResource[], ids: number[]) =>
    ids.map((id) => list.find((item) => item.id === id)?.name ?? `#${id}`);
  const providerName = (id: string | null) =>
    id === null ? t("anyProvider") : (providers.find((p) => p.id === id)?.name ?? id);

  const sections = [
    {
      key: "proxyHosts",
      icon: Globe,
      title: tNav("proxyHosts"),
      names: nameOf(proxyHosts, access.proxyHostIds),
    },
    {
      key: "l4",
      icon: Network,
      title: tNav("l4ProxyHosts"),
      names: nameOf(l4ProxyHosts, access.l4ProxyHostIds),
    },
    { key: "agents", icon: Server, title: tNav("agents"), names: nameOf(agents, access.agentIds) },
  ];

  return (
    <VStack gap={4}>
      <GroupRoleCard group={group} roles={roles} onChanged={onChanged} />

      {counts.total === 0 && (
        <Banner status="info" title={t("noGrants")} description={t("noGrantsHelp")} />
      )}

      <Card>
        <VStack gap={3}>
          <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
            <Heading level={3}>{t("grants")}</Heading>
            <Button
              size="sm"
              variant="secondary"
              icon={<Pencil />}
              label={tCommon("edit")}
              onClick={onEdit}
            />
          </HStack>
          <Text type="body" size="sm" color="secondary">
            {t("grantsHelp")}
          </Text>
          <MetadataList>
            <MetadataListItem label={t("capability")}>
              {access.capability === "manage" ? t("capabilityManage") : t("capabilityView")}
            </MetadataListItem>
            {sections.map((section) => (
              <MetadataListItem key={section.key} label={section.title}>
                {section.names.length === 0 ? (
                  <Text type="body" size="sm" color="secondary">
                    {t("noneGranted")}
                  </Text>
                ) : (
                  <HStack gap={1} wrap="wrap">
                    {section.names.map((name) => (
                      <Badge key={name} icon={<section.icon />} label={name} />
                    ))}
                  </HStack>
                )}
              </MetadataListItem>
            ))}
          </MetadataList>
        </VStack>
      </Card>

      <Card>
        <VStack gap={3}>
          <Heading level={3}>{t("idpMapping")}</Heading>
          <Text type="body" size="sm" color="secondary">
            {t("idpMappingHelp")}
          </Text>
          {access.mappings.length === 0 ? (
            <Text type="body" size="sm" color="secondary">
              {t("noMappings")}
            </Text>
          ) : (
            <List hasDividers>
              {access.mappings.map((mapping) => (
                <ListItem
                  key={`${mapping.providerId ?? "*"}:${mapping.externalName}`}
                  label={mapping.externalName}
                  description={providerName(mapping.providerId)}
                />
              ))}
            </List>
          )}
        </VStack>
      </Card>
    </VStack>
  );
}

const NO_ROLE = "";

/** The role a group gives its members, changed in place: one choice, saved as it is made. */
function GroupRoleCard({
  group,
  roles,
  onChanged,
}: {
  group: Group;
  roles: { key: string; name: string | null }[];
  onChanged: () => void;
}) {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const tUsers = useTranslations("users");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (role: { key: string; name: string | null }) =>
    role.name ??
    (["operator", "user", "viewer"].includes(role.key)
      ? tUsers(`roles.${role.key as "operator" | "user" | "viewer"}`)
      : role.key);

  async function change(value: string) {
    setSaving(true);
    setError(null);
    try {
      await setGroupRoleAction(group.id, value === NO_ROLE ? null : value);
      onChanged();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("roleFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <VStack gap={3}>
        <Heading level={3}>{tCommon("role")}</Heading>
        <Text type="body" size="sm" color="secondary">
          {t("roleHelp")}
        </Text>
        {error && <Banner status="error" title={t("roleFailed")} description={error} />}
        <Selector
          label={tCommon("role")}
          size="sm"
          isDisabled={saving}
          options={[
            { value: NO_ROLE, label: t("noRole") },
            ...roles.map((role) => ({ value: role.key, label: label(role) })),
          ]}
          value={group.role ?? NO_ROLE}
          onChange={(value) => void change(value)}
        />
      </VStack>
    </Card>
  );
}

function AddMemberDialog({
  open,
  group,
  users,
  onClose,
  onAdded,
}: {
  open: boolean;
  group: Group;
  users: UserEntry[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const tUsers = useTranslations("users");
  const [query, setQuery] = useState("");
  // Stays open while picking, so several people join in one go; Add commits the whole selection.
  const [selected, setSelected] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const memberIds = new Set(group.members.map((m) => m.userId));
  const available = users.filter((u) => !memberIds.has(u.id));
  const q = query.trim().toLowerCase();
  const shown = q
    ? available.filter(
        (u) => u.email.toLowerCase().includes(q) || (u.name ?? "").toLowerCase().includes(q),
      )
    : available;
  const shownIds = new Set(shown.map((u) => u.id));

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected([]);
    }
  }, [open]);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("addMembers")}
      maxWidth="md"
      submitLabel={
        selected.length > 0 ? t("addSelected", { count: selected.length }) : t("addMembers")
      }
      isSubmitting={submitting}
      isSubmitDisabled={selected.length === 0}
      onSubmit={async () => {
        setSubmitting(true);
        try {
          await addGroupMembersAction(group.id, selected);
          onAdded();
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <VStack gap={3}>
        <Text type="body" size="sm" weight="medium">
          {t("memberPickerLabel")}
        </Text>
        {available.length === 0 ? (
          <Text type="body" size="sm" color="secondary">
            {t("membersExhaustedMessage")}
          </Text>
        ) : (
          <>
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder={tUsers("searchPlaceholder")}
              label={tUsers("searchLabel")}
              width="100%"
            />
            {shown.length === 0 ? (
              <Text type="body" size="sm" color="secondary">
                {t("noUsersMatch", { query })}
              </Text>
            ) : (
              /* Scroll cap: neither CheckboxList nor Stack exposes a max-height, and a fixed
                 height would pad out a short list. */
              <VStack isScrollable className="max-h-80">
                <CheckboxList
                  label={t("usersToAdd")}
                  isLabelHidden
                  hasDividers
                  value={selected.filter((id) => shownIds.has(id)).map(String)}
                  onChange={(values) =>
                    // The list only knows the rows the search left showing, so ticks on rows it
                    // hid are kept rather than dropped.
                    setSelected([
                      ...selected.filter((id) => !shownIds.has(id)),
                      ...values.map(Number),
                    ])
                  }
                >
                  {shown.map((user) => (
                    <CheckboxListItem
                      key={user.id}
                      value={String(user.id)}
                      label={displayName(user)}
                      description={user.email}
                      endContent={<Badge label={user.role} />}
                    />
                  ))}
                </CheckboxList>
              </VStack>
            )}
            {selected.length > 0 && (
              <HStack justify="between" vAlign="center" gap={2}>
                <Text type="body" size="sm" color="secondary">
                  {t("selectedCount", { count: selected.length })}
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  label={tCommon("clearSelection")}
                  onClick={() => setSelected([])}
                />
              </HStack>
            )}
          </>
        )}
      </VStack>
    </AppDialog>
  );
}

function GroupFormDialog({
  open,
  title,
  submitLabel,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  initial?: { name: string; description: string };
  onClose: () => void;
  onSubmit: (formData: FormData) => Promise<void>;
}) {
  const t = useTranslations("groups");
  const tCommon = useTranslations("common");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [submitting, setSubmitting] = useState(false);
  const formId = initial ? "edit-group-form" : "create-group-form";

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "");
      setDescription(initial?.description ?? "");
    }
  }, [open, initial?.name, initial?.description]);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={title}
      submitLabel={submitLabel}
      isSubmitting={submitting}
      isSubmitDisabled={name.trim() === ""}
      onSubmit={() => (document.getElementById(formId) as HTMLFormElement | null)?.requestSubmit()}
    >
      <form
        id={formId}
        action={async (formData) => {
          setSubmitting(true);
          try {
            await onSubmit(formData);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <VStack gap={3}>
          <TextInput
            {...NATIVE_REQUIRED}
            label={tCommon("name")}
            htmlName="name"
            value={name}
            onChange={setName}
            placeholder={t("namePlaceholder")}
            isRequired
            hasAutoFocus
          />
          <TextInput
            label={tCommon("description")}
            isOptional
            htmlName="description"
            value={description}
            onChange={setDescription}
            placeholder={t("optionalDescription")}
          />
        </VStack>
      </form>
    </AppDialog>
  );
}
