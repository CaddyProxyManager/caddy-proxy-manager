/**
 * `next/navigation` for the demos (aliased in astro.config.mjs). DataTable sorts and pages by
 * pushing a URL, so the query string is written for real and watched here by the demo owning the
 * rows. `replaceState`, never `pushState`: Back should leave the page, not undo a sort.
 */
import { useSyncExternalStore } from "react";
import { currentSimulation } from "../setup-simulation";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

function navigate(href: string) {
  history.replaceState(null, "", href);
  for (const listener of listeners) listener();
}

// Both snapshots start empty so the server's HTML and the browser's first render agree; a demo
// linked to with a query string already set settles on it in the effect that follows.
const emptySnapshot = () => "";

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => location.pathname, emptySnapshot);
}

/** Reactive, unlike Next's: writing through `useRouter` re-renders everyone reading this. */
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(useSyncExternalStore(subscribe, () => location.search, emptySnapshot));
}

/**
 * Never reached: the setup actions that call it are shimmed too. Here so their real source, which
 * the site's typecheck still reads, finds the export.
 */
export function redirect(href: string): never {
  throw new Error(`redirect(${href}) has no server to run on in the documentation site`);
}

export function useRouter() {
  // Inside the setup demo a push is a page of the simulation, not the docs' query string.
  const simulation = currentSimulation();
  const go = simulation ? (href: string) => simulation.navigate(href) : navigate;
  return {
    push: go,
    replace: go,
    refresh() {},
    back() {},
    forward() {},
    prefetch() {},
  };
}
