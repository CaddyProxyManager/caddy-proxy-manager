"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  Globe,
  KeyRound,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { AccessList, AccessListStats, AccessListUsage } from "@/lib/models/access-lists";
import { isSubmittedForApproval } from "@/lib/approvals/submitted";
import { unwrap } from "@/src/lib/errors/action-result";
import { withRowId, type WithRowId } from "@/lib/forms/row-id";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import {
  Table,
  pixel,
  proportional,
  useTableSelection,
  type TableColumn,
} from "@astryxdesign/core/Table";
import { Selector } from "@astryxdesign/core/Selector";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { AppDialog } from "@/components/ui/AppDialog";
import { Fab } from "@/src/components/mobile/Fab";
import { SearchField } from "@/components/ui/SearchField";
import { AUTOFILL_OFF } from "@/components/ui/native-input-attrs";
import { useTableDensity } from "@/components/ui/TableDensity";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { Switch } from "@/components/ui/FormBooleanControls";
import { NetworkTab } from "./NetworkTab";
import { useEmptyValue } from "@/components/ui/empty-value";
import { Timestamp, UtcTooltip } from "@/components/ui/Timestamp";
import { PanelResizeHandle, usePersistedPanelWidth } from "@/components/ui/PanelResizeHandle";
import { generatePassword } from "@/src/lib/auth/password/generator";
import {
  createAccessListAction,
  updateAccessListAction,
  deleteAccessListAction,
  addAccessEntryAction,
  deleteAccessEntryAction,
  bulkDeleteEntriesAction,
  regeneratePasswordAction,
  getAccessListStatsAction,
} from "./actions";
import { wideMeasure } from "@/components/ui/measure";

type Props = {
  lists: AccessList[];
  usage: Record<number, AccessListUsage[]>;
};

// --- Helpers ---

type Translate = ReturnType<typeof useTranslations<"accessLists">>;

