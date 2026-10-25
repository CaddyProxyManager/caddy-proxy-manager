"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { VStack } from "@astryxdesign/core/Stack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { AppDialog } from "@/components/ui/AppDialog";
import type { ActionState } from "@/lib/errors/action-error";
import type { HostChangePreview, HostKind, HostPreviewResult } from "@/lib/host-review/types";
import { EditorIssuesProvider, useEditorIssueTotals } from "./editor-issues";
import { ActiveSectionProvider } from "./editor-section";
import { ReviewChangesDialog } from "./ReviewChangesDialog";
import { useUnsavedChanges } from "./useUnsavedChanges";

export type EditorSectionLink = { id: string; anchor: string };

function scrollToAnchor(anchor: string) {
  document.getElementById(anchor)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * The section at the top of the dialog's scroll area. A jumped-to section stays selected until the
 * user scrolls, since the last ones are too short to reach the top.
 */
function useActiveSection(open: boolean, sections: EditorSectionLink[]) {
  const [active, setActive] = useState(sections[0]?.id ?? "");
  const jumped = useRef<string | null>(null);
  const anchors = sections.map((s) => `${s.id}=${s.anchor}`).join(" ");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `anchors` is the identity of `sections`.
  useEffect(() => {
    if (!open || sections.length < 2) return;
    const root = scrollParent(document.getElementById(sections[0].anchor));
    if (!root) return;
    const update = () => {
      if (jumped.current) return;
      const { top } = root.getBoundingClientRect();
      let current = sections[0].id;
      for (const section of sections) {
        const at = document.getElementById(section.anchor)?.getBoundingClientRect().top;
        if (at !== undefined && at <= top + 1) current = section.id;
      }
      setActive(current);
    };
    const release = () => {
      jumped.current = null;
    };
    const userInput = ["wheel", "touchmove", "keydown"] as const;
    update();
    root.addEventListener("scroll", update, { passive: true });
    for (const type of userInput) root.addEventListener(type, release, { passive: true });
    return () => {
      root.removeEventListener("scroll", update);
      for (const type of userInput) root.removeEventListener(type, release);
    };
  }, [open, anchors]);

  const select = (id: string) => {
    jumped.current = id;
    setActive(id);
  };
  return [active, select] as const;
}

/**
 * Arrow keys across the edge of the section tabs. TabList keeps its arrows to itself and wraps, and
 * Toolbar's roving tabindex leaves the controls after it at -1, so without this a keyboard never
 * reaches them. Runs in the capture phase: preventDefault there makes both components stand aside.
 */
function crossTabStripEdge(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const toolbar = event.currentTarget;
  const rtl = getComputedStyle(toolbar).direction === "rtl";
  const forward = (event.key === "ArrowRight") !== rtl;
  const tabs = [...toolbar.querySelectorAll<HTMLElement>("[data-tab-value]")];
  const controls = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => !button.closest("nav") && !button.disabled,
  );
  if (tabs.length === 0 || controls.length === 0) return;
  const target = event.target as HTMLElement;
  let next: HTMLElement | undefined;
  if (target === tabs.at(forward ? -1 : 0)) next = controls.at(forward ? 0 : -1);
  else if (target === controls.at(forward ? -1 : 0)) next = tabs.at(forward ? 0 : -1);
  if (!next) return;
  event.preventDefault();
  next.focus();
}

/** Ctrl+S, or Cmd+S on a Mac; nothing else. */
function isSaveShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "s"
  );
}

/**
 * An in-app link a plain click follows: the page's editor switches section on one to a section and
 * holds the rest back over unsaved edits. The browser's own beforeunload prompt covers only a
 * reload or another site.
 */
function followedLink(event: MouseEvent): URL | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = (event.target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.download)
    return null;
  const url = new URL(link.href, window.location.href);
  return url.origin === window.location.origin ? url : null;
}

