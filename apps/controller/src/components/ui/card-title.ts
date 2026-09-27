/**
 * A stat card's title, between primary and secondary text colour. Astryx has no token for that
 * step, so it is mixed from the two, which holds in both themes. Pair with body text.
 */
export const CARD_TITLE_STYLE = {
  color: "color-mix(in srgb, var(--color-text-primary) 60%, var(--color-text-secondary))",
  textTransform: "capitalize",
} as const;
