/**
 * A capped column that widens with the window: `base` up to a 1280px viewport, growing to half as
 * wide again by 1920px, so a large monitor is not mostly margin.
 */
export function wideMeasure(base: number): string {
  return `clamp(${base}px, ${((base / 1280) * 100).toFixed(2)}vw, ${Math.round(base * 1.5)}px)`;
}
