"use client";

/**
 * The frame a settings page's blocks render in. Each block keeps its own form and server action;
 * one page-level bar replaces the per-card Save buttons and submits whichever were edited.
 */

import { HEADER_HEIGHT_VAR } from "./sections";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { EnvTokens } from "@/src/components/ui/EnvTokens";
import { type SettingsBlock, settingsBlockName } from "./sections";

/**
 * A form the page bar must not submit (it confirms first, or does more than save). An attribute,
 * because the bar finds forms in the DOM, not through React.
 */
export const SKIP_PAGE_SAVE = { "data-page-save": "off" } as const;

export function SettingsBlockShell({
  block,
  showHeading,
  children,
}: {
  block: SettingsBlock;
  /** False on a page of one block: the page's own title already names it. */
  showHeading: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("settings");
  return (
    // Anchor for legacy links and the side list; scroll-margin clears the sticky header.
    <VStack
      gap={3}
      id={block.id}
      // The dirty tracker keys baselines on this; ids also appear on design-system elements.
      data-settings-block={block.id}
      // Inline: the header height is measured and published at runtime under a JS-named variable.
      style={{
        scrollMarginTop: `calc(var(${HEADER_HEIGHT_VAR}, 0px) + var(--spacing-5))`,
      }}
    >
      {showHeading ? (
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Heading level={2}>{settingsBlockName(t, block.id)}</Heading>
          <EnvTokens names={block.env} />
        </HStack>
      ) : (
        <EnvTokens names={block.env} />
      )}
      {children}
    </VStack>
  );
}

/**
 * Focuses the control a `?field=` link from the review sheet names. By field name, because the
 * design system generates ids and the name is what the change was recorded under.
 */
export function FocusField() {
  const params = useSearchParams();
  const field = params.get("field");

  useEffect(() => {
    if (!field) return;
    // A frame later: blocks fill their fields on mount.
    const frame = requestAnimationFrame(() => {
      const control = document.querySelector<HTMLElement>(`[name="${CSS.escape(field)}"]`);
      if (!control) return;
      control.scrollIntoView({ block: "center", behavior: "smooth" });
      control.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [field]);

  return null;
}

export type PageAnchor = { id: string; label: string };

/** The nearest ancestor that scrolls: the content pane, not the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

/**
 * Only from three blocks up. Follows the scroll: the current block is the last whose top has
 * reached the header. A clicked entry holds until its jump settles, or the blocks it passes on
 * the way would flicker through the list.
 */
export function OnThisPage({ anchors }: { anchors: readonly PageAnchor[] }) {
  const t = useTranslations("settings");
  const [current, setCurrent] = useState<string | null>(null);
  const heldUntil = useRef(0);

  useEffect(() => {
    const first = anchors[0] && document.getElementById(anchors[0].id);
    if (!first) return;
    const scroller = scrollParent(first);
    const target: HTMLElement | Window = scroller ?? window;

    let frame = 0;
    const update = () => {
      frame = 0;
      if (performance.now() < heldUntil.current) return;
      const header = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(HEADER_HEIGHT_VAR),
      );
      const top = (scroller?.getBoundingClientRect().top ?? 0) + (header || 0);
      // A few pixels of slack: a jump lands the block a margin below the header, not on it.
      const line = top + 32;
      let next: string | null = anchors[0].id;
      for (const anchor of anchors) {
        const element = document.getElementById(anchor.id);
        if (element && element.getBoundingClientRect().top <= line) next = anchor.id;
      }
      // Short last blocks never reach the line; at the bottom, the last one is what is in view.
      const atBottom = scroller
        ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
        : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      if (atBottom && (scroller?.scrollTop ?? window.scrollY) > 0) {
        next = anchors[anchors.length - 1].id;
      }
      setCurrent(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // A jump's end releases the hold at once, rather than waiting out the timeout.
    const onScrollEnd = () => {
      heldUntil.current = 0;
    };

    update();
    target.addEventListener("scroll", onScroll, { passive: true });
    target.addEventListener("scrollend", onScrollEnd);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", onScroll);
      target.removeEventListener("scrollend", onScrollEnd);
    };
  }, [anchors]);

  return (
    <nav
      aria-label={t("onThisPage")}
      // A phone has no room for it beside the blocks.
      className="cpm-desktop-only sticky w-44 shrink-0"
      // The frame's padding again, so it does not jump up to the header once it sticks.
      style={{ top: `calc(var(${HEADER_HEIGHT_VAR}, 0px) + var(--spacing-5))` }}
    >
      <VStack gap={1}>
        <Text type="label" size="sm" color="secondary">
          {t("onThisPage")}
        </Text>
        {anchors.map((anchor) => (
          <a
            key={anchor.id}
            href={`#${anchor.id}`}
            onClick={(event) => {
              setCurrent(anchor.id);
              // Until the jump lands; scrollend clears it sooner where the browser has it.
              heldUntil.current = performance.now() + 1000;
              const target = document.getElementById(anchor.id);
              if (!target) return;
              // Scrolled here: the router's hash jump scrolls the window, and the content pane is
              // the scroller. scrollIntoView honours the block's header-clearing scroll-margin.
              event.preventDefault();
              target.scrollIntoView({ behavior: "smooth" });
              window.history.replaceState(window.history.state, "", `#${anchor.id}`);
            }}
            className={`block border-s-2 px-2 py-1 text-sm no-underline ${
              current === anchor.id
                ? "border-(--color-border-accent) text-primary"
                : "border-border text-secondary"
            }`}
          >
            {anchor.label}
          </a>
        ))}
      </VStack>
    </nav>
  );
}

/**
 * Block id plus position. Not the element (React can replace the node and drop the baseline) and
 * not its fields (a form that reveals a field would look like a new form and lose its baseline).
 */
function formKey(form: HTMLFormElement): string {
  const block = form.closest("[data-settings-block]");
  if (!block) return "";
  const forms = [...block.querySelectorAll("form")];
  return `${block.getAttribute("data-settings-block")}#${forms.indexOf(form)}`;
}

function controlValues(form: HTMLFormElement): Map<Element, string> {
  const values = new Map<Element, string>();
  for (const element of form.elements) {
    const control = element as HTMLInputElement;
    // $ACTION* inputs are React's bookkeeping, not settings.
    if (!control.name || control.name.startsWith("$ACTION")) continue;
    if (control.type === "file") {
      const file = control.files?.[0];
      values.set(control, file ? `${file.name}:${file.size}` : "");
    } else if (control.type === "checkbox" || control.type === "radio") {
      values.set(control, String(control.checked));
    } else {
      values.set(control, control.value ?? "");
    }
  }
  return values;
}

/** Keyed by field name, which survives a re-render. */
function valuesByName(form: HTMLFormElement): Map<string, string> {
  const values = new Map<string, string>();
  for (const [control, value] of controlValues(form)) {
    values.set((control as HTMLInputElement).name, value);
  }
  return values;
}

/** The smallest ancestor holding a label; marking it lets one CSS rule reach any control's box. */
function fieldOf(control: Element, form: HTMLFormElement): Element | null {
  for (let node = control.parentElement; node && node !== form; node = node.parentElement) {
    if (node.querySelector("label")) return node;
  }
  return null;
}

/**
 * All labels for its id (EnvLabelledField draws two). A switch's hidden input has no id, so it
 * takes the labels of its nearest labelled ancestor.
 */
function labelsFor(control: Element, form: HTMLFormElement): Element[] {
  const id = (control as HTMLInputElement).id;
  if (id) {
    const byId = [...form.querySelectorAll(`label[for="${CSS.escape(id)}"]`)];
    if (byId.length > 0) return byId;
  }
  for (let node = control.parentElement; node && node !== form; node = node.parentElement) {
    const labels = [...node.querySelectorAll("label")];
    if (labels.length > 0) return labels;
  }
  return [];
}

/**
 * Marks labels and fields as unsaved in the DOM, since design-system labels take no such prop.
 * Collected before writing: a hidden input borrows a neighbour's labels, and clearing as it went
 * wiped the mark the neighbour had just earned.
 */
function markUnsaved(
  form: HTMLFormElement,
  baseline: Map<string, string>,
  staged: ReadonlySet<string>,
): void {
  const labels = new Set<Element>();
  const fields = new Set<Element>();
  for (const [control, value] of controlValues(form)) {
    const before = baseline.get((control as HTMLInputElement).name);
    // Staged-but-unapplied fields match their own baseline on load, hence the separate set.
    const unsaved =
      staged.has((control as HTMLInputElement).name) || (before !== undefined && before !== value);
    if (!unsaved) continue;
    // A hidden input standing for several fields at once; its visible controls mark themselves.
    if (control.getAttribute("data-unsaved-label") === "none") continue;
    for (const label of labelsFor(control, form)) labels.add(label);
    const field = fieldOf(control, form);
    if (field) fields.add(field);
  }

  for (const label of form.querySelectorAll("label")) {
    if (labels.has(label)) label.setAttribute("data-unsaved", "true");
    else label.removeAttribute("data-unsaved");
  }
  for (const field of form.querySelectorAll("[data-unsaved-field]")) {
    if (!fields.has(field)) field.removeAttribute("data-unsaved-field");
  }
  for (const field of fields) field.setAttribute("data-unsaved-field", "true");
}

function serializeForm(form: HTMLFormElement): string {
  const entries: string[] = [];
  for (const [key, value] of new FormData(form)) {
    entries.push(`${key}=${typeof value === "string" ? value : `${value.name}:${value.size}`}`);
  }
  return entries.join("\n");
}

/**
 * `useFormDirty` for every form on the page. Checked a frame after each event, because a switch
 * writes its hidden input from React state after the click.
 */
function useDirtyForms(
  container: RefObject<HTMLElement | null>,
  staged: ReadonlySet<string>,
): {
  dirty: HTMLFormElement[];
  /** Take what the forms hold now as the saved state. */
  accept: () => void;
} {
  const [dirty, setDirty] = useState<HTMLFormElement[]>([]);
  // A ref: the baselines live in the effect's closure.
  const accept = useRef(() => {});

  useEffect(() => {
    const root = container.current;
    if (!root) return;

    // A form the bar may not submit still has fields worth marking.
    const forms = () => [...root.querySelectorAll("form")];
    const saveable = () => forms().filter((form) => form.getAttribute("data-page-save") !== "off");
    // Keyed by formKey so a form React re-creates keeps its baseline.
    const baselines = new Map<string, string>();
    const fieldBaselines = new Map<string, Map<string, string>>();
    let frame = 0;

    const rebaseline = () => {
      for (const form of forms()) {
        const key = formKey(form);
        baselines.set(key, serializeForm(form));
        fieldBaselines.set(key, valuesByName(form));
        markUnsaved(form, valuesByName(form), staged);
      }
    };
    // A frame later, once fields have filled themselves on mount.
    const baselineFrame = requestAnimationFrame(() => {
      rebaseline();
      setDirty([]);
    });

    accept.current = () => {
      cancelAnimationFrame(frame);
      rebaseline();
      setDirty([]);
    };

    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setDirty((previous) => {
          for (const form of forms()) {
            const key = formKey(form);
            // Rendered after the first frame: unedited, so what it holds now is its baseline.
            let fields = fieldBaselines.get(key);
            if (!fields) {
              fields = valuesByName(form);
              fieldBaselines.set(key, fields);
              baselines.set(key, serializeForm(form));
            }
            markUnsaved(form, fields, staged);
          }
          const next = saveable().filter((form) => {
            const baseline = baselines.get(formKey(form));
            return baseline !== undefined && serializeForm(form) !== baseline;
          });
          // Same set, same array: a new one every frame would rerender the bar continuously.
          const same =
            next.length === previous.length && next.every((form, i) => form === previous[i]);
          return same ? previous : next;
        });
      });
    };

    const observer = new MutationObserver(check);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["value", "checked"],
    });
    const events = ["input", "change", "click", "keyup"] as const;
    for (const type of events) root.addEventListener(type, check);
    // React resets a form once its action has run, so what it holds then is the saved state.
    root.addEventListener("reset", () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        rebaseline();
        setDirty([]);
      });
    });

    return () => {
      cancelAnimationFrame(baselineFrame);
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const type of events) root.removeEventListener(type, check);
    };
  }, [container, staged]);

  return { dirty, accept: () => accept.current() };
}

