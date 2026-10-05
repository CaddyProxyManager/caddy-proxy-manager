/**
 * Timestamps in the reader's time zone, which travels in a cookie (`locale/time-zone.ts`) so server and
 * browser renders match (#233). What stays here is what next-intl does not do: UTC text for log
 * searches, and moving a date picker's wall-clock value into and out of a named zone.
 */

export function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * "2026-09-03 14:05:09 UTC": the instant as Caddy, container and agent logs record it, so it can be
 * copied straight into a log search. Deliberately not localized.
 */
export function formatUtc(value: Date | number | string): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const partFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar fields of an instant as a clock in `timeZone` reads them. */
function wallClock(epochMs: number, timeZone: string) {
  let format = partFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormats.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(epochMs)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    // Some engines still print midnight as 24 under h23.
    hour: parts.hour % 24,
    minute: parts.minute,
    second: parts.second,
  };
}

/** How far `timeZone` is ahead of UTC at an instant, in milliseconds. */
function offsetMs(epochMs: number, timeZone: string): number {
  const whole = epochMs - (((epochMs % 1000) + 1000) % 1000);
  const c = wallClock(whole, timeZone);
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - whole;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "YYYY-MM-DDTHH:mm" for a unix time, as a clock in `timeZone` shows it; what a picker holds. */
export function toZonedWallTime(unixSeconds: number, timeZone: string): string {
  const c = wallClock(unixSeconds * 1000, timeZone);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}T${pad(c.hour)}:${pad(c.minute)}`;
}

/**
 * The unix time a "YYYY-MM-DDTHH:mm" wall-clock value means in `timeZone`, or null when it is not
 * one. The offset is taken twice because the first guess can land on the other side of a daylight
 * saving change; a time that change skips resolves to the instant just after it.
 */
export function fromZonedWallTime(value: string, timeZone: string): number | null {
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const asUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (!Number.isFinite(asUtc)) return null;
  const guessed = offsetMs(asUtc, timeZone);
  let instant = asUtc - guessed;
  const confirmed = offsetMs(instant, timeZone);
  if (confirmed !== guessed) instant = asUtc - confirmed;
  return Math.floor(instant / 1000);
}
