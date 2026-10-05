/**
 * Time zone and number format stored on the account, so they follow it to every browser. Unset,
 * the time zone falls back to the `cpm-tz` cookie the browser writes (lib/locale/time-zone.ts).
 */
import { cache } from "react";
import { eq } from "drizzle-orm";
import db from "../db";
import { users } from "../db/schema";
import { domainError } from "../errors/domain-error";
import { isNumberFormatPreference, type NumberFormatPreference } from "../locale/number-format";
import { parseTimeZone } from "../locale/time-zone";

export type DisplayPreferences = {
  /** An IANA zone, or null to follow the browser. */
  timeZone: string | null;
  numberFormat: NumberFormatPreference;
};

export const DEFAULT_DISPLAY_PREFERENCES: DisplayPreferences = {
  timeZone: null,
  numberFormat: "auto",
};

export async function getDisplayPreferences(userId: number): Promise<DisplayPreferences> {
  const [row] = await db
    .select({ timeZone: users.timeZone, numberFormat: users.numberFormat })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return {
    timeZone: parseTimeZone(row?.timeZone) ?? null,
    numberFormat: isNumberFormatPreference(row?.numberFormat) ? row.numberFormat : "auto",
  };
}

export async function setDisplayPreferences(
  userId: number,
  input: { timeZone: unknown; numberFormat: unknown },
): Promise<DisplayPreferences> {
  const timeZone =
    input.timeZone === null || input.timeZone === "" ? null : parseTimeZone(String(input.timeZone));
  if (timeZone === undefined) throw domainError("timeZoneInvalid", {}, { status: 400 });
  if (!isNumberFormatPreference(input.numberFormat)) {
    throw domainError("numberFormatInvalid", {}, { status: 400 });
  }
  await db
    .update(users)
    .set({ timeZone, numberFormat: input.numberFormat === "auto" ? null : input.numberFormat })
    .where(eq(users.id, userId));
  return { timeZone, numberFormat: input.numberFormat };
}

/** Better Auth's session cookie, either spelling: no cookie, no database read. */
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/;

/**
 * Once per request, for the next-intl request config and the root layout alike. Null when nobody
 * is signed in, or the read fails: a page must never fail over how it formats a date.
 */
export const requestDisplayPreferences = cache(async (): Promise<DisplayPreferences | null> => {
  try {
    const { headers } = await import("next/headers");
    const headerList = await headers();
    if (!SESSION_COOKIE.test(headerList.get("cookie") ?? "")) return null;
    const { auth } = await import("../auth");
    const session = await auth();
    return session ? await getDisplayPreferences(Number(session.user.id)) : null;
  } catch {
    return null;
  }
});
