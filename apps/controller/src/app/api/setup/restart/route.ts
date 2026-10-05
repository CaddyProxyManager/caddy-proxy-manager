import type { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { auth, checkSameOrigin } from "@/src/lib/auth";
import { broadcastRestart } from "@/src/lib/agent/registry";
import { scheduleProcessRestart } from "@/src/lib/runtime/process-restart";
import {
  claimRestartSlot,
  consumeRestartToken,
  getMigrationSource,
  hasAnySignIn,
  isSetupCompleted,
  restartTokenMatches,
} from "@/src/lib/setup";

/**
 * Exits so `restart: unless-stopped` brings the process back: after a migration or setup, cached
 * settings and startup-listed providers were resolved against an empty database. No Docker access
 * needed; without a supervisor the setup screen notices it never returns. Agents restart too.
 */

/** The single-use token the requesting screen was issued. */
const RESTART_TOKEN_HEADER = "x-cpm-restart-token";

export async function POST(request: NextRequest): Promise<Response> {
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  const afterSetup = await isSetupCompleted();

  // After setup only the save's token works; an admin session would make this a permanent "stop
  // the app" endpoint. Not spent yet, or a cooldown refusal would burn the only token.
  const token = request.headers.get(RESTART_TOKEN_HEADER);
  if (afterSetup) {
    if (!(await restartTokenMatches(token))) {
      const t = await getTranslations("setup");
      return Response.json({ ok: false, error: t("errors.alreadyCompleted") }, { status: 409 });
    }
  } else {
    if (!(await getMigrationSource())) {
      const t = await getTranslations("setup");
      return Response.json(
        { ok: false, error: t("migrateErrors.nothingMigrated") },
        { status: 409 },
      );
    }

    // Open by design until something can sign in; once an import brings accounts, only the
    // importing browser's token or an admin may ask.
    if (await hasAnySignIn()) {
      const permitted =
        (await consumeRestartToken(token)) || (await auth(request))?.user.role === "admin";
      if (!permitted) {
        return Response.json(
          { ok: false, error: (await getTranslations("setup"))("restartNotPermitted") },
          { status: 401 },
        );
      }
    }
  }

  // One a minute, so nothing can hold the process in a restart loop.
  const slot = await claimRestartSlot();
  if (!slot.ok) {
    return Response.json(
      { ok: false, error: (await getTranslations("setup"))("restartTooSoon") },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(slot.retryAfterMs / 1000)) },
      },
    );
  }

  // Losing this race means another request already restarted on the same token.
  if (afterSetup && !(await consumeRestartToken(token))) {
    const t = await getTranslations("setup");
    return Response.json({ ok: false, error: t("errors.alreadyCompleted") }, { status: 409 });
  }

  // Asked before scheduling our own exit, while there is still a stream to send it on.
  const why = afterSetup ? "finished its setup" : "migrated its database";
  const asked = broadcastRestart(`the controller ${why} and is restarting`);
  if (asked > 0) {
    console.log(`Asked ${asked} agent(s) to restart Caddy and themselves: the controller ${why}`);
  }

  scheduleProcessRestart(
    afterSetup
      ? "Restarting after setup, so the app runs from the configuration it just stored"
      : "Restarting after a migration, so the app runs from the database it imported",
  );

  return Response.json({ ok: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
}