function fmtRelative(iso: string | null, t: Translate): string {
  if (!iso) return t("relative.never");
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("relative.justNow");
  if (diff < 3600) return t("relative.minutesAgo", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("relative.hoursAgo", { count: Math.floor(diff / 3600) });
  if (diff < 86400 * 30) return t("relative.daysAgo", { count: Math.floor(diff / 86400) });
  if (diff < 86400 * 365) return t("relative.monthsAgo", { count: Math.floor(diff / 86400 / 30) });
  return t("relative.yearsAgo", { count: Math.floor(diff / 86400 / 365) });
}

type StrengthVariant = "neutral" | "error" | "warning" | "accent" | "success";

type StrengthLabelKey =
  | "strength.empty"
  | "strength.weak"
  | "strength.fair"
  | "strength.good"
  | "strength.strong"
  | "strength.excellent";

function pwStrength(pw: string): {
  score: number;
  labelKey: StrengthLabelKey;
  variant: StrengthVariant;
} {
  if (!pw) return { score: 0, labelKey: "strength.empty", variant: "neutral" };
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  const map: { labelKey: StrengthLabelKey; variant: StrengthVariant }[] = [
    { labelKey: "strength.empty", variant: "neutral" },
    { labelKey: "strength.weak", variant: "error" },
    { labelKey: "strength.fair", variant: "warning" },
    { labelKey: "strength.good", variant: "accent" },
    { labelKey: "strength.strong", variant: "success" },
    { labelKey: "strength.excellent", variant: "success" },
  ];
  return { score: s, ...map[s] };
}

type SortKey = "recent" | "name" | "members" | "usage";

type MemberRow = {
  id: number;
  username: string;
  createdAt: string | null;
  [key: string]: unknown;
};

// --- Members Tab ---

function MembersTab({
  list,
  onListUpdated,
}: {
  list: AccessList;
  onListUpdated: (list: AccessList) => void;
}) {
  const t = useTranslations("accessLists");
  const tCommon = useTranslations("common");
  const tUi = useTranslations("ui");
  const emptyValue = useEmptyValue();
  const density = useTableDensity();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ username: "", password: "" });
  const [submitting, setSubmitting] = useState(false);

  const removeSelected = async () => {
    const ids = Array.from(selected);
    const result = await bulkDeleteEntriesAction(list.id, ids);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const updated = result.data;
    if (isSubmittedForApproval(updated)) toast.success(updated.message);
    else {
      if (updated) onListUpdated(updated);
      toast.success(t("removedMembersToast", { count: ids.length }));
    }
    setSelected(new Set());
  };

  const removeOne = async (id: number) => {
    const entry = list.entries.find((e) => e.id === id);
    const result = await deleteAccessEntryAction(list.id, id);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    const updated = result.data;
    if (isSubmittedForApproval(updated)) {
      toast.success(updated.message);
      return;
    }
    if (updated) onListUpdated(updated);
    toast.success(
      entry ? t("removedNamedToast", { username: entry.username }) : t("removedMemberToast"),
    );
  };

  const regen = async (id: number) => {
    const pw = generatePassword();
    const result = await regeneratePasswordAction(list.id, id, pw);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onListUpdated(result.data);
    try {
      await navigator.clipboard.writeText(pw);
      toast.success(t("passwordCopiedToast"));
    } catch {
      toast.success(t("passwordGeneratedToast"));
    }
  };

  const submitNew = async () => {
    if (!draft.username.trim() || !draft.password) return;
    if (list.entries.some((e) => e.username === draft.username.trim())) {
      toast.error(t("usernameAlreadyExists"));
      return;
    }
    setSubmitting(true);
    try {
      const result = await addAccessEntryAction(list.id, {
        username: draft.username.trim(),
        password: draft.password,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const updated = result.data;
      setDraft({ username: "", password: "" });
      setAdding(false);
      if (isSubmittedForApproval(updated)) {
        toast.success(updated.message);
        return;
      }
      onListUpdated(updated);
      toast.success(t("addedToast", { username: draft.username.trim() }));
    } finally {
      setSubmitting(false);
    }
  };

  const strength = pwStrength(draft.password);

  const rows: MemberRow[] = list.entries.map((e) => ({
    id: e.id,
    username: e.username,
    createdAt: e.createdAt,
  }));

  const selection = useTableSelection<MemberRow>({
    getIsItemSelected: (row) => selected.has(row.id),
    onSelectItem: ({ item, isSelected }) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (isSelected) next.add(item.id);
        else next.delete(item.id);
        return next;
      }),
    onSelectAll: ({ isAllSelected }) =>
      setSelected(isAllSelected ? new Set(rows.map((r) => r.id)) : new Set()),
    getIsAllSelected: () => rows.length > 0 && selected.size === rows.length,
    getIsIndeterminate: () => selected.size > 0 && selected.size < rows.length,
    getRowLabel: (row) => row.username,
  });

  const columns: TableColumn<MemberRow>[] = [
    {
      key: "username",
      header: tCommon("username"),
      width: proportional(1),
      renderCell: (row) => (
        <Text type="code" size="sm" weight="medium">
          {row.username}
        </Text>
      ),
    },
    {
      key: "password",
      header: tCommon("password"),
      width: pixel(180),
      renderCell: (row) => (
        <HStack gap={1} vAlign="center">
          <Text type="code" size="sm" color="secondary">
            ••••••••••••
          </Text>
          <IconButton
            variant="ghost"
            size="sm"
            label={t("regeneratePasswordFor", { username: row.username })}
            tooltip={t("regeneratePasswordTooltip")}
            icon={<RefreshCw />}
            onClick={() => regen(row.id)}
          />
        </HStack>
      ),
    },
    {
      key: "createdAt",
      header: t("columnAdded"),
      width: pixel(140),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          {row.createdAt ? <Timestamp value={row.createdAt} style="date" /> : emptyValue}
        </Text>
      ),
    },
    {
      key: "__remove",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(48),
      align: "end",
      resizable: false,
      renderCell: (row) => (
        <IconButton
          variant="ghost"
          size="sm"
          label={t("removeNamed", { username: row.username })}
          tooltip={tCommon("remove")}
          icon={<Trash2 />}
          onClick={() => removeOne(row.id)}
        />
      ),
    },
  ];

  return (
    <VStack gap={3}>
      <HStack justify="between" vAlign="center" gap={3} wrap="wrap">
        <HStack gap={2} vAlign="center">
          {selected.size > 0 ? (
            <>
              <Text type="body" size="sm" weight="medium">
                {tUi("bulk.selectedCount", { count: selected.size })}
              </Text>
              <Button
                variant="ghost"
                size="sm"
                icon={<Trash2 />}
                label={tCommon("remove")}
                onClick={removeSelected}
              />
              <Button
                variant="ghost"
                size="sm"
                label={tCommon("cancel")}
                onClick={() => setSelected(new Set())}
              />
            </>
          ) : (
            <Text type="body" size="sm" color="secondary">
              {tCommon("memberCount", { count: list.entries.length })}
            </Text>
          )}
        </HStack>
        <Button
          variant="primary"
          size="sm"
          icon={<Plus />}
          label={tCommon("addMember")}
          onClick={() => setAdding(true)}
        />
      </HStack>

      {adding && (
        <Card variant="muted" padding={3}>
          <VStack gap={3}>
            <TextInput
              startIcon={User}
              {...AUTOFILL_OFF}
              label={tCommon("username")}
              isRequired
              size="sm"
              value={draft.username}
              onChange={(v) => setDraft({ ...draft, username: v })}
              placeholder={t("usernamePlaceholder")}
              hasAutoFocus
            />
            <VStack gap={1}>
              <HStack gap={2} vAlign="end">
                <TextInput
                  startIcon={KeyRound}
                  {...AUTOFILL_OFF}
                  label={tCommon("password")}
                  isRequired
                  size="sm"
                  value={draft.password}
                  onChange={(v) => setDraft({ ...draft, password: v })}
                  placeholder={t("passwordPlaceholder")}
                  width="100%"
                />
                <IconButton
                  variant="secondary"
                  size="sm"
                  label={tUi("passwordField.generateLabel")}
                  tooltip={tUi("passwordField.generateTooltip")}
                  icon={<Sparkles />}
                  onClick={() => setDraft((d) => ({ ...d, password: generatePassword() }))}
                />
              </HStack>
              {draft.password && (
                <ProgressBar
                  label={t("passwordStrength", { strength: t(strength.labelKey) })}
                  value={(strength.score / 5) * 100}
                  variant={strength.variant}
                  hasValueLabel
                  formatValueLabel={() => t(strength.labelKey)}
                />
              )}
            </VStack>
            <HStack gap={2} justify="end">
              <Button
                variant="secondary"
                size="sm"
                label={tCommon("cancel")}
                onClick={() => {
                  setAdding(false);
                  setDraft({ username: "", password: "" });
                }}
              />
              <Button
                size="sm"
                label={tCommon("add")}
                onClick={submitNew}
                isLoading={submitting}
                isDisabled={!draft.username.trim() || !draft.password || submitting}
              />
            </HStack>
          </VStack>
        </Card>
      )}

      {list.entries.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={tCommon("noMembersYet")}
          description={t("membersEmptyDescription")}
          actions={
            <Button
              size="sm"
              icon={<Plus />}
              label={t("membersEmptyAction")}
              onClick={() => setAdding(true)}
            />
          }
        />
      ) : (
        <Table
          data={rows}
          columns={columns}
          idKey="id"
          density={density}
          hasHover
          plugins={{ selection }}
        />
      )}
    </VStack>
  );
}

