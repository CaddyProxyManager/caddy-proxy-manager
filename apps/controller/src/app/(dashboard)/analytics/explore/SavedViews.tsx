"use client";

/**
 * Saved views: a name for the page's current URL state. Picking one navigates to it; the owner can
 * rename it, save the current state over it, share it with every administrator, or delete it.
 */

import { useCallback, useEffect, useState } from "react";
import { Bookmark, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { VStack } from "@astryxdesign/core/Stack";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { NATIVE_REQUIRED } from "@/components/ui/native-input-attrs";
import { useTableDensity } from "@/components/ui/TableDensity";
import type { AnalyticsView } from "@/src/lib/models/analytics-views";
import {
  deleteAnalyticsViewAction,
  listAnalyticsViewsAction,
  saveAnalyticsViewAction,
} from "../actions";

const MAX_NAME = 80;

type Row = AnalyticsView & { [k: string]: unknown };

type Editing = { mode: "create" } | { mode: "rename"; view: AnalyticsView } | null;

export function SavedViews({
  query,
  onOpen,
}: {
  /** The page's current query string, without the question mark. */
  query: string;
  onOpen: (query: string) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const density = useTableDensity();
  const [views, setViews] = useState<AnalyticsView[]>([]);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const result = await listAnalyticsViewsAction();
    if ("views" in result) setViews(result.views);
    else if (result.message) toast.error(result.message);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const linkFor = (view: AnalyticsView) =>
    `${window.location.origin}${window.location.pathname}${view.query ? `?${view.query}` : ""}`;

  async function copyLink(view: AnalyticsView) {
    try {
      await navigator.clipboard.writeText(linkFor(view));
      toast.success(t("viewLinkCopied"));
    } catch {
      // No clipboard over plain http: the link is still the address bar once the view is open.
      toast.error(t("viewLinkCopyFailed"));
    }
  }

  async function save(input: Parameters<typeof saveAnalyticsViewAction>[0]) {
    setSaving(true);
    try {
      const result = await saveAnalyticsViewAction(input);
      if (result.status === "success") {
        toast.success(result.message ?? t("viewSaved", { name: result.view?.name ?? "" }));
        await load();
        return true;
      }
      toast.error(result.message ?? t("viewSaveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function remove(view: AnalyticsView) {
    const result = await deleteAnalyticsViewAction(view.id);
    if (result.status === "success") {
      toast.success(result.message ?? t("viewDeleted"));
      await load();
    } else {
      toast.error(result.message ?? t("viewDeleteFailed"));
    }
  }

  function startCreate() {
    setName("");
    setShared(false);
    setEditing({ mode: "create" });
  }

  function startRename(view: AnalyticsView) {
    setName(view.name);
    setShared(view.shared);
    setEditing({ mode: "rename", view });
  }

  async function submitEditing() {
    if (!editing) return;
    const ok =
      editing.mode === "create"
        ? await save({ name, query, shared })
        : await save({ id: editing.view.id, name, shared });
    if (ok) setEditing(null);
  }

  const columns: TableColumn<Row>[] = [
    {
      key: "name",
      header: tCommon("name"),
      width: proportional(1),
      renderCell: (row) => (
        <VStack gap={0}>
          <Text type="body" size="sm" weight="semibold" maxLines={1}>
            {row.name}
          </Text>
          {!row.own && (
            <Text type="body" size="sm" color="secondary" maxLines={1}>
              {t("viewSharedBy", { name: row.ownerName ?? t("viewUnknownOwner") })}
            </Text>
          )}
        </VStack>
      ),
    },
    {
      key: "shared",
      header: t("viewSharing"),
      width: pixel(110),
      renderCell: (row) =>
        row.shared ? <Token size="sm" color="blue" label={t("viewShared")} /> : null,
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
              label: t("viewOpen"),
              onClick: () => {
                setManaging(false);
                onOpen(row.query);
              },
            },
            { id: "copy", label: t("viewCopyLink"), onClick: () => void copyLink(row) },
            ...(row.own
              ? [
                  {
                    id: "update",
                    label: t("viewUpdate"),
                    onClick: () => void save({ id: row.id, query }),
                  },
                  { id: "rename", label: tCommon("rename"), onClick: () => startRename(row) },
                  {
                    id: "share",
                    label: row.shared ? t("viewUnshare") : t("viewShare"),
                    onClick: () => void save({ id: row.id, shared: !row.shared }),
                  },
                  { type: "divider" as const },
                  {
                    id: "delete",
                    label: tCommon("delete"),
                    variant: "destructive" as const,
                    onClick: () => void remove(row),
                  },
                ]
              : []),
          ]}
        />
      ),
    },
  ];

  return (
    <>
      <DropdownMenu
        alignment="end"
        button={{ variant: "secondary", size: "sm", icon: <Bookmark />, label: tCommon("views") }}
        items={[
          ...views.slice(0, 15).map((view) => ({
            id: `view-${view.id}`,
            label: view.name,
            description: view.own
              ? undefined
              : t("viewSharedBy", { name: view.ownerName ?? t("viewUnknownOwner") }),
            onClick: () => onOpen(view.query),
          })),
          ...(views.length > 0 ? [{ type: "divider" as const }] : []),
          { id: "save", label: t("viewSaveCurrent"), onClick: startCreate },
          { id: "manage", label: t("viewManage"), onClick: () => setManaging(true) },
        ]}
      />

      <AppDialog
        open={managing}
        onClose={() => setManaging(false)}
        title={t("savedViews")}
        maxWidth="lg"
        actions={
          <Button variant="secondary" label={tCommon("close")} onClick={() => setManaging(false)} />
        }
      >
        {views.length === 0 ? (
          <EmptyState
            title={t("viewsEmptyTitle")}
            description={t("viewsEmptyDescription")}
            isCompact
          />
        ) : (
          <Table
            density={density}
            data={views.map((view) => ({ ...view }))}
            columns={columns}
            idKey="id"
            hasHover
          />
        )}
      </AppDialog>

      <AppDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.mode === "rename" ? t("viewRenameTitle") : t("viewSaveTitle")}
        submitLabel={editing?.mode === "rename" ? tCommon("rename") : t("viewSave")}
        onSubmit={() => void submitEditing()}
        isSubmitting={saving}
        isSubmitDisabled={!name.trim() || name.trim().length > MAX_NAME}
      >
        <VStack gap={4}>
          <TextInput
            {...NATIVE_REQUIRED}
            label={tCommon("name")}
            value={name}
            onChange={setName}
            isRequired
            hasAutoFocus
          />
          <CheckboxInput
            label={t("viewShareLabel")}
            description={t("viewShareHelp")}
            value={shared}
            onChange={setShared}
          />
        </VStack>
      </AppDialog>
    </>
  );
}
