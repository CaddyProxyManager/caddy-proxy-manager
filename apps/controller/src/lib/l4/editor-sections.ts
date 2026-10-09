/**
 * The L4 host editor's sections, as proxy-hosts/editor-sections.ts is for HTTP hosts. Client safe.
 */

export const L4_EDITOR_SECTIONS = ["general", "listener", "upstreams", "protection"] as const;

export type L4EditorSection = (typeof L4_EDITOR_SECTIONS)[number];

export function isL4EditorSection(value: unknown): value is L4EditorSection {
  return typeof value === "string" && (L4_EDITOR_SECTIONS as readonly string[]).includes(value);
}

export function l4EditorSectionAnchor(section: L4EditorSection): string {
  return `l4-section-${section}`;
}

export function l4EditorSectionHref(hostRef: string | number, section?: L4EditorSection): string {
  return `/l4-proxy-hosts?edit=${hostRef}${section ? `#${section}` : ""}`;
}

/** Optionally opened on one revision, compared with the one before it. */
export function l4ProxyHostHistoryHref(hostRef: string | number, revisionId?: number): string {
  return `/l4-proxy-hosts/${hostRef}/history${revisionId ? `?to=${revisionId}` : ""}`;
}
