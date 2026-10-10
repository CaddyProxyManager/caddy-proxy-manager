import type { NextRequest } from "next/server";
import { getTranslations } from "next-intl/server";
import { checkSameOrigin } from "@/src/lib/auth";
import { importLegacyDatabase } from "@/src/lib/migration/import";
import { scanForLegacyDatabases } from "@/src/lib/migration/legacy-database";
import {
  LegacySecretError,
  probeLegacySecrets,
  verifyLegacyKey,
} from "@/src/lib/migration/legacy-secrets";
import { parseMigrationSelection } from "@/src/lib/migration/selection";
import { carryOverBlobSettings } from "@/src/lib/migration/settings-carryover";
import {
  hasAnySignIn,
  isSetupCompleted,
  issueRestartToken,
  recordMigrationSource,
} from "@/src/lib/setup";

/**
 * POST /api/setup/migrate. A route handler, not a server action: an action re-renders its page,
 * which redirects to /login the instant the import lands, before the restart can be explained.
 * Unauthenticated by necessity, so it only works while the database is genuinely empty.
 */

export type MigrateResponse =
  // `restartToken` lets this browser, and only this one, ask /api/setup/restart for the restart.
  | { ok: true; next: string; migratedSignIn: boolean; restartToken: string }
  // `code` is what lets the browser tell "ask for the old SESSION_SECRET" apart from an error it
  // can only report. Everything else carries the message alone.
  | { ok: false; error: string; code?: "legacy-key-required" | "legacy-key-invalid" };

function json(body: MigrateResponse, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<Response> {
  // Unauthenticated by necessity, so the origin check is all that keeps a cross-site page from
  // starting an import on an empty controller.
  const originCheck = checkSameOrigin(request);
  if (originCheck) return originCheck;

  // The setup page shows `error` as it arrives, so every one is said in the reader's language.
  const t = await getTranslations("setup");
  const tErrors = await getTranslations("errors");
  if ((await isSetupCompleted()) || (await hasAnySignIn())) {
    return json({ ok: false, error: tErrors("setupAlreadyCompleted") }, 409);
  }

  let body: { path?: unknown; groups?: unknown; legacyKey?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: t("migrateErrors.expectedJson") }, 400);
  }

  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path) return json({ ok: false, error: t("migrateErrors.chooseDatabase") }, 400);

  // Re-derived, not trusted: the checkboxes close over dependencies but a posted list need not,
  // and this stops a proxy host being imported without the access list protecting it.
  const groups = parseMigrationSelection(
    Array.isArray(body.groups) ? body.groups.filter((g): g is string => typeof g === "string") : [],
  );
  if (groups.length === 0) {
    return json({ ok: false, error: t("migrateErrors.chooseGroups") }, 400);
  }

  // The whole guard: the importer gets the scan's path, never the request's. Merely inspecting a
  // posted path left the filesystem open to existence checks and to importing a planted database.
  const chosen = scanForLegacyDatabases().candidates.find((candidate) => candidate.path === path);
  if (!chosen) {
    return json({ ok: false, error: t("migrateErrors.unknownDatabase") }, 400);
  }

  // Checked up front so a missing or mistyped key is a 400 before any row is written. The key is
  // used and dropped; only re-encrypted ciphertext is stored.
  const legacyKey = typeof body.legacyKey === "string" ? body.legacyKey.trim() : "";
  const probe = probeLegacySecrets(chosen.path);
  if (probe.hasEncryptedValues && !probe.readableWithCurrentKey) {
    if (!legacyKey) {
      return json(
        {
          ok: false,
          code: "legacy-key-required",
          error: t("migrateErrors.legacyKeyRequired"),
        },
        400,
      );
    }
    if (!verifyLegacyKey(probe, legacyKey)) {
      return json(
        {
          ok: false,
          code: "legacy-key-invalid",
          error: t("migrateErrors.legacyKeyInvalid"),
        },
        400,
      );
    }
  }

  try {
    await importLegacyDatabase(chosen.path, groups, { legacyKey: legacyKey || null });
    // The old JSON blobs live in the settings table, so there is nothing to lift when settings
    // were left behind - and writing them anyway would pin values the operator declined to bring.
    if (groups.includes("settings")) await carryOverBlobSettings();
    await recordMigrationSource(chosen.path);
  } catch (error) {
    console.error("Migration failed", error);
    // Reachable despite the check above only when a value outside the sampled ones is encrypted
    // under a third key - a database whose secret was rotated more than once. Nothing was written:
    // every row is converted before any is inserted, so this is a refusal, not a partial import.
    if (error instanceof LegacySecretError) {
      const sentence =
        error.reason === "keyMissing"
          ? t("migrateErrors.secretKeyMissing")
          : t("migrateErrors.secretKeyWrong");
      const reason = error.table
        ? t("migrateErrors.secretUnreadableInTable", { reason: sentence, table: error.table })
        : sentence;
      return json(
        {
          ok: false,
          code: "legacy-key-invalid",
          error: t("migrateErrors.nothingWritten", { reason }),
        },
        400,
      );
    }
    return json({ ok: false, error: t("migrateErrors.failedPartway") }, 500);
  }

  // Where to go next is asked of the database rather than of the checkboxes: migrating an enabled
  // OAuth provider is a way in even without the old accounts, and a users group that turned out to
  // be empty is not one. A deployment that now has neither still needs its first administrator.
  const migratedSignIn = await hasAnySignIn();
  const restartToken = await issueRestartToken();
  return json(
    { ok: true, next: migratedSignIn ? "/login" : "/setup", migratedSignIn, restartToken },
    200,
  );
}
