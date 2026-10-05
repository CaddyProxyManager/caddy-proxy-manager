import { type NextRequest, NextResponse } from "next/server";
import { config } from "@/src/lib/config";
import { logAuditEvent } from "@/src/lib/audit";
import {
  CONSOLE_POLICY_SUBJECT,
  isLoopbackAddress,
  verifyConsoleCommand,
} from "@/src/lib/users/console-command";
import { getTwoFactorPolicySettings, saveTwoFactorPolicySettings } from "@/src/lib/settings";
import { PEER_ADDRESS_HEADER, isPeerAddressStamped } from "@/src/lib/http/peer-address";

/**
 * `cpm-server --lift-mfa-policy`: turns the two-factor policy off, the way back in when it locks
 * out the only people who could change it. Guarded like reset-2fa: only a signed loopback request
 * from the compiled server is answered, anything else gets a missing path's 404.
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
    "lift-mfa-policy",
  );
  if (subject !== CONSOLE_POLICY_SUBJECT) return notFound;

  const previous = await getTwoFactorPolicySettings();
  await saveTwoFactorPolicySettings({ mode: "off" });
  await logAuditEvent({
    userId: null,
    action: "mfa_policy_lifted",
    entityType: "settings",
    summary: "Lifted the two-factor policy from the server console",
    data: { previousMode: previous.mode },
  });
  return NextResponse.json({ previousMode: previous.mode });
}
