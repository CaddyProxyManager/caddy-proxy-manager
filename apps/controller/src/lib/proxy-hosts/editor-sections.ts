/**
 * The proxy host editor's sections, as the host detail page links into them. Client safe: the
 * editor anchors each section on `editorSectionAnchor`, and its page shows one section at a time,
 * each at its own address.
 */

export const EDITOR_SECTIONS = [
  "general",
  "upstreams",
  "access",
  "protection",
  "routing",
  "advanced",
] as const;

export type EditorSection = (typeof EDITOR_SECTIONS)[number];

export function isEditorSection(value: unknown): value is EditorSection {
  return typeof value === "string" && (EDITOR_SECTIONS as readonly string[]).includes(value);
}

/** TLS was a section of its own; its certificate went to General, beside the domains it covers. */
const RETIRED_SECTIONS: Record<string, EditorSection> = { tls: "general" };

/** A section named in a link, old ones included; null for none. */
export function editorSectionFromLink(value: unknown): EditorSection | null {
  if (isEditorSection(value)) return value;
  return typeof value === "string" ? (RETIRED_SECTIONS[value] ?? null) : null;
}

/** The element id a section's fields sit under. */
export function editorSectionAnchor(section: EditorSection): string {
  return `host-section-${section}`;
}

/** The host's editor page on one section. `hostRef` is its uuid; a serial id resolves. */
export function editorSectionHref(
  hostRef: string | number,
  section: EditorSection = "general",
): string {
  return `/proxy-hosts/${hostRef}/edit/${section}`;
}

export function proxyHostDetailHref(hostRef: string | number): string {
  return `/proxy-hosts/${hostRef}`;
}

/** Optionally opened on one revision, compared with the one before it. */
export function proxyHostHistoryHref(hostRef: string | number, revisionId?: number): string {
  return `/proxy-hosts/${hostRef}/history${revisionId ? `?to=${revisionId}` : ""}`;
}
