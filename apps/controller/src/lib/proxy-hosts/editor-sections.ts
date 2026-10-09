/**
 * The proxy host editor's sections, as the host detail page links into them. Client safe: the
 * editor anchors each section on `editorSectionAnchor`, and the list page opens the editor from
 * `editorSectionHref`, so a link survives the editor being split into steps or tabs later.
 */

export const EDITOR_SECTIONS = [
  "general",
  "upstreams",
  "tls",
  "access",
  "protection",
  "routing",
  "advanced",
] as const;

export type EditorSection = (typeof EDITOR_SECTIONS)[number];

export function isEditorSection(value: unknown): value is EditorSection {
  return typeof value === "string" && (EDITOR_SECTIONS as readonly string[]).includes(value);
}

/** The element id a section's fields sit under. */
export function editorSectionAnchor(section: EditorSection): string {
  return `host-section-${section}`;
}

/** Opens the list page's editor on this host, scrolled to the section. */
/** `hostRef` is the host's uuid; a serial id still resolves, and the host page redirects it. */
export function editorSectionHref(hostRef: string | number, section?: EditorSection): string {
  return `/proxy-hosts?edit=${hostRef}${section ? `#${section}` : ""}`;
}

export function proxyHostDetailHref(hostRef: string | number): string {
  return `/proxy-hosts/${hostRef}`;
}

/** Optionally opened on one revision, compared with the one before it. */
export function proxyHostHistoryHref(hostRef: string | number, revisionId?: number): string {
  return `/proxy-hosts/${hostRef}/history${revisionId ? `?to=${revisionId}` : ""}`;
}
