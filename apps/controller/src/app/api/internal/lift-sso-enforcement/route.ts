import { type NextRequest, NextResponse } from "next/server";
import { config } from "@/src/lib/config";
import { logAuditEvent } from "@/src/lib/audit";
import {
  CONSOLE_SSO_SUBJECT,
  isLoopbackAddress,
  verifyConsoleCommand,
} from "@/src/lib/users/console-command";
import { getSsoEnforcementSettings, saveSsoEnforcementSettings } from "@/src/lib/settings";
import { PEER_ADDRESS_HEADER, isPeerAddressStamped } from "@/src/lib/http/peer-address";

/**
 * `cpm-server --lift-sso-enforcement`: passwords work again, for when the identity provider is
 * down and no break-glass account was named. Guarded like lift-mfa-policy: a signed loopback
 * request from the compiled server, and a missing path's 404 for anything else.
 */
export async function POST(request: NextRequest) {
  const notFound = NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isPeerAddressStamped() || !isLoopbackAddress(request.headers.get(PEER_ADDRESS_HEADER))) {
    return notFound;
  }
  const subject = verifyConsoleCommand(
    config.sessionSecret,
    await request.json().catch(() => ({})),
    Date.now(),
    "lift-sso-enforcement",
  );
  if (subject !== CONSOLE_SSO_SUBJECT) return notFound;

  const previous = await getSsoEnforcementSettings();
  await saveSsoEnforcementSettings({ enforced: false });
  await logAuditEvent({
    userId: null,
    action: "sso_enforcement_lifted",
    entityType: "settings",
    summary: "Lifted single sign-on enforcement from the server console",
    data: { wasEnforced: previous.enforced },
  });
  return NextResponse.json({ wasEnforced: previous.enforced });
}
