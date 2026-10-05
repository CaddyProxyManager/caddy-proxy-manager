import { createContext, use } from "react";

/**
 * False where a full-screen page renders inside another document, as the docs site embeds the
 * sign-in and setup screens: a second `main` and an `h1` mid-article break the host's outline.
 */
export const StandalonePage = createContext(true);

/** The landmark, title level and autofocus a full-screen page should use where it is rendered. */
export function usePageFrame() {
  const standalone = use(StandalonePage);
  return standalone
    ? ({ role: "main", titleLevel: 1, autoFocus: true } as const)
    : // Embedded under one of the host page's section headings.
      ({ role: undefined, titleLevel: 3, autoFocus: false } as const);
}
