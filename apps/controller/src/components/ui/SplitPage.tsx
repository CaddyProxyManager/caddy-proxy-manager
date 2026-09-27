"use client";

/** List-detail. On a phone only one fits: the rail until a record is picked, then the detail. */
import { type ReactNode, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@astryxdesign/core/Button";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/Stack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { PanelResizeHandle, usePersistedPanelWidth } from "@/components/ui/PanelResizeHandle";

export function SplitPage({
  storageKey,
  railLabel,
  resizeLabel,
  backLabel,
  rail,
  detail,
  hasSelection,
  phoneExtras,
  children,
}: {
  /** Names the remembered rail width; unique per page. */
  storageKey: string;
  railLabel: string;
  resizeLabel: string;
  backLabel: string;
  /** A row calls `open` after selecting; it swaps to the detail on a phone, no-op on desktop. */
  rail: (open: () => void) => ReactNode;
  detail: ReactNode;
  /** On a phone, the detail only shows while one is. */
  hasSelection: boolean;
  /** Phone rail only, such as a floating create button. */
  phoneExtras?: ReactNode;
  /** Dialogs and other overlays, rendered in every layout. */
  children?: ReactNode;
}) {
  // Both hooks before any branch, so the hook order never changes with the width.
  const width = usePersistedPanelWidth(storageKey, {
    defaultWidth: 320,
    minWidth: 240,
    maxWidth: 560,
  });
  const isNarrow = useMediaQuery("(max-width: 767px)");
  const [detailOpen, setDetailOpen] = useState(false);

  if (isNarrow) {
    return (
      <>
        {detailOpen && hasSelection ? (
          <VStack gap={3} padding={4}>
            <div>
              <Button
                variant="ghost"
                size="sm"
                icon={<ArrowLeft />}
                label={backLabel}
                onClick={() => setDetailOpen(false)}
              />
            </div>
            {detail}
          </VStack>
        ) : (
          <>
            {rail(() => setDetailOpen(true))}
            {phoneExtras}
          </>
        )}
        {children}
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
            <LayoutPanel width={width.width} role="navigation" label={railLabel}>
              {rail(() => {})}
            </LayoutPanel>
            <PanelResizeHandle label={resizeLabel} panel={width} />
          </>
        }
        content={<LayoutContent padding={6}>{detail}</LayoutContent>}
      />
      {children}
    </>
  );
}
