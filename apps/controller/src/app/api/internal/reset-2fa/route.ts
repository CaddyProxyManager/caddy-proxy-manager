import { type NextRequest, NextResponse } from "next/server";
import { eq, or } from "drizzle-orm";
import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";
import { config } from "@/src/lib/config";
import { logAuditEvent } from "@/src/lib/audit";
import { isLoopbackAddress, verifyConsoleCommand } from "@/src/lib/console-command";
import { revokeSessionsAfterPasswordChange } from "@/src/lib/models/sessions";
import { PEER_ADDRESS_HEADER, isPeerAddressStamped } from "@/src/lib/peer-address";
import { resetTwoFactor } from "@/src/lib/two-factor";

/**
 * `cpm-server --reset-2fa <username>`: only a signed loopback request from the compiled server is
 * answered; anything else, `vinext dev` included, gets a missing path's 404.
 */
export async function POST(request: NextRequest) {
  const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPeerAddressStamped() || !isLoopbackAddress(request.headers.get(PEER_ADDRESS_HEADER))) {
    return notFound;
  }
  const username = verifyConsoleCommand(
    config.sessionSecret,
    await request.json().catch(() => ({})),
  );
  if (!username) return notFound;

  // The names a person types at a prompt: the sign-in name, or the full address.
  const name = username.trim().toLowerCase();
  const user = await db.query.users.findFirst({
    where: or(
      eq(users.email, `${name}@localhost`),
      eq(users.email, name),
      eq(users.username, name),
    ),
  });
  if (!user) {
    return NextResponse.json({ error: `No user named ${username}` }, { status: 404 });
  }

  const hadTwoFactor = await resetTwoFactor(user.id);
  await revokeSessionsAfterPasswordChange(user.id, null);
  await logAuditEvent({
    userId: null,
    action: "two_factor_reset",
    entityType: "user",
    entityId: user.id,
    summary: `Two-factor sign-in reset for user ${user.email} from the server console`,
  });
  return NextResponse.json({ email: user.email, hadTwoFactor });
}
