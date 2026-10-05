"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  TIME_ZONE_COOKIE,
  TIME_ZONE_COOKIE_MAX_AGE,
  parseTimeZone,
} from "@/src/lib/locale/time-zone";

/**
 * The server has no other way to learn the zone. On a mismatch it writes the cookie and refreshes
 * once, as `LocaleProvider` does for `navigator.languages`.
 */
export function TimeZoneSync({ timeZone }: { timeZone: string }) {
  const router = useRouter();
  // Once per mount: if the cookie cannot be stored, a refresh would come back in UTC every time.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    const detected = parseTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!detected || detected === timeZone) return;
    attempted.current = true;
    /* biome-ignore lint/suspicious/noDocumentCookie: as LocaleProvider - Cookie Store is
       Chromium-only and its async set would race router.refresh(). */
    document.cookie = `${TIME_ZONE_COOKIE}=${detected}; path=/; max-age=${TIME_ZONE_COOKIE_MAX_AGE}; SameSite=Lax`;
    router.refresh();
  }, [timeZone, router]);

  return null;
}
