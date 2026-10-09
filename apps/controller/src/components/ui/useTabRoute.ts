"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/** The tab a path names under `base`: `/waf/plugins` is "plugins", `/waf` the fallback. */
export function tabFromPath<T extends string>(
  path: string,
  base: string,
  tabs: readonly T[],
  fallback: T,
): T {
  const named = path.startsWith(`${base}/`) ? path.slice(base.length + 1).split("/")[0] : "";
  return (tabs as readonly string[]).includes(named) ? (named as T) : fallback;
}

export function tabPath(base: string, tab: string, fallback: string): string {
  return tab === fallback ? base : `${base}/${tab}`;
}

/**
 * A page's tab as a path segment. Switching is client state with `history.pushState`, so it
 * neither refetches the page nor loses what the other tabs hold; the route itself (a `[tab]`
 * folder re-exporting the page) answers a reload or a shared link. The old `?tab=` still opens it.
 */
export function useTabRoute<T extends string>(
  base: string,
  tabs: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const pathname = usePathname();
  const legacy = useSearchParams().get("tab");
  const [tab, setTabState] = useState<T>(() => {
    const fromPath = tabFromPath(pathname, base, tabs, fallback);
    if (fromPath !== fallback || !legacy) return fromPath;
    return (tabs as readonly string[]).includes(legacy) ? (legacy as T) : fallback;
  });

  const go = useCallback(
    (next: T, mode: "push" | "replace") => {
      const search = new URLSearchParams(window.location.search);
      search.delete("tab");
      const query = search.size > 0 ? `?${search}` : "";
      const url = `${tabPath(base, next, fallback)}${query}`;
      if (url === window.location.pathname + window.location.search) return;
      // null, not the current state: the router owns that, and treats a write carrying it as its
      // own, so it would not learn the new path and a refresh would send the page back.
      window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
    },
    [base, fallback],
  );

  // A link carrying `?tab=` or an unknown segment settles on the path that names what is shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the URL the page opened on
  useEffect(() => go(tab, "replace"), []);

  // The router commits the pushed path a moment after the page may have remounted for it (the
  // route is another one), so a state read from the stale path catches up here.
  const opened = useRef(pathname);
  useEffect(() => {
    // Not for the path the page opened on: its state came from there, or from `?tab=`.
    if (pathname !== opened.current) setTabState(tabFromPath(pathname, base, tabs, fallback));
  }, [pathname, base, tabs, fallback]);

  useEffect(() => {
    const onPop = () => setTabState(tabFromPath(window.location.pathname, base, tabs, fallback));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [base, tabs, fallback]);

  const setTab = useCallback(
    (next: T) => {
      setTabState(next);
      go(next, "push");
    },
    [go],
  );

  return [tab, setTab];
}