// --- Settings Tab ---

function SettingsTab({
  list,
  usageCount,
  onListUpdated,
  onDeleted,
}: {
  list: AccessList;
  usageCount: number;
  onListUpdated: (list: AccessList) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("accessLists");
  const tCommon = useTranslations("common");
  const emptyValue = useEmptyValue();
  const [name, setName] = useState(list.name);
  const [desc, setDesc] = useState(list.description || "");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Keyed on the id too: another list with the same name and description must still reset.
  // biome-ignore lint/correctness/useExhaustiveDependencies: list.id is deliberate
  useEffect(() => {
    setName(list.name);
    setDesc(list.description || "");
    setConfirm("");
  }, [list.id, list.name, list.description]);

  const dirty = name !== list.name || (desc || "") !== (list.description || "");
  const canSatisfyAny = list.entries.length > 0 && list.ipRules.length > 0;

  // Applied as soon as they're changed, like the IP default: each is one choice, not a draft.
  const saveOption = async (input: { satisfy?: string; passAuth?: boolean }) => {
    try {
      const updated = unwrap(await updateAccessListAction(list.id, input));
      if (isSubmittedForApproval(updated)) toast.success(updated.message);
      else {
        onListUpdated(updated);
        toast.success(t("saved"));
      }
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : t("ipRulesSaveFailed"));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await updateAccessListAction(list.id, {
        name: name.trim() || list.name,
        description: desc.trim() || null,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const updated = result.data;
      if (isSubmittedForApproval(updated)) toast.success(updated.message);
      else {
        onListUpdated(updated);
        toast.success(t("saved"));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await deleteAccessListAction(list.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.submitted) {
        toast.success(result.data.submitted);
        return;
      }
      toast.success(t("deletedToast", { name: list.name }));
      onDeleted();
    } finally {
      setDeleting(false);
    }
  };

  const confirmMismatch = confirm.length > 0 && confirm !== list.name;

  return (
    <VStack gap={6} maxWidth={wideMeasure(672)}>
      <VStack gap={3}>
        <TextInput label={tCommon("name")} isRequired size="sm" value={name} onChange={setName} />
        <TextArea
          label={tCommon("description")}
          isOptional
          size="sm"
          value={desc}
          onChange={setDesc}
          rows={3}
          placeholder={t("descriptionPlaceholder")}
        />
        <HStack gap={2} vAlign="center">
          <Button
            size="sm"
            label={tCommon("save")}
            onClick={save}
            isLoading={saving}
            isDisabled={!dirty || !name.trim() || saving}
          />
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              label={tCommon("discard")}
              onClick={() => {
                setName(list.name);
                setDesc(list.description || "");
              }}
            />
          )}
        </HStack>
      </VStack>

      <VStack gap={3}>
        <Selector
          label={t("satisfy")}
          description={canSatisfyAny ? t("satisfyHelp") : t("satisfyNeedsBoth")}
          size="sm"
          width={420}
          options={[
            { value: "all", label: t("satisfyAll") },
            { value: "any", label: t("satisfyAny") },
          ]}
          value={list.satisfy}
          isDisabled={!canSatisfyAny}
          onChange={(next) => saveOption({ satisfy: next as string })}
        />
        <Switch
          label={t("passAuth")}
          description={t("passAuthHelp")}
          labelPosition="start"
          labelSpacing="spread"
          value={list.passAuth}
          onChange={(next) => saveOption({ passAuth: next })}
        />
      </VStack>

      <Card padding={3}>
        <MetadataList>
          <MetadataListItem label={t("created")}>
            {list.createdAt ? <Timestamp value={list.createdAt} style="date" /> : emptyValue}
          </MetadataListItem>
          <MetadataListItem label={t("lastUpdated")}>
            {list.updatedAt ? (
              <UtcTooltip value={list.updatedAt}>
                <span>{fmtRelative(list.updatedAt, t)}</span>
              </UtcTooltip>
            ) : (
              fmtRelative(null, t)
            )}
          </MetadataListItem>
          <MetadataListItem label={t("listId")}>
            <Text type="code" size="sm">
              {list.id}
            </Text>
          </MetadataListItem>
        </MetadataList>
      </Card>

      <Banner
        status="error"
        icon={<AlertTriangle />}
        title={t("dangerZone")}
        description={t("deleteListDescription")}
        collapsible={{ defaultIsOpen: true }}
      >
        <VStack gap={3}>
          <Text type="supporting">
            {usageCount > 0
              ? t("deleteInUseWarning", { count: usageCount })
              : t("deleteUnusedWarning")}
          </Text>
          <TextInput
            {...AUTOFILL_OFF}
            label={t("typeNameToConfirm", { name: list.name })}
            size="sm"
            value={confirm}
            onChange={setConfirm}
            placeholder={list.name}
            width={448}
            status={confirmMismatch ? { type: "error", message: t("nameDoesNotMatch") } : undefined}
          />
          <HStack>
            <Button
              variant="destructive"
              size="sm"
              icon={<Trash2 />}
              label={tCommon("delete")}
              isLoading={deleting}
              isDisabled={confirm !== list.name || deleting}
              onClick={handleDelete}
            />
          </HStack>
        </VStack>
      </Banner>
    </VStack>
  );
}

// --- Usage Tab ---

/** What the list did over the last day; null while loading or when it could not be read. */
function UsageStats({ listId }: { listId: number }) {
  const t = useTranslations("accessLists");
  const format = useAppFormatter();
  const [stats, setStats] = useState<AccessListStats | null>(null);

  useEffect(() => {
    let live = true;
    getAccessListStatsAction(listId)
      .then(unwrap)
      .then((next) => {
        if (live) setStats(next);
      })
      .catch(() => {
        if (live) setStats(null);
      });
    return () => {
      live = false;
    };
  }, [listId]);

  if (!stats) return null;
  return (
    <Card padding={3}>
      <MetadataList>
        <MetadataListItem label={t("stats.hosts")}>{format.number(stats.hosts)}</MetadataListItem>
        <MetadataListItem label={t("stats.stopped")}>
          {stats.traffic ? format.number(stats.traffic.stopped) : t("stats.analyticsOff")}
        </MetadataListItem>
        <MetadataListItem label={t("stats.failedSignIns")}>
          {stats.traffic ? format.number(stats.traffic.failedSignIns) : t("stats.analyticsOff")}
        </MetadataListItem>
      </MetadataList>
    </Card>
  );
}

function UsageTab({ listId, hosts }: { listId: number; hosts: AccessListUsage[] }) {
  const t = useTranslations("accessLists");
  if (hosts.length === 0) {
    return (
      <EmptyState
        icon={<Globe />}
        title={t("unusedListTitle")}
        description={t("unusedListDescription")}
      />
    );
  }

  return (
    <VStack gap={3}>
      <UsageStats listId={listId} />
      <Text type="body" size="sm" color="secondary">
        {t("usageSummary", { count: hosts.length })}
      </Text>
      <List hasDividers>
        {hosts.map((h) => (
          <ListItem
            key={`${h.kind}-${h.id}`}
            startContent={
              <Icon icon={h.kind === "l4" ? Network : Globe} size="sm" color="secondary" />
            }
            label={h.kind === "l4" ? h.name : (h.domains[0] ?? h.name)}
            description={
              h.kind === "l4"
                ? t("l4HostUsage", { listen: h.domains[0] ?? "" })
                : h.domains.length > 1
                  ? t("moreDomains", { count: h.domains.length - 1 })
                  : undefined
            }
            endContent={
              <Badge
                variant={h.enabled ? "success" : "neutral"}
                label={h.enabled ? t("hostActive") : t("hostDisabled")}
              />
            }
          />
        ))}
      </List>
    </VStack>
  );
}

// --- Detail Pane ---

type DetailTab = "members" | "network" | "usage" | "settings";

function DetailPane({
  list,
  usage,
  onListUpdated,
  onDeleted,
}: {
  list: AccessList | null;
  usage: AccessListUsage[];
  onListUpdated: (list: AccessList) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("accessLists");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const [tab, setTab] = useState<DetailTab>("members");

  if (!list) {
    return (
      <EmptyState
        headingLevel={2}
        icon={<KeyRound />}
        title={t("selectionEmptyTitle")}
        description={tCommon("selectionEmptyDescription")}
      />
    );
  }

  const isEmpty = list.entries.length === 0 && list.ipRules.length === 0;

  return (
    <VStack gap={4}>
      <HStack gap={4} vAlign="start">
        <Icon icon={KeyRound} color="accent" />
        <VStack gap={1}>
          <Heading level={2}>{list.name}</Heading>
          <Text type="body" size="sm" color="secondary">
            {list.description || tCommon("noDescription")}
          </Text>
          <HStack gap={2} wrap="wrap" vAlign="center">
            <Badge
              icon={<Users />}
              label={tCommon("memberCount", { count: list.entries.length })}
            />
            <Badge icon={<Globe />} label={tCommon("hostCount", { count: usage.length })} />
            <Badge
              icon={<Clock />}
              label={t("updatedBadge", { when: fmtRelative(list.updatedAt, t) })}
            />
            {list.ipRules.length > 0 && (
              <Badge icon={<Network />} label={t("ipRuleCount", { count: list.ipRules.length })} />
            )}
            {isEmpty && <Badge variant="error" label={t("noMembersBadge")} />}
            {usage.length === 0 && <Badge variant="warning" label={t("unusedBadge")} />}
          </HStack>
        </VStack>
      </HStack>

      {/* Above the tabs: an empty list in use is a host that answers nobody. */}
      {isEmpty && usage.length > 0 && (
        <Banner
          status="warning"
          title={t("noMembersBannerTitle")}
          description={t("noMembersBannerDescription", { count: usage.length })}
        />
      )}

      <TabList value={tab} onChange={(v) => setTab(v as DetailTab)} size="sm" hasDivider>
        <Tab
          value="members"
          label={tCommon("members")}
          icon={<Users />}
          endContent={<Badge label={list.entries.length} />}
        />
        <Tab
          value="network"
          label={t("network")}
          icon={<Network />}
          endContent={<Badge label={list.ipRules.length} />}
        />
        <Tab
          value="usage"
          label={tCommon("usedBy")}
          icon={<Globe />}
          endContent={<Badge label={usage.length} />}
        />
        <Tab value="settings" label={tNav("settings")} icon={<Settings2 />} />
      </TabList>

      {tab === "members" && <MembersTab list={list} onListUpdated={onListUpdated} />}
      {tab === "network" && <NetworkTab list={list} onListUpdated={onListUpdated} />}
      {tab === "usage" && <UsageTab listId={list.id} hosts={usage} />}
      {tab === "settings" && (
        <SettingsTab
          list={list}
          usageCount={usage.length}
          onListUpdated={onListUpdated}
          onDeleted={onDeleted}
        />
      )}
    </VStack>
  );
}

// --- New List Dialog ---

type SeedMember = { username: string; password: string };

function blankSeedMember(): WithRowId<SeedMember> {
  return withRowId({ username: "", password: "" });
}

function NewListDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (list: AccessList) => void;
}) {
  const t = useTranslations("accessLists");
  const tCommon = useTranslations("common");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [seed, setSeed] = useState<WithRowId<SeedMember>[]>(() => [blankSeedMember()]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setDesc("");
      setSeed([blankSeedMember()]);
    }
  }, [open]);

  const valid = name.trim().length > 0;

  const submit = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const result = await createAccessListAction({
        name: name.trim(),
        description: desc.trim() || null,
        users: seed
          .filter((s) => s.username.trim() && s.password)
          .map(({ username, password }) => ({ username, password })),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const list = result.data;
      onClose();
      if (isSubmittedForApproval(list)) {
        toast.success(list.message);
        return;
      }
      onCreate(list);
      toast.success(t("createdToast", { name: list.name }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t("newAccessList")}
      maxWidth="lg"
      submitLabel={tCommon("create")}
      onSubmit={submit}
      isSubmitting={submitting}
      isSubmitDisabled={!name.trim()}
    >
      <VStack gap={4}>
        <Text type="body" size="sm" color="secondary">
          {t("createListDescription")}
        </Text>

        <TextInput
          label={tCommon("name")}
          isRequired
          size="sm"
          value={name}
          onChange={setName}
          placeholder={t("listNamePlaceholder")}
          hasAutoFocus
        />
        <TextInput
          label={tCommon("description")}
          isOptional
          size="sm"
          value={desc}
          onChange={setDesc}
          placeholder={t("newListDescriptionPlaceholder")}
        />

        <VStack gap={2}>
          <Text type="label" size="sm" color="secondary">
            {t("seedMembersOptional")}
          </Text>
          {seed.map((s, i) => (
            <HStack key={s.rowId} gap={2} vAlign="end">
              <TextInput
                startIcon={User}
                {...AUTOFILL_OFF}
                label={t("seedUsernameLabel", { index: i + 1 })}
                isLabelHidden
                size="sm"
                value={s.username}
                onChange={(v) =>
                  setSeed(seed.map((x) => (x.rowId === s.rowId ? { ...x, username: v } : x)))
                }
                placeholder={t("seedUsernamePlaceholder")}
                width="100%"
              />
              <TextInput
                startIcon={KeyRound}
                {...AUTOFILL_OFF}
                label={t("seedPasswordLabel", { index: i + 1 })}
                isLabelHidden
                size="sm"
                value={s.password}
                onChange={(v) =>
                  setSeed(seed.map((x) => (x.rowId === s.rowId ? { ...x, password: v } : x)))
                }
                placeholder={t("seedPasswordPlaceholder")}
                width="100%"
              />
              <IconButton
                variant="secondary"
                size="sm"
                label={t("seedGeneratePasswordLabel", { index: i + 1 })}
                tooltip={t("generatePassword")}
                icon={<Sparkles />}
                onClick={() =>
                  setSeed(
                    seed.map((x) =>
                      x.rowId === s.rowId ? { ...x, password: generatePassword() } : x,
                    ),
                  )
                }
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t("seedRemoveLabel", { index: i + 1 })}
                tooltip={tCommon("remove")}
                icon={<X />}
                onClick={() =>
                  setSeed(
                    seed.length === 1
                      ? [blankSeedMember()]
                      : seed.filter((x) => x.rowId !== s.rowId),
                  )
                }
              />
            </HStack>
          ))}
          <HStack>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus />}
              label={tCommon("add")}
              onClick={() => setSeed([...seed, blankSeedMember()])}
            />
          </HStack>
        </VStack>
      </VStack>
    </AppDialog>
  );
}

