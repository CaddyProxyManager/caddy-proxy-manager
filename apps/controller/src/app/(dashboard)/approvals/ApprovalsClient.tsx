"use client";

/**
 * Change approvals: the requests the policy held back, one request's diff and decisions, and the
 * policy itself. Approvers decide, the requester may withdraw, and an administrator may bypass.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { AuditChanges } from "@/components/audit/AuditChanges";
import { HostChangeList, HostImpactSummary } from "@/components/host-review/ReviewChangesDialog";
import { AppDialog } from "@/components/ui/AppDialog";
import { ListPageHeader } from "@/components/ui/ListPageHeader";
import { useTableDensity } from "@/components/ui/TableDensity";
import { Timestamp } from "@/components/ui/Timestamp";
import {
  APPROVAL_AREAS,
  APPROVAL_SCOPES,
  type ApprovalArea,
  type ApprovalPolicy,
  type ApprovalScope,
  BYPASS_REASON_MAX_LENGTH,
  DECISION_NOTE_MAX_LENGTH,
} from "@/src/lib/approvals/policy";
import type { ChangePreview, ChangeRequestView, ChangeStatus } from "@/src/lib/approvals/types";
import { DiffView } from "../settings/StagedChanges";
import {
  approveChangeAction,
  bypassChangeAction,
  rejectChangeAction,
  saveApprovalPolicyAction,
  withdrawChangeAction,
} from "./actions";

type RoleOption = { key: string; name: string | null; builtIn: boolean };
type GroupOption = { id: number; name: string };

const BUILT_IN = ["admin", "operator", "user", "viewer"] as const;
type BuiltIn = (typeof BUILT_IN)[number];

const STATUS_COLOR: Record<ChangeStatus, "blue" | "purple" | "green" | "red" | "gray" | "yellow"> =
  {
    pending: "blue",
    applying: "purple",
    applied: "green",
    failed: "red",
    rejected: "red",
    withdrawn: "gray",
    invalidated: "yellow",
  };

const FILTERS = ["pending", "decided", "all"] as const;
type Filter = (typeof FILTERS)[number];

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useRoleName(roles: readonly RoleOption[]) {
  const tUsers = useTranslations("users");
  return (key: string) => {
    if ((BUILT_IN as readonly string[]).includes(key)) return tUsers(`roles.${key as BuiltIn}`);
    return roles.find((role) => role.key === key)?.name ?? key;
  };
}

/** "Edit proxy host shop", from the kind and the name the target had when submitted. */
export function useChangeTitle() {
  const t = useTranslations("changeApprovals");
  return (request: Pick<ChangeRequestView, "kind" | "targetName" | "targetId" | "id">) =>
    t(`kinds.${request.kind}`, {
      name: request.targetName ?? (request.targetId ? `#${request.targetId}` : ""),
    });
}

export default function ApprovalsClient({
  me,
  requests,
  detail,
  policy,
  policyEnabled,
  canEditPolicy,
  roles,
  groups,
}: {
  me: number;
  requests: ChangeRequestView[];
  detail: ChangeRequestView | null;
  /** Null when the viewer may not read settings. */
  policy: ApprovalPolicy | null;
  policyEnabled: boolean;
  canEditPolicy: boolean;
  roles: RoleOption[];
  groups: GroupOption[];
}) {
  const t = useTranslations("changeApprovals");
  const tNav = useTranslations("nav");
  const [tab, setTab] = useState<"requests" | "policy">("requests");

  if (detail) return <RequestView me={me} request={detail} />;

  return (
    <VStack gap={6}>
      <ListPageHeader
        title={tNav("approvals")}
        filters={
          policy ? (
            <TabList
              role="tablist"
              value={tab}
              onChange={(value) => setTab(value as "requests" | "policy")}
            >
              <Tab value="requests" label={t("tabs.requests")} />
              <Tab value="policy" label={t("tabs.policy")} />
            </TabList>
          ) : undefined
        }
      />
      {tab === "requests" || !policy ? (
        <RequestsTab requests={requests} policyEnabled={policyEnabled} />
      ) : (
        <PolicyTab policy={policy} canEdit={canEditPolicy} roles={roles} groups={groups} />
      )}
    </VStack>
  );
}

