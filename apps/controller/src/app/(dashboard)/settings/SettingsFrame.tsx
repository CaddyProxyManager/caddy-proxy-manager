"use client";

/**
 * Every settings screen's frame. The sticky header names the page; the live revision and the apply
 * control go to the rail (the header on a phone), so neither moves with the scroll.
 */

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { useTranslations } from "next-intl";
import type { StagedView } from "@/src/lib/settings/staged-view";
import {
  findSettingsItem,
  groupForSection,
  settingsGroupLabel,
  settingsSectionName,
  HEADER_HEIGHT_VAR,
  STAGED_SLOT_ID,
} from "./sections";
import { RevisionPill, StagedControls } from "./StagedChanges";
import { wideMeasure } from "@/components/ui/measure";

/**
 * Capped and centred: full-width inputs sit a screen away from their labels. The header shares the
 * measure so the title sits over the cards; SettingsClient's column is the same width.
 */
export const COLUMN = wideMeasure(768);
const ASIDE = 176;

function Measure({ aside, children }: { aside: boolean; children: ReactNode }) {
  return (
    <VStack
      width="100%"
      maxWidth={aside ? `calc(${COLUMN} + ${ASIDE}px + var(--spacing-5))` : COLUMN}
      className="mx-auto"
    >
      {children}
    </VStack>
  );
}

export default function SettingsFrame({
  sectionId,
  title,
  staged,
  aside = true,
  children,
}: {
  /** Null on the overview. */
  sectionId: string | null;
  /** For a page that is not a section, such as the history. */
  title?: string;
  staged: StagedView;
  /** A list of its blocks beside the column, which the measure allows for. */
  aside?: boolean;
  children: ReactNode;
}) {
  return (
    <VStack gap={0} height="fill">
      <SettingsHeader sectionId={sectionId} title={title} staged={staged} aside={aside} />
      {/* No overflow here: it would become the scrollport sticky measures against, and nothing
          inside (header, save bar) would pin. */}
      <VStack padding={5} className="grow">
        <Measure aside={aside}>{children}</Measure>
      </VStack>
    </VStack>
  );
}

/** As the dashboard layout decides it: below this there is no rail, only the tab bar. */
const NARROW = "(max-width: 767px)";

/**
 * The revision and the staged change set's controls, in the rail beside History on a desktop.
 * A phone has no rail, so there they stay in the header.
 */
function StagedSummary({ staged }: { staged: StagedView }) {
  const isNarrow = useMediaQuery(NARROW);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById(STAGED_SLOT_ID)), []);

  const controls = (
    <VStack gap={2} hAlign="start">
      <RevisionPill staged={staged} inRail />
      <StagedControls view={staged} fill />
    </VStack>
  );
  if (slot && !isNarrow) return createPortal(controls, slot);
  if (!isNarrow) return null;
  return (
    <HStack gap={2} vAlign="center" className="shrink-0">
      <RevisionPill staged={staged} />
      <StagedControls view={staged} />
    </HStack>
  );
}

function SettingsHeader({
  sectionId,
  title,
  staged,
  aside,
}: {
  sectionId: string | null;
  title?: string;
  staged: StagedView;
  aside: boolean;
}) {
  const t = useTranslations("settings");
  const tNav = useTranslations("nav");
  const item = sectionId ? findSettingsItem(sectionId) : undefined;
  const group = sectionId ? groupForSection(sectionId) : undefined;
  const headerRef = useRef<HTMLElement>(null);

  // Blocks clear the header by its real height, which wraps with the title and the controls.
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty(HEADER_HEIGHT_VAR, `${header.getBoundingClientRect().height}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(header);
    // A link into a block (the overview's tiles) may land before this ran: align it again.
    const target = window.location.hash
      ? document.getElementById(decodeURIComponent(window.location.hash.slice(1)))
      : null;
    const frame = target ? requestAnimationFrame(() => target.scrollIntoView()) : 0;
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      root.style.removeProperty(HEADER_HEIGHT_VAR);
    };
  }, []);

  return (
    // Sticky, not fixed: it scrolls away where a narrow viewport cannot spare the room.
    <VStack
      ref={headerRef}
      paddingBlock={4}
      paddingInline={5}
      className="sticky top-0 z-4 shrink-0 border-b border-border bg-body"
      data-testid="settings-header"
    >
      <Measure aside={aside}>
        <HStack gap={4} vAlign="end" wrap="wrap">
          <VStack gap={1} className="min-w-0 grow">
            <div data-testid="settings-breadcrumb">
              <Breadcrumbs>
                <BreadcrumbItem>{tNav("settings")}</BreadcrumbItem>
                {group ? (
                  <BreadcrumbItem isCurrent>{settingsGroupLabel(t, group)}</BreadcrumbItem>
                ) : (
                  <BreadcrumbItem isCurrent>{title ?? tNav("overview")}</BreadcrumbItem>
                )}
              </Breadcrumbs>
            </div>
            {/* No env-var token here: it would claim to configure every block on the page. */}
            <Heading level={1}>
              {item ? settingsSectionName(t, item) : (title ?? tNav("overview"))}
            </Heading>
          </VStack>

          <StagedSummary staged={staged} />
        </HStack>
      </Measure>
    </VStack>
  );
}
