/**
 * Stands in for the editors' `components/host-review/section-link` (aliased in astro.config.mjs):
 * a demo's section jumps must not write `?edit=` into the documentation page's URL.
 */
export function linkEditorSection(_hostId: number, _section: string): void {}

export function clearEditorLink(): boolean {
  return false;
}
