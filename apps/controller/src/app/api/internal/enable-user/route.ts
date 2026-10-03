import { type NextRequest, NextResponse } from "next/server";
import { config } from "@/src/lib/config";
import { logAuditEvent } from "@/src/lib/audit";
import { CONSOLE_ENABLE_ACTION } from "@/src/lib/account-failures";
import { isLoopbackAddress, verifyConsoleCommand } from "@/src/lib/console-command";
import { findUserByConsoleName } from "@/src/lib/console-user";
import { updateUserStatus } from "@/src/lib/models/user";
import { PEER_ADDRESS_HEADER, isPeerAddressStamped } from "@/src/lib/peer-address";

/**
 * `cpm-server --enable-user <username>`: the recovery for an account disabled after failed
 * sign-ins, the only administrator's included. Guarded like reset-2fa: only a signed loopback
 * request from the compiled server is answered, anything else gets a missing path's 404.
 */
export async function POST(request: NextRequest) {
  const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPeerAddressStamped() || !isLoopbackAddress(request.headers.get(PEER_ADDRESS_HEADER))) {
    return notFound;
  }
  const username = verifyConsoleCommand(
    config.sessionSecret,
    await request.json().catch(() => ({})),
    Date.now(),
    "enable-user",
  );
  if (!username) return notFound;

  const user = await findUserByConsoleName(username);
  if (!user) {
    return NextResponse.json({ error: `No user named ${username}` }, { status: 404 });
  }

  const wasDisabled = user.status !== "active";
  // Also starts its count of failed sign-ins over, so the next typo does not disable it again.
  await updateUserStatus(user.id, "active");
  await logAuditEvent({
    userId: null,
    action: CONSOLE_ENABLE_ACTION,
    entityType: "user",
    entityId: user.id,
    summary: `Enabled user ${user.email} from the server console`,
  });
  return NextResponse.json({ email: user.email, wasDisabled });
}
