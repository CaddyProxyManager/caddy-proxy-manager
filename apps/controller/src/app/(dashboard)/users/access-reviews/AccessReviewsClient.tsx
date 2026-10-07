"use client";

/**
 * Access reviews: the campaigns, and one campaign's items. Whoever runs reviews starts, closes,
 * confirms and reassigns; each reviewer decides their own items and sees nobody else's.
 */
import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, MoreHorizontal, Plus } from "lucide-react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import type { ISODateString } from "@astryxdesign/core/Calendar";
import { DateInput } from "@astryxdesign/core/DateInput";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Link } from "@astryxdesign/core/Link";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { AppDialog } from "@/components/ui/AppDialog";
import { useTableDensity } from "@/components/ui/TableDensity";
import {
  type CampaignStatus,
  type Decision,
  type ItemKind,
  REVIEW_SCOPES,
  type ReviewCampaign,
  type ReviewItem,
  type ReviewScope,
  canChange,
  isOverdue,
} from "@/src/lib/access-reviews/model";
import {
  closeAccessReviewAction,
  confirmAccessReviewAction,
  createAccessReviewAction,
  decideAccessReviewItemAction,
  deleteAccessReviewAction,
  reassignAccessReviewItemsAction,
} from "./actions";

type RoleOption = { key: string; name: string | null; builtIn: boolean };
type Person = { id: number; label: string };

const BUILT_IN = ["admin", "operator", "user", "viewer"] as const;
type BuiltIn = (typeof BUILT_IN)[number];

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const STATUS_COLOR: Record<CampaignStatus, "blue" | "yellow" | "purple" | "gray"> = {
  open: "blue",
  applying: "purple",
  confirming: "yellow",
  closed: "gray",
};

const OUTCOME_COLOR: Record<NonNullable<ReviewItem["outcome"]>, "green" | "red" | "gray"> = {
  applied: "green",
  failed: "red",
  gone: "gray",
};

function useRoleName(roles: readonly RoleOption[]) {
  const tUsers = useTranslations("users");
  return (key: string) => {
    if ((BUILT_IN as readonly string[]).includes(key)) return tUsers(`roles.${key as BuiltIn}`);
    return roles.find((role) => role.key === key)?.name ?? key;
  };
}

/** A date-only value, read as the UTC day it names. */
function useDueDate() {
  const format = useFormatter();
  return (dueOn: string) =>
    format.dateTime(new Date(`${dueOn}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
}

export default function AccessReviewsClient({
  me,
  canRead,
  canManage,
  campaigns,
  detail,
  roles,
  people,
  groups,
}: {
  me: number;
  /** Holds users:read: sees every campaign and every item. */
  canRead: boolean;
  /** Holds users:write: starts, closes, confirms, reassigns and deletes. */
  canManage: boolean;
  campaigns: ReviewCampaign[];
  detail: { campaign: ReviewCampaign; items: ReviewItem[] } | null;
  roles: RoleOption[];
  people: Person[];
  groups: { id: number; name: string }[];
}) {
  const t = useTranslations("accessReviews");
  const tNav = useTranslations("nav");
  const [creating, setCreating] = useState(false);

  if (detail) {
    return (
      <CampaignView
        me={me}
        canRead={canRead}
        canManage={canManage}
        campaign={detail.campaign}
        items={detail.items}
        roles={roles}
        people={people}
      />
    );
  }

  return (
    <VStack gap={5}>
      <VStack gap={2}>
        {canRead && (
          <HStack>
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft />}
              label={tNav("users")}
              href="/users"
            />
          </HStack>
        )}
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={1}>{t("title")}</Heading>
          {canManage && (
            <Button
              size="sm"
              icon={<Plus />}
              label={t("start")}
              onClick={() => setCreating(true)}
            />
          )}
        </HStack>
        <Text type="body" color="secondary">
          {canRead ? t("description") : t("reviewerDescription")}
        </Text>
      </VStack>
      {campaigns.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={canManage ? t("emptyDescription") : t("emptyReviewerDescription")}
        />
      ) : (
        <CampaignTable campaigns={campaigns} canManage={canManage} roles={roles} groups={groups} />
      )}
      {creating && (
        <CreateDialog
          roles={roles}
          people={people}
          groups={groups}
          onClose={() => setCreating(false)}
        />
      )}
    </VStack>
  );
}

function useScopeLabel(
  roles: readonly RoleOption[],
  groups: readonly { id: number; name: string }[],
) {
  const t = useTranslations("accessReviews");
  const roleName = useRoleName(roles);
  return (campaign: ReviewCampaign) => {
    if (campaign.scope === "role" && campaign.scopeRef) {
      return t("scopeRoleNamed", { role: roleName(campaign.scopeRef) });
    }
    if (campaign.scope === "group" && campaign.scopeRef) {
      const group = groups.find((entry) => String(entry.id) === campaign.scopeRef);
      return t("scopeGroupNamed", { group: group?.name ?? `#${campaign.scopeRef}` });
    }
    return t(`scopes.${campaign.scope}`);
  };
}