function RequestsTab({
  requests,
  policyEnabled,
}: {
  requests: ChangeRequestView[];
  policyEnabled: boolean;
}) {
  const t = useTranslations("changeApprovals");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const density = useTableDensity();
  const title = useChangeTitle();
  const [filter, setFilter] = useState<Filter>("pending");
  const shown = requests.filter((request) =>
    filter === "all"
      ? true
      : filter === "pending"
        ? request.status === "pending"
        : request.status !== "pending",
  );

  type Row = ChangeRequestView & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "change",
      header: tCommon("change"),
      width: proportional(2),
      renderCell: (row) => (
        <VStack gap={0}>
          <Link href={`/approvals?id=${row.id}`}>{title(row)}</Link>
          <Text type="supporting" color="secondary" maxLines={1}>
            {t("requestNumber", { id: row.id })} · {tNav(row.area)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "requester",
      header: t("columns.requester"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" maxLines={1}>
            {row.requestedByName ?? t("unknownUser")}
          </Text>
          {row.viaToken && (
            <Text type="supporting" color="secondary">
              {t("viaToken")}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      key: "status",
      header: tCommon("status"),
      width: pixel(150),
      renderCell: (row) => (
        <Token size="sm" color={STATUS_COLOR[row.status]} label={t(`statuses.${row.status}`)} />
      ),
    },
    {
      key: "approvals",
      header: tNav("approvals"),
      width: pixel(120),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          {t("approvalCount", { approvals: row.approvals, required: row.requiredApprovals })}
        </Text>
      ),
    },
    {
      key: "createdAt",
      header: t("columns.submitted"),
      width: pixel(170),
      renderCell: (row) => <Timestamp value={row.createdAt} style="dateTimeShort" />,
    },
  ];

  return (
    <VStack gap={3}>
      {!policyEnabled && <Banner status="info" title={t("policyOff")} />}
      <HStack>
        <SegmentedControl
          label={tCommon("show")}
          size="sm"
          value={filter}
          onChange={(value) => setFilter(value as Filter)}
        >
          {FILTERS.map((value) => (
            <SegmentedControlItem key={value} value={value} label={t(`filters.${value}`)} />
          ))}
        </SegmentedControl>
      </HStack>
      {shown.length === 0 ? (
        <EmptyState
          title={filter === "pending" ? t("emptyPending") : t("empty")}
          description={t("emptyDescription")}
        />
      ) : (
        <Card padding={0}>
          <Table
            density={density}
            data={shown.map((request) => ({ ...request }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        </Card>
      )}
    </VStack>
  );
}

function PreviewBody({ preview }: { preview: ChangePreview }) {
  const t = useTranslations("changeApprovals");
  const tReview = useTranslations("hostReview");
  const tSettings = useTranslations("settings");
  const tCommon = useTranslations("common");
  if (preview.type === "host") {
    const { changes, impact, kind } = preview.host;
    return (
      <VStack gap={3}>
        <Text type="label" size="lg">
          {tCommon("changeCount", { count: changes.length })}
        </Text>
        {changes.some((change) => change.masked) && (
          <Text type="supporting" size="sm">
            {tReview("maskedNote")}
          </Text>
        )}
        <HostChangeList kind={kind} changes={changes} />
        <Divider />
        <HostImpactSummary kind={kind} impact={impact} />
      </VStack>
    );
  }
  return (
    <VStack gap={3}>
      {preview.changes.length > 0 ? (
        <AuditChanges changes={preview.changes} layout="unified" />
      ) : (
        <Text color="secondary">{t("noFieldChanges")}</Text>
      )}
      {preview.type === "settings" && preview.config && (
        <VStack gap={2}>
          <HStack gap={2} justify="between" vAlign="center">
            <Heading level={3}>{tSettings("reviewTabConfig")}</Heading>
            <Text type="supporting" color="secondary">
              {tSettings("reviewDiffStat", {
                added: preview.config.added,
                removed: preview.config.removed,
              })}
            </Text>
          </HStack>
          {preview.config.unchanged ? (
            <Banner status="info" title={tSettings("reviewNoConfigChange")} />
          ) : (
            <>
              <DiffView lines={preview.config.lines} />
              <Text type="supporting" color="secondary">
                {tSettings("reviewSecretsMasked")}
              </Text>
            </>
          )}
        </VStack>
      )}
    </VStack>
  );
}

type Pending = "approve" | "reject" | "withdraw" | "bypass" | null;

function RequestView({ me, request }: { me: number; request: ChangeRequestView }) {
  const t = useTranslations("changeApprovals");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tNav = useTranslations("nav");
  const tRoles = useTranslations("roles");
  const router = useRouter();
  const title = useChangeTitle();
  const [dialog, setDialog] = useState<Pending>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function open(next: Pending) {
    setNote("");
    setError(null);
    setDialog(next);
  }

  async function run(work: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      setNotice(await work());
      setDialog(null);
      router.refresh();
    } catch (err) {
      setError(message(err, t("actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  const resultText = (status: ChangeStatus) => t(`results.${status}`);
  const failure =
    request.resultCode && tErrors.has(request.resultCode as never)
      ? tErrors(request.resultCode as never)
      : request.error;

  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft />}
            label={tNav("approvals")}
            href="/approvals"
          />
        </HStack>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={1}>{title(request)}</Heading>
          <HStack gap={2} wrap="wrap">
            {request.mayWithdraw && (
              <Button
                size="sm"
                variant="secondary"
                label={t("withdraw")}
                onClick={() => open("withdraw")}
              />
            )}
            {request.mayBypass && (
              <Button
                size="sm"
                variant="secondary"
                label={t("bypass")}
                onClick={() => open("bypass")}
              />
            )}
            {request.mayDecide && (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  label={t("reject")}
                  onClick={() => open("reject")}
                />
                <Button size="sm" label={t("approve")} onClick={() => open("approve")} />
              </>
            )}
          </HStack>
        </HStack>
      </VStack>

      {notice && <Banner status="success" title={notice} />}
      {request.status === "pending" && request.requestedBy === me && (
        <Banner status="info" title={t("waitingOnOthers")} />
      )}
      {(request.status === "failed" || request.status === "invalidated") && failure && (
        <Banner status={request.status === "failed" ? "error" : "warning"} title={failure} />
      )}

      <Card padding={6}>
        <MetadataList>
          <MetadataListItem label={tCommon("status")}>
            <Token
              size="sm"
              color={STATUS_COLOR[request.status]}
              label={t(`statuses.${request.status}`)}
            />
          </MetadataListItem>
          <MetadataListItem label={t("columns.requester")}>
            {request.viaToken
              ? t("requestedWithToken", { name: request.requestedByName ?? t("unknownUser") })
              : (request.requestedByName ?? t("unknownUser"))}
          </MetadataListItem>
          <MetadataListItem label={t("columns.submitted")}>
            <Timestamp value={request.createdAt} style="dateTimeShort" />
          </MetadataListItem>
          <MetadataListItem label={tNav("approvals")}>
            {t("approvalCount", {
              approvals: request.approvals,
              required: request.requiredApprovals,
            })}
          </MetadataListItem>
          <MetadataListItem label={tRoles("area")}>{tNav(request.area)}</MetadataListItem>
          {request.tags.length > 0 && (
            <MetadataListItem label={t("policy.tags")}>
              <HStack gap={1} wrap="wrap">
                {request.tags.map((tag) => (
                  <Token key={tag} size="sm" color="gray" label={tag} />
                ))}
              </HStack>
            </MetadataListItem>
          )}
          {request.bypassReason && (
            <MetadataListItem label={t("bypassedLabel")}>
              {t("bypassedBy", {
                name: request.bypassedByName ?? t("unknownUser"),
                reason: request.bypassReason,
              })}
            </MetadataListItem>
          )}
        </MetadataList>
      </Card>

      <Card padding={6}>
        <VStack gap={3}>
          <Heading level={2}>{t("previewTitle")}</Heading>
          <Text type="supporting" color="secondary">
            {t("previewNote")}
          </Text>
          <PreviewBody preview={request.preview} />
        </VStack>
      </Card>

      <Card padding={6}>
        <VStack gap={3}>
          <Heading level={2}>{t("decisionsTitle")}</Heading>
          {request.decisions.length === 0 ? (
            <Text color="secondary">{t("noDecisions")}</Text>
          ) : (
            <List density="compact" hasDividers>
              {request.decisions.map((decision) => (
                <ListItem
                  key={`${decision.userId}-${decision.createdAt}`}
                  label={t(decision.decision === "approve" ? "approvedBy" : "rejectedBy", {
                    name: decision.userName ?? t("unknownUser"),
                  })}
                  description={decision.note ?? undefined}
                  endContent={<Timestamp value={decision.createdAt} style="dateTimeShort" />}
                />
              ))}
            </List>
          )}
        </VStack>
      </Card>

      {(dialog === "approve" || dialog === "reject") && (
        <AppDialog
          open
          onClose={() => setDialog(null)}
          title={
            dialog === "approve"
              ? t("approveTitle", { id: request.id })
              : t("rejectTitle", { id: request.id })
          }
          maxWidth="md"
          submitLabel={dialog === "approve" ? t("approve") : t("reject")}
          isSubmitting={busy}
          onSubmit={() =>
            void run(async () => {
              if (dialog === "approve")
                return resultText(await approveChangeAction(request.id, note));
              await rejectChangeAction(request.id, note);
              return resultText("rejected");
            })
          }
        >
          <VStack gap={3}>
            {error && <Banner status="error" title={error} />}
            <Text type="body" color="secondary">
              {dialog === "approve"
                ? request.approvals + 1 >= request.requiredApprovals
                  ? t("approveApplies")
                  : t("approveWaits")
                : t("rejectHelp")}
            </Text>
            <TextArea
              label={t("noteLabel")}
              isOptional
              size="sm"
              rows={3}
              maxLength={DECISION_NOTE_MAX_LENGTH}
              value={note}
              onChange={setNote}
            />
          </VStack>
        </AppDialog>
      )}

      {dialog === "withdraw" && (
        <AppDialog
          open
          onClose={() => setDialog(null)}
          title={t("withdrawTitle", { id: request.id })}
          maxWidth="sm"
          submitLabel={t("withdraw")}
          isSubmitting={busy}
          onSubmit={() =>
            void run(async () => {
              await withdrawChangeAction(request.id);
              return resultText("withdrawn");
            })
          }
        >
          <VStack gap={3}>
            {error && <Banner status="error" title={error} />}
            <Text type="body" color="secondary">
              {t("withdrawHelp")}
            </Text>
          </VStack>
        </AppDialog>
      )}

      {dialog === "bypass" && (
        <AppDialog
          open
          onClose={() => setDialog(null)}
          title={t("bypassTitle", { id: request.id })}
          maxWidth="md"
          submitLabel={t("bypass")}
          isSubmitting={busy}
          isSubmitDisabled={note.trim() === ""}
          onSubmit={() =>
            void run(async () => {
              const status = await bypassChangeAction(request.id, note);
              return status === "applied" ? t("bypassApplied") : resultText(status);
            })
          }
        >
          <VStack gap={3}>
            {error && <Banner status="error" title={error} />}
            <Banner status="warning" title={t("bypassHelp")} />
            <TextArea
              label={tCommon("reason")}
              isRequired
              size="sm"
              rows={3}
              maxLength={BYPASS_REASON_MAX_LENGTH}
              value={note}
              onChange={setNote}
            />
          </VStack>
        </AppDialog>
      )}
    </VStack>
  );
}

function PolicyTab({
  policy,
  canEdit,
  roles,
  groups,
}: {
  policy: ApprovalPolicy;
  canEdit: boolean;
  roles: RoleOption[];
  groups: GroupOption[];
}) {
  const t = useTranslations("changeApprovals.policy");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const roleName = useRoleName(roles);
  const [draft, setDraft] = useState<ApprovalPolicy>(policy);
  const [tags, setTags] = useState(policy.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof ApprovalPolicy>(key: K, value: ApprovalPolicy[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const text = await saveApprovalPolicyAction({
        ...draft,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setResult({ ok: true, text });
      router.refresh();
    } catch (err) {
      setResult({ ok: false, text: message(err, t("saveFailed")) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card padding={6}>
      <VStack gap={4} maxWidth={672}>
        <VStack gap={1}>
          <Heading level={2}>{t("title")}</Heading>
          <Text type="supporting" color="secondary">
            {t("description")}
          </Text>
        </VStack>
        {!canEdit && <Banner status="info" title={t("readOnly")} />}
        {result && <Banner status={result.ok ? "success" : "error"} title={result.text} />}
        <Switch
          label={t("enabled")}
          description={t("enabledHelp")}
          value={draft.enabled}
          onChange={(value) => set("enabled", value)}
          isDisabled={!canEdit}
        />
        <Selector
          label={t("scope")}
          size="sm"
          options={APPROVAL_SCOPES.map((value) => ({ value, label: t(`scopes.${value}`) }))}
          value={draft.scope}
          onChange={(value) => set("scope", value as ApprovalScope)}
          description={t(`scopeHelp.${draft.scope}`)}
          isDisabled={!canEdit}
        />
        {draft.scope === "areas" && (
          <MultiSelector
            label={t("areas")}
            size="sm"
            triggerDisplay="labels"
            options={APPROVAL_AREAS.map((value) => ({ value, label: tNav(value) }))}
            value={draft.areas}
            onChange={(next) => set("areas", next as ApprovalArea[])}
            isDisabled={!canEdit}
          />
        )}
        {draft.scope === "tags" && (
          <TextInput
            label={t("tags")}
            description={t("tagsHelp")}
            size="sm"
            value={tags}
            onChange={setTags}
            isDisabled={!canEdit}
          />
        )}
        <MultiSelector
          label={t("approverRoles")}
          description={t("approversHelp")}
          size="sm"
          triggerDisplay="labels"
          options={roles.map((role) => ({ value: role.key, label: roleName(role.key) }))}
          value={draft.approverRoles}
          onChange={(next) => set("approverRoles", next)}
          isDisabled={!canEdit}
        />
        <MultiSelector
          label={t("approverGroups")}
          size="sm"
          triggerDisplay="labels"
          options={groups.map((group) => ({ value: String(group.id), label: group.name }))}
          value={draft.approverGroupIds.map(String)}
          onChange={(next) => set("approverGroupIds", next.map(Number))}
          isDisabled={!canEdit}
        />
        <SegmentedControl
          label={t("requiredApprovals")}
          size="sm"
          value={String(draft.requiredApprovals)}
          onChange={(value) => set("requiredApprovals", value === "2" ? 2 : 1)}
          isDisabled={!canEdit}
        >
          <SegmentedControlItem value="1" label={t("one")} />
          <SegmentedControlItem value="2" label={t("two")} />
        </SegmentedControl>
        <Switch
          label={t("applyToTokens")}
          description={t("applyToTokensHelp")}
          value={draft.applyToTokens}
          onChange={(value) => set("applyToTokens", value)}
          isDisabled={!canEdit}
        />
        {canEdit && (
          <HStack justify="end">
            <Button label={tCommon("save")} onClick={() => void save()} isLoading={saving} />
          </HStack>
        )}
      </VStack>
    </Card>
  );
}
