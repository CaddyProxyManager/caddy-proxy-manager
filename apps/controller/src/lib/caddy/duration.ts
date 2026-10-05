/** Caddy duration strings. No imports: the settings and host editors check these in the browser. */

// Go durations plus caddy.ParseDuration's "d". Lax on unit order; Caddy reports the exotic.
export const CADDY_DURATION_SEGMENT = String.raw`(?:\d+(?:\.\d+)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h|d)`;

const DURATION_PATTERN = new RegExp(`^(?:${CADDY_DURATION_SEGMENT})+$`);

/** Unsigned, with a unit on every number: Caddy reads a bare number as nanoseconds. */
export function isCaddyDuration(value: string): boolean {
  return value.length <= 32 && DURATION_PATTERN.test(value);
}