function CampaignTable({
  campaigns,
  canManage,
  roles,
  groups,
}: {
  campaigns: ReviewCampaign[];
  canManage: boolean;
  roles: RoleOption[];
  groups: { id: number; name: string }[];
}) {
  const t = useTranslations("accessReviews");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const density = useTableDensity();
  const dueDate = useDueDate();
  const scopeLabel = useScopeLabel(roles, groups);
  const [deleting, setDeleting] = useState<ReviewCampaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  type Row = ReviewCampaign & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Link href={`/users/access-reviews?id=${row.id}`}>{row.name}</Link>
          <Text type="supporting" color="secondary" maxLines={1}>
            {scopeLabel(row)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "due",
      header: t("due"),
      width: pixel(180),
      renderCell: (row) => (
        <HStack gap={1} vAlign="center" wrap="wrap">
          <Text type="body" size="sm">
            {dueDate(row.dueOn)}
          </Text>
          {row.status === "open" && isOverdue(row.dueOn) && (
            <Token size="sm" color="red" label={t("overdue")} />
          )}
        </HStack>
      ),
    },
    {
      key: "status",
      header: tCommon("status"),
      width: pixel(190),
      renderCell: (row) => (
        <Token size="sm" color={STATUS_COLOR[row.status]} label={t(`statuses.${row.status}`)} />
      ),
    },
    {
      key: "progress",
      header: t("progressHeader"),
      width: pixel(160),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary">
          {t("progress", { decided: row.counts.decided, total: row.counts.total })}
        </Text>
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(56),
      align: "end",
      renderCell: (row) => (
        <DropdownMenu
          hasChevron={false}
          alignment="end"
          button={{
            variant: "ghost",
            icon: <MoreHorizontal />,
            label: tCommon("actionsFor", { name: row.name }),
            isIconOnly: true,
          }}
          items={[
            {
              id: "open",
              label: tCommon("view"),
              onClick: () => router.push(`/users/access-reviews?id=${row.id}`),
            },
            ...(canManage
              ? [
                  { type: "divider" as const },
                  {
                    id: "delete",
                    label: tCommon("delete"),
                    variant: "destructive" as const,
                    onClick: () => setDeleting(row),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  return (
    <VStack gap={3}>
      {error && <Banner status="error" title={t("actionFailed")} description={error} />}
      <Card padding={0}>
        <Table
          density={density}
          data={campaigns.map((campaign) => ({ ...campaign }))}
          columns={columns}
          idKey="id"
          hasHover
        />
      </Card>
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => !isOpen && setDeleting(null)}
        title={deleting ? t("deleteTitle", { name: deleting.name }) : ""}
        description={t("deleteConfirm")}
        actionLabel={tCommon("delete")}
        onAction={() => {
          const target = deleting;
          setDeleting(null);
          if (!target) return;
          setError(null);
          deleteAccessReviewAction(target.id)
            .catch((err: unknown) => setError(message(err, t("actionFailed"))))
            .finally(() => router.refresh());
        }}
      />
    </VStack>
  );
}

function CreateDialog({
  roles,
  people,
  groups,
  onClose,
}: {
  roles: RoleOption[];
  people: Person[];
  groups: { id: number; name: string }[];
  onClose: () => void;
}) {
  const t = useTranslations("accessReviews");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const roleName = useRoleName(roles);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ReviewScope>("allUsers");
  const [scopeRole, setScopeRole] = useState<string>("");
  const [scopeGroup, setScopeGroup] = useState<string>("");
  const [dueOn, setDueOn] = useState<string | undefined>(undefined);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopeRef = scope === "role" ? scopeRole : scope === "group" ? scopeGroup : null;
  const ready =
    name.trim() !== "" &&
    dueOn !== undefined &&
    reviewers.length > 0 &&
    (scopeRef === null || scopeRef !== "");

  async function save() {
    if (!dueOn) return;
    setSaving(true);
    setError(null);
    try {
      const id = await createAccessReviewAction({
        name,
        scope,
        scopeRef,
        dueOn,
        reviewerIds: reviewers.map(Number),
      });
      onClose();
      router.push(`/users/access-reviews?id=${id}`);
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t("newTitle")}
      maxWidth="md"
      submitLabel={tCommon("create")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!ready}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        <TextInput label={tCommon("name")} isRequired size="sm" value={name} onChange={setName} />
        <Selector
          label={t("scope")}
          size="sm"
          options={REVIEW_SCOPES.map((value) => ({ value, label: t(`scopes.${value}`) }))}
          value={scope}
          onChange={(value) => setScope(value as ReviewScope)}
          description={t(`scopeHelp.${scope}`)}
        />
        {scope === "role" && (
          <Selector
            label={tCommon("role")}
            size="sm"
            isRequired
            options={roles.map((role) => ({ value: role.key, label: roleName(role.key) }))}
            value={scopeRole || undefined}
            onChange={setScopeRole}
          />
        )}
        {scope === "group" && (
          <Selector
            label={t("group")}
            size="sm"
            isRequired
            options={groups.map((group) => ({ value: String(group.id), label: group.name }))}
            value={scopeGroup || undefined}
            onChange={setScopeGroup}
          />
        )}
        <DateInput
          label={t("due")}
          isRequired
          size="sm"
          min={new Date().toISOString().slice(0, 10) as ISODateString}
          value={dueOn as ISODateString | undefined}
          onChange={(value) => setDueOn(value)}
          description={t("dueHelp")}
        />
        <MultiSelector
          label={t("reviewers")}
          size="sm"
          triggerDisplay="labels"
          isRequired
          options={people.map((person) => ({ value: String(person.id), label: person.label }))}
          value={reviewers}
          onChange={setReviewers}
          description={t("reviewersHelp")}
        />
      </VStack>
    </AppDialog>
  );
}

function CampaignView({
  me,
  canRead,
  canManage,
  campaign,
  items,
  roles,
  people,
}: {
  me: number;
  canRead: boolean;
  canManage: boolean;
  campaign: ReviewCampaign;
  items: ReviewItem[];
  roles: RoleOption[];
  people: Person[];
}) {
  const t = useTranslations("accessReviews");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const density = useTableDensity();
  const dueDate = useDueDate();
  const roleName = useRoleName(roles);
  const [deciding, setDeciding] = useState<ReviewItem | null>(null);
  const [reassigning, setReassigning] = useState<ReviewItem | null>(null);
  const [confirming, setConfirming] = useState<"close" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = campaign.status === "open";
  const revocations = items.filter(
    (item) =>
      (item.decision === "revoke" || item.decision === "change") &&
      (item.outcome === null || item.outcome === "failed"),
  ).length;
  const failed = items.filter((item) => item.outcome === "failed").length;

  function access(item: ReviewItem): string {
    switch (item.kind) {
      case "role":
        return roleName(item.current ?? "");
      case "membership":
        return item.targetLabel ?? "";
      case "grant":
        return t("grantOn", {
          object: item.targetLabel ?? "",
          level: item.current === "manage" ? "manage" : "view",
        });
      case "token":
        return t("ownedBy", { owner: item.targetLabel ?? "" });
      case "scimConnection":
        return t(item.current === "disabled" ? "connectionOff" : "connectionOn");
    }
  }

  function decisionText(item: ReviewItem): string {
    if (item.decision === null) return t("undecided");
    if (item.decision === "change" && item.changeTo) {
      return t("changedTo", {
        to:
          item.kind === "role"
            ? roleName(item.changeTo)
            : t(`levels.${item.changeTo === "manage" ? "manage" : "view"}`),
      });
    }
    return t(`decisions.${item.decision}`);
  }

  async function run(work: () => Promise<void>) {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(message(err, t("actionFailed")));
    } finally {
      router.refresh();
    }
  }

  type Row = ReviewItem & { [key: string]: unknown };
  const columns: TableColumn<Row>[] = [
    {
      key: "subject",
      header: t("subject"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold" maxLines={1}>
            {row.subjectLabel}
          </Text>
          <Text type="supporting" color="secondary">
            {t(`kinds.${row.kind}`)}
          </Text>
        </VStack>
      ),
    },
    {
      key: "access",
      header: t("access"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={1}>
          <Text type="body" size="sm" maxLines={2}>
            {access(row)}
          </Text>
          <HStack gap={1} wrap="wrap">
            {row.hints.map((hint) => (
              <Token key={hint} size="sm" color="yellow" label={t(`hints.${hint}`)} />
            ))}
            {row.scimManaged && <Token size="sm" color="purple" label={t("scimManaged")} />}
          </HStack>
        </VStack>
      ),
    },
    {
      key: "reviewer",
      header: t("reviewer"),
      width: pixel(160),
      renderCell: (row) => (
        <Text type="body" size="sm" color="secondary" maxLines={1}>
          {row.reviewerId === me ? t("you") : (row.reviewerLabel ?? t("unassigned"))}
        </Text>
      ),
    },
    {
      key: "decision",
      header: t("decision"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight={row.decision ? "semibold" : undefined}>
            {decisionText(row)}
          </Text>
          {row.note && (
            <Text type="supporting" color="secondary" maxLines={2}>
              {row.note}
            </Text>
          )}
          {row.outcome && (
            <HStack gap={1} vAlign="center" wrap="wrap">
              <Token
                size="sm"
                color={OUTCOME_COLOR[row.outcome]}
                label={t(`outcomes.${row.outcome}`)}
              />
              {row.outcome === "failed" && row.outcomeCode && (
                <Text type="supporting" color="secondary" maxLines={2}>
                  {tErrors.has(row.outcomeCode as never)
                    ? tErrors(row.outcomeCode as never)
                    : row.outcomeCode}
                </Text>
              )}
            </HStack>
          )}
        </VStack>
      ),
    },
    {
      key: "actions",
      header: <VisuallyHidden>{tCommon("actions")}</VisuallyHidden>,
      width: pixel(150),
      align: "end",
      renderCell: (row) => {
        const mine = open && row.reviewerId === me;
        if (!mine && !(open && canManage)) return null;
        return (
          <HStack gap={1} justify="end">
            {mine && (
              <Button
                size="sm"
                variant="secondary"
                label={t("decide")}
                onClick={() => setDeciding(row)}
              />
            )}
            {open && canManage && (
              <DropdownMenu
                hasChevron={false}
                alignment="end"
                button={{
                  variant: "ghost",
                  icon: <MoreHorizontal />,
                  label: tCommon("actionsFor", { name: row.subjectLabel }),
                  isIconOnly: true,
                }}
                items={[
                  { id: "reassign", label: t("reassign"), onClick: () => setReassigning(row) },
                ]}
              />
            )}
          </HStack>
        );
      },
    },
  ];

  return (
    <VStack gap={5}>
      <VStack gap={2}>
        <HStack>
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft />}
            label={t("title")}
            href="/users/access-reviews"
          />
        </HStack>
        <HStack justify="between" vAlign="center" gap={2} wrap="wrap">
          <Heading level={1}>{campaign.name}</Heading>
          <HStack gap={2} wrap="wrap">
            {canRead && (
              <Button
                size="sm"
                variant="secondary"
                icon={<Download />}
                label={t("export")}
                href={`/api/access-reviews/${campaign.id}/export`}
              />
            )}
            {canManage && open && (
              <Button size="sm" label={tCommon("close")} onClick={() => setConfirming("close")} />
            )}
            {canManage && campaign.status === "confirming" && (
              <Button size="sm" label={t("confirm")} onClick={() => setConfirming("confirm")} />
            )}
          </HStack>
        </HStack>
      </VStack>
      {error && <Banner status="error" title={t("actionFailed")} description={error} />}
      {campaign.status === "confirming" && (
        <Banner
          status="warning"
          title={failed > 0 ? t("failedTitle", { count: failed }) : t("confirmingTitle")}
          description={failed > 0 ? t("failedDescription") : t("confirmingDescription")}
        />
      )}
      <Card>
        <MetadataList>
          <MetadataListItem label={tCommon("status")}>
            <Token
              size="sm"
              color={STATUS_COLOR[campaign.status]}
              label={t(`statuses.${campaign.status}`)}
            />
          </MetadataListItem>
          <MetadataListItem label={t("due")}>
            {open && isOverdue(campaign.dueOn)
              ? t("dueOverdue", { date: dueDate(campaign.dueOn) })
              : dueDate(campaign.dueOn)}
          </MetadataListItem>
          <MetadataListItem label={t("scope")}>{t(`scopes.${campaign.scope}`)}</MetadataListItem>
          <MetadataListItem label={t("reviewers")}>
            {campaign.reviewers.map((reviewer) => reviewer.label).join(", ") || t("unassigned")}
          </MetadataListItem>
          <MetadataListItem label={t("progressHeader")}>
            {t("progress", { decided: campaign.counts.decided, total: campaign.counts.total })}
          </MetadataListItem>
        </MetadataList>
      </Card>
      {items.length === 0 ? (
        <EmptyState title={t("noItemsTitle")} description={t("emptyReviewerDescription")} />
      ) : (
        <Card padding={0}>
          <Table
            density={density}
            data={items.map((item) => ({ ...item }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        </Card>
      )}

      {deciding && (
        <DecideDialog
          item={deciding}
          roles={roles}
          onClose={() => setDeciding(null)}
          onSaved={() => router.refresh()}
        />
      )}
      {reassigning && (
        <ReassignDialog
          campaignId={campaign.id}
          item={reassigning}
          people={people}
          onClose={() => setReassigning(null)}
          onSaved={() => router.refresh()}
        />
      )}
      <AlertDialog
        isOpen={confirming !== null}
        onOpenChange={(isOpen) => !isOpen && setConfirming(null)}
        title={
          confirming === "confirm"
            ? t("confirmTitle", { name: campaign.name })
            : t("closeTitle", { name: campaign.name })
        }
        description={
          confirming === "confirm"
            ? t("confirmDescription", { count: revocations })
            : t("closeDescription", {
                count: revocations,
                undecided: campaign.counts.total - campaign.counts.decided,
              })
        }
        actionLabel={confirming === "confirm" ? t("confirm") : tCommon("close")}
        onAction={() => {
          const what = confirming;
          setConfirming(null);
          void run(() =>
            what === "confirm"
              ? confirmAccessReviewAction(campaign.id)
              : closeAccessReviewAction(campaign.id),
          );
        }}
      />
    </VStack>
  );
}

function DecideDialog({
  item,
  roles,
  onClose,
  onSaved,
}: {
  item: ReviewItem;
  roles: RoleOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("accessReviews");
  const tCommon = useTranslations("common");
  const roleName = useRoleName(roles);
  const [decision, setDecision] = useState<Decision>(item.decision ?? "keep");
  const [changeTo, setChangeTo] = useState<string>(item.changeTo ?? "");
  const [note, setNote] = useState(item.note ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind: ItemKind = item.kind;
  const changeOptions =
    kind === "role"
      ? roles
          .filter((role) => role.key !== item.current)
          .map((role) => ({ value: role.key, label: roleName(role.key) }))
      : (["view", "manage"] as const)
          .filter((level) => level !== item.current)
          .map((level) => ({ value: level, label: t(`levels.${level}`) }));
  const revokeBlocked = item.scimManaged && (kind === "role" || kind === "membership");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await decideAccessReviewItemAction(item.id, {
        decision,
        changeTo: decision === "change" ? changeTo : null,
        note,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t("decideTitle", { subject: item.subjectLabel })}
      maxWidth="md"
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={
        (decision === "change" && !changeTo) || (decision === "revoke" && revokeBlocked)
      }
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        {revokeBlocked && (
          <Banner status="info" title={t("scimManaged")} description={t("scimManagedHelp")} />
        )}
        <SegmentedControl
          label={t("decision")}
          size="sm"
          layout="fill"
          value={decision}
          onChange={(value) => setDecision(value as Decision)}
        >
          <SegmentedControlItem value="keep" label={t("decisions.keep")} />
          <SegmentedControlItem value="revoke" label={t("decisions.revoke")} />
          {canChange(kind) && <SegmentedControlItem value="change" label={t("decisions.change")} />}
        </SegmentedControl>
        {decision === "revoke" && !revokeBlocked && (
          <Text type="supporting">{t(`revokeHelp.${kind}`)}</Text>
        )}
        {decision === "change" && (
          <Selector
            label={t("changeTo")}
            size="sm"
            isRequired
            options={changeOptions}
            value={changeTo || undefined}
            onChange={setChangeTo}
          />
        )}
        <TextArea label={t("note")} isOptional size="sm" rows={3} value={note} onChange={setNote} />
      </VStack>
    </AppDialog>
  );
}

function ReassignDialog({
  campaignId,
  item,
  people,
  onClose,
  onSaved,
}: {
  campaignId: number;
  item: ReviewItem;
  people: Person[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("accessReviews");
  const tCommon = useTranslations("common");
  const [reviewer, setReviewer] = useState<string>(item.reviewerId ? String(item.reviewerId) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Nobody reviews their own access.
  const owner = item.kind === "grant" || item.kind === "scimConnection" ? null : item.userId;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await reassignAccessReviewItemsAction(campaignId, [item.id], Number(reviewer));
      onSaved();
      onClose();
    } catch (err) {
      setError(message(err, t("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppDialog
      open
      onClose={onClose}
      title={t("reassignTitle", { subject: item.subjectLabel })}
      submitLabel={tCommon("save")}
      onSubmit={() => void save()}
      isSubmitting={saving}
      isSubmitDisabled={!reviewer}
    >
      <VStack gap={3}>
        {error && <Banner status="error" title={t("saveFailed")} description={error} />}
        <Selector
          label={t("reviewer")}
          size="sm"
          isRequired
          options={people
            .filter((person) => person.id !== owner)
            .map((person) => ({ value: String(person.id), label: person.label }))}
          value={reviewer || undefined}
          onChange={setReviewer}
        />
      </VStack>
    </AppDialog>
  );
}