// --- Lists Rail (left sidebar) ---

const SORT_OPTIONS: {
  value: SortKey;
  labelKey: "accessLists.sortRecent" | "common.name" | "common.members" | "accessLists.sortUsage";
}[] = [
  { value: "recent", labelKey: "accessLists.sortRecent" },
  { value: "name", labelKey: "common.name" },
  { value: "members", labelKey: "common.members" },
  { value: "usage", labelKey: "accessLists.sortUsage" },
];

function ListsRail({
  lists,
  selectedId,
  onSelect,
  onNew,
  query,
  setQuery,
  sort,
  setSort,
  usage,
}: {
  lists: AccessList[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNew: () => void;
  query: string;
  setQuery: (q: string) => void;
  sort: SortKey;
  setSort: (s: SortKey) => void;
  usage: Record<number, AccessListUsage[]>;
}) {
  const t = useTranslations("accessLists");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const tRoot = useTranslations();
  const filtered = useMemo(() => {
    let arr = lists.slice();
    const q = query.trim().toLowerCase();
    if (q) {
      arr = arr.filter(
        (l) =>
          l.name.toLowerCase().includes(q) ||
          (l.description || "").toLowerCase().includes(q) ||
          l.entries.some((e) => e.username.toLowerCase().includes(q)),
      );
    }
    arr.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "members") return b.entries.length - a.entries.length;
      if (sort === "recent")
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (sort === "usage") return (usage[b.id]?.length ?? 0) - (usage[a.id]?.length ?? 0);
      return 0;
    });
    return arr;
  }, [lists, query, sort, usage]);

  return (
    <VStack gap={3} padding={3}>
      {/* Sticky on a phone like every list header; boxless on a desktop. */}
      <div className="cpm-list-header cpm-list-header-inset">
        <HStack justify="between" vAlign="center" gap={2}>
          <Heading level={1}>{tNav("accessLists")}</Heading>
          {/* The phone gets this as a floating button instead. */}
          <Button
            variant="primary"
            size="lg"
            icon={<Plus />}
            label={tCommon("new")}
            onClick={onNew}
            className="cpm-desktop-only"
          />
        </HStack>

        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={t("searchPlaceholder")}
          label={t("searchAccessLists")}
          width="100%"
        />

        <SegmentedControl
          label={t("sortAccessLists")}
          size="sm"
          layout="fill"
          value={sort}
          onChange={(v) => setSort(v as SortKey)}
        >
          {SORT_OPTIONS.map((o) => (
            <SegmentedControlItem key={o.value} value={o.value} label={tRoot(o.labelKey)} />
          ))}
        </SegmentedControl>
      </div>

      {lists.length === 0 ? (
        <EmptyState
          headingLevel={2}
          title={t("noListsTitle")}
          description={t("noListsDescription")}
          isCompact
          actions={<Button variant="ghost" size="sm" label={tCommon("new")} onClick={onNew} />}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          headingLevel={2}
          title={t("noListsMatch", { query })}
          isCompact
          actions={
            <Button
              variant="ghost"
              size="sm"
              label={tCommon("clearSearch")}
              onClick={() => setQuery("")}
            />
          }
        />
      ) : (
        <List>
          {filtered.map((list) => {
            const hostCount = usage[list.id]?.length ?? 0;
            return (
              <ListItem
                key={list.id}
                isSelected={list.id === selectedId}
                startContent={
                  <Icon
                    icon={KeyRound}
                    size="sm"
                    color={list.id === selectedId ? "accent" : "secondary"}
                  />
                }
                label={list.name}
                description={t("listRowDescription", {
                  members: list.entries.length,
                  hosts: hostCount,
                })}
                endContent={
                  // No members outranks unused: it is the one that changes what a host serves.
                  list.entries.length === 0 && list.ipRules.length === 0 ? (
                    <Badge variant="error" label={t("noMembersBadge")} />
                  ) : hostCount === 0 ? (
                    <Badge variant="warning" label={t("unusedBadge")} />
                  ) : undefined
                }
                onClick={() => onSelect(list.id)}
              />
            );
          })}
        </List>
      )}

      {/* At the foot: the totals describe the whole set, not the part in view. */}
      <Text type="supporting" color="secondary">
        {t("railSummary", {
          lists: lists.length,
          members: lists.reduce((sum, list) => sum + list.entries.length, 0),
        })}
      </Text>
    </VStack>
  );
}

