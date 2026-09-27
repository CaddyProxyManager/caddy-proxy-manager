"use server";

import { redirect } from "next/navigation";
import { declineMigration, hasAnySignIn, isSetupCompleted } from "@/src/lib/setup";
import { domainError } from "@/src/lib/domain-error";
import { withTranslatedErrors } from "@/src/lib/translated-action";

/**
 * The import is a route handler (app/api/setup/migrate/route.ts): an action's re-render would
 * redirect away before the restart step. Declining wants that redirect.
 */
async function skipMigrationUntranslated(): Promise<void> {
  if ((await isSetupCompleted()) || (await hasAnySignIn())) {
    throw domainError("setupAlreadyCompleted");
  }
  await declineMigration();
  redirect("/setup");
}

export async function skipMigration(): Promise<void> {
  return withTranslatedErrors(() => skipMigrationUntranslated());
}
