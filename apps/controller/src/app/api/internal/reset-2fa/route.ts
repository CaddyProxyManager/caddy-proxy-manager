import { type NextRequest, NextResponse } from "next/server";
import { config } from "@/src/lib/config";
import { logAuditEvent } from "@/src/lib/audit";
import { isLoopbackAddress, verifyConsoleCommand } from "@/src/lib/users/console-command";
import { findUserByConsoleName } from "@/src/lib/users/console-user";
import { revokeSessionsAfterPasswordChange } from "@/src/lib/models/sessions";
import { PEER_ADDRESS_HEADER, isPeerAddressStamped } from "@/src/lib/http/peer-address";
import { resetTwoFactor } from "@/src/lib/forward-auth/two-factor";
import { deleteUserPasskeys } from "@/src/lib/auth/passkeys";

/**
 * `cpm-server --reset-2fa <username>`: turns off 2FA and removes the passkeys, the recovery for a
 * lost or stolen authenticator. Only a signed loopback request from the compiled server is
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

  const user = await findUserByConsoleName(username);
  if (!user) {
    return NextResponse.json({ error: `No user named ${username}` }, { status: 404 });
  }

  const hadTwoFactor = await resetTwoFactor(user.id);
  const passkeysRemoved = await deleteUserPasskeys(user.id);
  await revokeSessionsAfterPasswordChange(user.id, null);
  await logAuditEvent({
    userId: null,
    action: "two_factor_reset",
    entityType: "user",
    entityId: user.id,
    summary: `Two-factor sign-in reset for user ${user.email} from the server console`,
  });
  if (passkeysRemoved > 0) {
    await logAuditEvent({
      userId: null,
      action: "passkey_removed",
      entityType: "user",
      entityId: user.id,
      summary: `Passkeys removed for user ${user.email} from the server console`,
    });
  }
  return NextResponse.json({ email: user.email, hadTwoFactor, passkeysRemoved });
}
