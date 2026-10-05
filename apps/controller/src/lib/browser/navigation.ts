/**
 * A full page load. Its own module so the docs site can swap it out: its setup demo runs
 * RestartDialog inside a documentation page that must not be navigated away from.
 */
export function loadPage(url: string): void {
  window.location.assign(url);
}
