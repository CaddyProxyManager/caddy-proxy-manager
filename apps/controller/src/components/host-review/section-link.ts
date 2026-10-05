/**
 * The editor's place in the URL: `?edit=<id>#<section>`, as the host page links to it. Set with
 * replaceState, so jumping around the form neither navigates nor fills the history.
 */
export function linkEditorSection(hostId: number, section: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("edit", String(hostId));
  url.hash = section;
  window.history.replaceState(window.history.state, "", url);
}

/** Drops what linkEditorSection added; true when there was anything to drop. */
export function clearEditorLink(): boolean {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("edit") && !url.hash) return false;
  url.searchParams.delete("edit");
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
  return true;
}