// --- Main Client Component ---

export default function AccessListsClient({ lists: initialLists, usage: initialUsage }: Props) {
  const t = useTranslations("accessLists");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const router = useRouter();
  // Before the narrow branch's early return, so the hook order never changes with the width.
  const railWidth = usePersistedPanelWidth("access-lists-rail", {
    defaultWidth: 320,
    minWidth: 240,
    maxWidth: 560,
  });
  const [lists, setLists] = useState(initialLists);
  const [usage, setUsage] = useState(initialUsage);
  const [selectedId, setSelectedId] = useState<number | null>(initialLists[0]?.id ?? null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [newOpen, setNewOpen] = useState(false);
  // A phone has room for the rail or the detail, not both.
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [detailOpen, setDetailOpen] = useState(false);

  useEffect(() => {
    setLists(initialLists);
    setUsage(initialUsage);
  }, [initialLists, initialUsage]);

  const selected = lists.find((l) => l.id === selectedId) ?? null;

  const handleListUpdated = useCallback(
    (updated: AccessList) => {
      setLists((ls) => ls.map((l) => (l.id === updated.id ? updated : l)));
      router.refresh();
    },
    [router],
  );

  const handleDeleted = useCallback(() => {
    setLists((ls) => ls.filter((l) => l.id !== selectedId));
    setSelectedId(lists.find((l) => l.id !== selectedId)?.id ?? null);
    setDetailOpen(false);
    router.refresh();
  }, [selectedId, lists, router]);

  const handleCreated = useCallback(
    (list: AccessList) => {
      setLists((ls) => [list, ...ls]);
      setSelectedId(list.id);
      setDetailOpen(true);
      router.refresh();
    },
    [router],
  );

  // mod+K belongs to the global command palette.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA") return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        setNewOpen(true);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const rail = (onSelect: (id: number) => void) => (
    <ListsRail
      lists={lists}
      selectedId={selectedId}
      onSelect={onSelect}
      onNew={() => setNewOpen(true)}
      query={query}
      setQuery={setQuery}
      sort={sort}
      setSort={setSort}
      usage={usage}
    />
  );

  const newDialog = (
    <NewListDialog open={newOpen} onClose={() => setNewOpen(false)} onCreate={handleCreated} />
  );

  if (isNarrow) {
    return (
      <>
        {detailOpen && selected ? (
          <VStack gap={3} padding={4}>
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={<ArrowLeft />}
                label={tCommon("back")}
                onClick={() => setDetailOpen(false)}
              />
            </div>
            <DetailPane
              list={selected}
              usage={usage[selected.id] ?? []}
              onListUpdated={handleListUpdated}
              onDeleted={handleDeleted}
            />
          </VStack>
        ) : (
          <>
            {rail((id) => {
              setSelectedId(id);
              setDetailOpen(true);
            })}
            <Fab label={tCommon("new")} onClick={() => setNewOpen(true)} />
          </>
        )}
        {newDialog}
      </>
    );
  }

  return (
    <>
      <Layout
        height="fill"
        start={
          <>
            {/* No hasDivider: the handle is the line, and both would paint it. */}
            <LayoutPanel width={railWidth.width} role="navigation" label={tNav("accessLists")}>
              {rail(setSelectedId)}
            </LayoutPanel>
            <PanelResizeHandle label={t("resizeRail")} panel={railWidth} />
          </>
        }
        content={
          <LayoutContent padding={6}>
            <DetailPane
              list={selected}
              usage={usage[selectedId ?? -1] ?? []}
              onListUpdated={handleListUpdated}
              onDeleted={handleDeleted}
            />
          </LayoutContent>
        }
      />

      {newDialog}
    </>
  );
}
