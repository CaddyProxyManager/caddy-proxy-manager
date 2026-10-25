"use client";

import { type ReactNode, createContext, useContext } from "react";
import { VStack } from "@astryxdesign/core/Stack";

/**
 * The anchor of the one section a host's edit page shows. Null in a dialog, which shows them all.
 * The rest stay mounted and only hidden, so their fields still post with the form and a switch
 * keeps what was typed in them.
 */
const ActiveSectionContext = createContext<string | null>(null);

export const ActiveSectionProvider = ActiveSectionContext.Provider;

/** A section of the editor's form; a component so it reads the shell's choice from below it. */
export function EditorSectionBlock({ anchor, children }: { anchor: string; children: ReactNode }) {
  const active = useContext(ActiveSectionContext);
  const hidden = active !== null && active !== anchor;
  return (
    <VStack gap={5} id={anchor} data-section-hidden={hidden ? "" : undefined}>
      {children}
    </VStack>
  );
}
