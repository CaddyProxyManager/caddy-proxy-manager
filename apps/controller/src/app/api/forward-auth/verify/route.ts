import { type NextRequest, NextResponse } from "next/server";
import {
  validateForwardAuthSession,
  checkHostAccess,
  resolveForwardAuthAudience,
} from "@/src/lib/models/forward-auth";
import { getUserById } from "@/src/lib/models/user";
import { getGroupsForUser } from "@/src/lib/models/groups";
import { getTrustedForwardAuthOrigin } from "@/src/lib/forward-auth-trust";
import { encodeGroupsHeaderValue, encodeIdentityHeaderValue } from "@/src/lib/identity-header";

const COOKIE_NAME = "_cpm_fa";

/** Forward auth verify, called by Caddy as a subrequest: 200 + user headers, or 401. */
export async function GET(request: NextRequest) {
  // Never trust X-Forwarded-* from a client reaching Next.js directly.  Only
  // generated Caddy routes know the purpose-derived proof value.
  const requestOrigin = getTrustedForwardAuthOrigin(request.headers);
  const audience = requestOrigin ? await resolveForwardAuthAudience(requestOrigin) : null;
  if (!audience) {
    return new NextResponse(null, { status: 401 });
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return new NextResponse(null, { status: 401 });
  }

  const session = await validateForwardAuthSession(token, audience);
  if (!session) {
    return new NextResponse(null, { status: 401 });
  }

  // Caddy subrequests this on every proxied request, so the three reads that only need the user
  // id share one round trip; the checks below still answer in the same order.
  const [user, hasAccess, userGroups] = await Promise.all([
    getUserById(session.userId),
    checkHostAccess(session.userId, audience.proxyHostId),
    getGroupsForUser(session.userId),
  ]);
  if (user?.status !== "active") {
    return new NextResponse(null, { status: 401 });
  }

  if (!hasAccess) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  return new NextResponse(null, {
    status: 200,
    headers: {
      "X-CPM-User": encodeIdentityHeaderValue(user.name ?? user.email.split("@")[0]),
      "X-CPM-Email": encodeIdentityHeaderValue(user.email),
      "X-CPM-Groups": encodeGroupsHeaderValue(userGroups.map((g) => g.name)),
      "X-CPM-User-Id": String(user.id),
    },
  });
}
