/**
 * Origins Better Auth trusts beyond its `baseURL`, without which a deployment reached at
 * http://<server-ip>:3000 is refused at setup sign-in. Adds the Public URL and BASE_URL, the
 * dashboard host's origin, and until setup finishes the browser's own address when same-origin -
 * a cross-site page cannot forge Origin, and a DNS-rebound one carries no cookies for this host.
 */
import { publicOrigins } from "./public-url";

/** Setup never becomes unfinished again, so once seen it no longer costs a query. */
let setupFinished = false;

/** Test seam: forget that setup was seen finished. */
export function resetTrustedOriginsCache(): void {
  setupFinished = false;
}

/**
 * The origin a request claims, when it matches the host the request was sent to. Null for
 * anything cross-origin, opaque ("null"), unparseable or not http(s).
 */
export function sameOriginOf(request: Request): string | null {
  // Referer as Better Auth falls back to it: some same-origin POSTs arrive without Origin.
  const claimed = request.headers.get("origin") || request.headers.get("referer");
  if (!claimed || claimed === "null") return null;

  let origin: URL;
  let host: string;
  try {
    origin = new URL(claimed);
    host = request.headers.get("host") ?? new URL(request.url).host;
  } catch {
    return null;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
  return origin.host.toLowerCase() === host.toLowerCase() ? origin.origin : null;
}

/**
 * The dashboard host's origin, or null when it serves nothing. Never throws: an unreadable setting
 * trusts one origin fewer, which is the safe direction.
 */
async function dashboardOrigin(): Promise<string | null> {
  try {
    const [{ dashboardHostOrigin }, { getDashboardSettings }] = await Promise.all([
      import("./dashboard-host"),
      import("./settings"),
    ]);
    return dashboardHostOrigin(await getDashboardSettings());
  } catch {
    return null;
  }
}

/** Whether setup is finished. Fails closed: an unreadable flag counts as finished, uncached. */
async function isSetupFinished(): Promise<boolean> {
  if (setupFinished) return true;
  try {
    const { isSetupCompleted } = await import("./setup");
    setupFinished = await isSetupCompleted();
    return setupFinished;
  } catch {
    return true;
  }
}

/**
 * Better Auth's `trustedOrigins`, called on every auth request. Only the setup flag is cached;
 * the other two are indexed single-row reads, cheap beside the session read auth already does.
 */
export async function extraTrustedOrigins(request?: Request): Promise<string[]> {
  const origins = new Set(await publicOrigins());

  const dashboard = await dashboardOrigin();
  if (dashboard) origins.add(dashboard);

  if (request && !(await isSetupFinished())) {
    const own = sameOriginOf(request);
    if (own) origins.add(own);
  }

  return [...origins];
}
