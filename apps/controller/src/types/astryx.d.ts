/**
 * Astryx variant augmentations. They must name the component's own subpath: `astryx theme build`
 * and core's guards look for the literal interface there. Each needs a `data-variant` rule in
 * src/app/astryx-variants.css, or it type-checks, renders, and paints nothing.
 */
// Makes this a module, so the block augments `@astryxdesign/core/Button` instead of declaring an
// ambient module that shadows it and breaks every `import {Button}`.
export {};

declare module "@astryxdesign/core/Button" {
  interface ButtonVariantMap {
    /**
     * The accent at a lower weight, for a control that outranks `secondary` where the solid accent
     * is taken - the primary SSO provider beside a form whose submit is the accent.
     */
    tonal: true;
    /**
     * Pink whatever the chosen accent: the host editor's Review button while there is something
     * to save, which is its only way out.
     */
    pink: true;
  }
}
