import { type NextRequest, NextResponse } from "next/server";
import db from "@/src/lib/db";
import { validateForwardAuthSession, checkHostAccess } from "@/src/lib/models/forward-auth";
import { getGroupsForUser } from "@/src/lib/models/groups";
import { getOrAssignUserUuid } from "@/src/lib/models/user";
import { forwardAuthSequentialUserIds } from "@/src/lib/settings/registry";
import { getSetting } from "@/src/lib/settings/resolve";
import {
  FORWARD_AUTH_PORTAL_TARGET_HEADER,
  getForwardAuthPortalTarget,
  resolveTrustedForwardAuthAudience,
} from "@/src/lib/forward-auth/trust";
import {
  encodeGroupsHeaderValue,
  encodeIdentityHeaderValue,
} from "@/src/lib/forward-auth/identity-header";

const COOKIE_NAME = "_cpm_fa";

/** Caddy answers this with a portal redirect, built from the target header when there is one. */
function deny(request: NextRequest, status: 401 | 403): NextResponse {
  const target = getForwardAuthPortalTarget(request.headers);
  return new NextResponse(status === 403 ? "Forbidden" : null, {
    status,
    headers: target ? { [FORWARD_AUTH_PORTAL_TARGET_HEADER]: target } : undefined,
  });
}

/** Forward auth verify, called by Caddy as a subrequest: 200 + user headers, or 401/403. */
export async function GET(request: NextRequest) {
  // Never trust X-Forwarded-* from a client reaching Next.js directly: only generated Caddy routes
  // know the proof, and the audience must be the proxy host whose route asked.
  const audience = await resolveTrustedForwardAuthAudience(request.headers);
  if (!audience) {
    return deny(request, 401);
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) {
    return deny(request, 401);
  }

  const session = await validateForwardAuthSession(token, audience);
  if (!session) {
    return deny(request, 401);
  }

  // Caddy subrequests this on every proxied request, so the three reads that only need the user
  // id share one round trip; the checks below still answer in the same order.
  const [user, hasAccess, userGroups] = await Promise.all([
    db.query.users.findFirst({
      where: (table, { eq }) => eq(table.id, session.userId),
      columns: { id: true, uuid: true, email: true, username: true, status: true },
    }),
    checkHostAccess(session.userId, audience.proxyHostId),
    getGroupsForUser(session.userId),
  ]);
  if (user?.status !== "active") {
    return deny(request, 401);
  }

  if (!hasAccess) {
    return deny(request, 403);
  }

  const userId = (await getSetting(forwardAuthSequentialUserIds))
    ? String(user.id)
    : await getOrAssignUserUuid(user.id, user.uuid);

  return new NextResponse(null, {
    status: 200,
    headers: {
      // What the user signs in with, never the display name: anyone may pick "admin" as that.
      "X-CPM-User": encodeIdentityHeaderValue(user.username ?? user.email),
      "X-CPM-Email": encodeIdentityHeaderValue(user.email),
      "X-CPM-Groups": encodeGroupsHeaderValue(userGroups.map((g) => g.name)),
      "X-CPM-User-Id": userId,
    },
  });
}