type HostEditorShellProps = {
  /** A dialog over the list, or the whole of the host's edit page. */
  layout?: "dialog" | "page";
  open: boolean;
  onClose: () => void;
  title: string;
  kind: HostKind;
  isCreate: boolean;
  formId: string;
  state: ActionState;
  isPending: boolean;
  preview: (formData: FormData) => Promise<HostPreviewResult>;
  sections: EditorSectionLink[];
  /** The page's address for each section, which it shows one at a time. */
  sectionHref?: (section: string) => string;
  /** The section the page opens on. */
  initialSection?: string | null;
  children: ReactNode;
};

/**
 * The frame every host editor shares: one toolbar with the section jumps, the unsaved-changes
 * count, what the editor's own validators found, and Review changes (also Ctrl/Cmd+S while the
 * editor is open), plus a confirmation before closing over unsaved edits. The review is the only
 * way to save: there is no footer, so every change is read back before it is sent.
 */
export function HostEditorShell(props: HostEditorShellProps) {
  // The provider sits above the frame, since the toolbar reads what the fields report.
  return (
    <EditorIssuesProvider>
      <HostEditorFrame {...props} />
    </EditorIssuesProvider>
  );
}

function HostEditorFrame({
  layout = "dialog",
  open,
  onClose,
  title,
  kind,
  isCreate,
  formId,
  state,
  isPending,
  preview,
  sections,
  sectionHref,
  initialSection = null,
  children,
}: HostEditorShellProps) {
  const t = useTranslations("hostReview");
  const tCommon = useTranslations("common");
  const sectionKey = (id: string) => `sections.${kind}.${id}` as Parameters<typeof t>[0];
  const { changed: unsaved, invalid } = useUnsavedChanges(formId, open);
  const issues = useEditorIssueTotals();
  const errors = issues.errors + invalid;
  const warnings = issues.warnings;

  const [reviewOpen, setReviewOpen] = useState(false);
  const [result, setResult] = useState<HostChangePreview | null>(null);
  const [approval, setApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reverted, setReverted] = useState<string[]>([]);
  const [discardOpen, setDiscardOpen] = useState(false);
  // A link the page's editor held back; followed if the edits are discarded.
  const [leavingTo, setLeavingTo] = useState<string | null>(null);
  const router = useRouter();
  const isPage = layout === "page";
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [pageSection, setPageSection] = useState(initialSection ?? sections[0]?.id ?? "");
  // A hash from an old link names the section only after hydration.
  useEffect(() => {
    if (initialSection) setPageSection(initialSection);
  }, [initialSection]);
  // The action state a save from the review started from; a newer one is that save's answer.
  const submittedFrom = useRef<ActionState | null>(null);
  const request = useRef(0);

  const form = () => document.getElementById(formId) as HTMLFormElement | null;

  const runPreview = async (fields: string[]) => {
    const element = form();
    if (!element) return;
    const data = new FormData(element);
    data.delete("revertField");
    for (const field of fields) data.append("revertField", field);
    const id = ++request.current;
    setIsLoading(true);
    setError(null);
    try {
      const answer = await preview(data);
      if (id !== request.current) return;
      if (answer.ok) {
        setResult(answer.preview);
        setApproval(answer.approval === true);
      } else {
        setResult(null);
        setError(answer.message);
      }
    } finally {
      if (id === request.current) setIsLoading(false);
    }
  };

  const openReview = () => {
    // The browser's own checks first: a review of a form that cannot be sent helps nobody. On the
    // page the field may sit in a hidden section, which the browser cannot point at.
    const element = form();
    if (element && !element.checkValidity()) {
      const invalid = [...element.elements].find(
        (field) => field instanceof HTMLElement && field.matches(":invalid"),
      );
      const holder = sections.find((s) =>
        document.getElementById(s.anchor)?.contains(invalid ?? null),
      );
      if (isPage && holder && holder.id !== pageSection) {
        jump(holder);
        setTimeout(() => form()?.reportValidity(), 50);
      } else {
        element.reportValidity();
      }
      return;
    }
    setReverted([]);
    setResult(null);
    setReviewOpen(true);
    void runPreview([]);
  };

  const closeReview = () => {
    request.current += 1;
    setReviewOpen(false);
    setReverted([]);
    setIsLoading(false);
    submittedFrom.current = null;
  };

  const save = () => {
    submittedFrom.current = state;
    form()?.requestSubmit();
  };

  const changeReverted = (next: string[]) => {
    setReverted(next);
    void runPreview(next);
  };

  // The answer to a save started from the review: close on success, show a refusal in place.
  useEffect(() => {
    if (!reviewOpen || submittedFrom.current === null || state === submittedFrom.current) return;
    submittedFrom.current = null;
    if (state.status === "success") {
      setReviewOpen(false);
      setReverted([]);
    } else if (state.status === "error") {
      setError(state.message ?? null);
    }
  }, [state, reviewOpen]);

  const isDirty = unsaved > 0 && state.status !== "success";

  const requestClose = () => {
    if (isDirty) setDiscardOpen(true);
    else onClose();
  };

  // Capture on the document runs before the router's own handler on the link, so it can stop it. A
  // section is switched in place: navigating would remount the form and drop what was typed.
  const onLinkClick = useRef<(event: MouseEvent) => void>(() => {});
  onLinkClick.current = (event) => {
    const url = followedLink(event);
    if (!url) return;
    const section = sectionHref && sections.find((s) => sectionHref(s.id) === url.pathname);
    if (section) {
      event.preventDefault();
      event.stopPropagation();
      jump(section);
      return;
    }
    const here = url.pathname === window.location.pathname;
    if (!isDirty || (here && url.search === window.location.search)) return;
    event.preventDefault();
    event.stopPropagation();
    setLeavingTo(`${url.pathname}${url.search}${url.hash}`);
    setDiscardOpen(true);
  };
  useEffect(() => {
    if (!isPage) return;
    const onClick = (event: MouseEvent) => onLinkClick.current(event);
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [isPage]);

  // Only while this editor is open, so the browser keeps Ctrl+S everywhere else.
  useEffect(() => {
    if (!open || discardOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      event.preventDefault();
      if (reviewOpen) {
        if (result && !isLoading && !isPending) save();
      } else {
        openReview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!open || unsaved === 0 || state.status === "success") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [open, unsaved, state.status]);

  const [scrolledSection, selectSection] = useActiveSection(open && !isPage, sections);
  const activeSection = isPage ? pageSection : scrolledSection;
  const activeAnchor = sections.find((s) => s.id === pageSection)?.anchor ?? null;
  const isNarrow = useMediaQuery("(max-width: 767px)");

  // Stuck, the page's toolbar paints over the padding above it, which unstuck holds the host's tabs.
  useEffect(() => {
    const bar = toolbarRef.current;
    if (!isPage || !bar) return;
    const root = scrollParent(bar);
    const scroller: HTMLElement | Window = root ?? window;
    const sync = () => {
      const gap = root ? Number.parseFloat(getComputedStyle(root).paddingTop) || 0 : 0;
      const edge = (root?.getBoundingClientRect().top ?? 0) + gap;
      bar.style.setProperty("--cpm-sticky-gap", `${gap}px`);
      bar.toggleAttribute("data-stuck", bar.getBoundingClientRect().top <= edge + 0.5);
    };
    sync();
    scroller.addEventListener("scroll", sync, { passive: true });
    return () => scroller.removeEventListener("scroll", sync);
  }, [isPage]);

  const jump = (section: EditorSectionLink) => {
    if (!isPage) {
      selectSection(section.id);
      scrollToAnchor(section.anchor);
      return;
    }
    setPageSection(section.id);
    if (sectionHref) {
      // Replaced, not pushed: the router would answer Back with a fresh page and lose the edits.
      const url = new URL(window.location.href);
      url.pathname = sectionHref(section.id);
      url.hash = "";
      window.history.replaceState(window.history.state, "", url);
    }
  };

  // A switch made down a long section starts the next one at its top, under the toolbar.
  const switched = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a switch, not on every render.
  useEffect(() => {
    if (!isPage) return;
    if (!switched.current) {
      switched.current = true;
      return;
    }
    if (activeAnchor && toolbarRef.current?.hasAttribute("data-stuck")) {
      document.getElementById(activeAnchor)?.scrollIntoView({ block: "start" });
    }
  }, [pageSection]);

  const toolbar = (
    <Toolbar
      label={t("editorToolbar")}
      size="sm"
      dividers={["bottom"]}
      onKeyDownCapture={crossTabStripEdge}
      startContent={
        sections.length > 1 ? (
          // No role="tablist": in a dialog these scroll to a section, on the page they are links.
          <TabList
            aria-label={t("jumpTo")}
            value={activeSection}
            onChange={(id) => {
              const section = sections.find((s) => s.id === id);
              if (section) jump(section);
            }}
          >
            {sections.map((section) => (
              <Tab
                key={section.id}
                value={section.id}
                label={t(sectionKey(section.id))}
                href={isPage ? sectionHref?.(section.id) : undefined}
              />
            ))}
          </TabList>
        ) : undefined
      }
      endContent={
        <>
          {!isNarrow && (
            <Text
              type="supporting"
              size="sm"
              textWrap="nowrap"
              color={unsaved > 0 ? "primary" : "secondary"}
            >
              {unsaved > 0 ? tCommon("unsavedChanges", { count: unsaved }) : t("noUnsaved")}
            </Text>
          )}
          {/* Each count is its own sentence, so no language has to join them. */}
          {!isNarrow && errors > 0 && (
            <Token size="sm" color="red" label={t("errorsFound", { count: errors })} />
          )}
          {!isNarrow && warnings > 0 && (
            <Token size="sm" color="yellow" label={t("warningsFound", { count: warnings })} />
          )}
          <Button
            // Pink while there is something to save, so the one way out is the one that
            // stands out.
            variant={unsaved > 0 ? "pink" : "secondary"}
            label={tCommon("review")}
            tooltip={t("shortcutHint")}
            // A phone has no room for the counts beside the tabs, so they ride on the button.
            endContent={
              isNarrow && unsaved + errors + warnings > 0 ? (
                <Badge label={unsaved + errors + warnings} />
              ) : undefined
            }
            aria-label={
              isNarrow && unsaved > 0 ? t("reviewUnsaved", { count: unsaved }) : undefined
            }
            onClick={openReview}
            isDisabled={isPending}
          />
        </>
      }
    />
  );

  const content = (
    <VStack gap={4}>
      <ActiveSectionProvider value={isPage ? activeAnchor : null}>{children}</ActiveSectionProvider>
      {reviewOpen &&
        reverted.map((field) => (
          <input key={field} type="hidden" name="revertField" value={field} form={formId} />
        ))}
    </VStack>
  );

  return (
    <>
      {isPage ? (
        <VStack as="section" aria-label={title} gap={4} className="cpm-host-editor-page">
          {/* Sticky, so the section jumps and Review stay in reach down a long form. */}
          <VStack ref={toolbarRef} className="cpm-host-editor-toolbar sticky top-0 z-4 shrink-0">
            {toolbar}
          </VStack>
          {content}
        </VStack>
      ) : (
        <AppDialog
          open={open}
          onClose={requestClose}
          title={title}
          maxWidth="xl"
          subheader={toolbar}
          // No footer: the review is the only way to save, and closing is the header's X.
          actions={null}
        >
          {content}
        </AppDialog>
      )}

      <ReviewChangesDialog
        open={reviewOpen}
        kind={kind}
        isCreate={isCreate}
        preview={result}
        isLoading={isLoading}
        error={error}
        reverted={reverted}
        isSaving={isPending}
        approval={approval}
        onUndo={(field) => changeReverted([...reverted, field])}
        onRestore={(field) => changeReverted(reverted.filter((f) => f !== field))}
        onEditSection={(id) => {
          closeReview();
          const section = sections.find((s) => s.id === id);
          if (section) setTimeout(() => jump(section), 50);
        }}
        onBack={closeReview}
        onSave={save}
      />

      <AlertDialog
        isOpen={discardOpen}
        onOpenChange={(isOpen) => {
          setDiscardOpen(isOpen);
          if (!isOpen) setLeavingTo(null);
        }}
        title={t("discardTitle")}
        description={t("discardDescription", { count: unsaved })}
        actionLabel={t("discardAction")}
        cancelLabel={t("keepEditing")}
        onAction={() => {
          setDiscardOpen(false);
          if (leavingTo) router.push(leavingTo);
          else onClose();
        }}
      />
    </>
  );
}