/**
 * Holds the page while something is unsaved: the browser's own prompt for a reload, close or
 * another site, and a dialog for an in-app link, which `beforeunload` never sees. Back and forward
 * stay unguarded, since the App Router offers no way to cancel a history step.
 */
function useLeaveGuard(active: boolean) {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  // Set by the bar's own Discard, which reloads on purpose.
  const allowUnload = useRef(false);

  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!allowUnload.current) event.preventDefault();
    };
    // Capture, so it runs before Next's Link handler on the React root.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return;
      if (link.target && link.target !== "_self") return;
      const url = new URL(link.href);
      // Another site unloads the page, which beforeunload already covers.
      if (url.origin !== window.location.origin) return;
      // A jump within this page (On this page) loses nothing.
      if (url.pathname === window.location.pathname && url.search === window.location.search)
        return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);

  return {
    target,
    stay: () => setTarget(null),
    leave: () => {
      if (target) router.push(target);
      setTarget(null);
    },
    discard: () => {
      allowUnload.current = true;
      window.location.reload();
    },
  };
}

/** Submits each dirty form in turn; `stagedSettingsAction` takes the update lock, so they queue. */
export function PageSaveBar({
  stagedFields,
  children,
}: {
  /** Form fields carrying a saved but unapplied edit, so a fresh page can mark them too. */
  stagedFields: readonly string[];
  children: ReactNode;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const container = useRef<HTMLDivElement>(null);
  // A stable set: the effect that marks the labels depends on it.
  const staged = useMemo(() => new Set(stagedFields), [stagedFields]);
  const { dirty, accept } = useDirtyForms(container, staged);
  const guard = useLeaveGuard(dirty.length > 0);

  const save = useCallback(() => {
    for (const form of dirty) form.requestSubmit();
    // Clean on send: React state fields are not reset after the action. Failures show per block.
    accept();
  }, [dirty, accept]);

  return (
    <>
      <div ref={container}>{children}</div>
      <AlertDialog
        isOpen={guard.target !== null}
        onOpenChange={(open) => !open && guard.stay()}
        title={t("pageLeaveTitle")}
        description={t("pageLeaveDescription", { count: dirty.length })}
        cancelLabel={t("pageLeaveStay")}
        actionLabel={t("pageLeave")}
        actionVariant="destructive"
        onAction={guard.leave}
      />
      {dirty.length > 0 && (
        // Sticky, not fixed: the pane scrolls, and fixed would float over the rail and header.
        <HStack
          justify="center"
          paddingBlockStart={4}
          className="pointer-events-none sticky bottom-0"
        >
          <StackItem className="pointer-events-auto" data-testid="settings-page-save-bar">
            <Card padding={2}>
              <HStack gap={3} vAlign="center">
                <Text type="body" size="sm">
                  {tCommon("unsavedChanges", { count: dirty.length })}
                </Text>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  // A DOM reset would desync from the React state these fields hold.
                  onClick={guard.discard}
                  label={tCommon("discard")}
                />
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={save}
                  label={tCommon("save")}
                  // Other Save buttons exist on the page (e.g. the favicon card).
                  data-testid="settings-page-save"
                />
              </HStack>
            </Card>
          </StackItem>
        </HStack>
      )}
    </>
  );
}
