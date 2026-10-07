"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { declineMigration, hasAnySignIn, isSetupCompleted } from "@/src/lib/setup";

/**
 * The import is a route handler (app/api/setup/migrate/route.ts): an action's re-render would
 * redirect away before the restart step. Declining wants that redirect.
 */
export async function skipMigration(): Promise<void> {
  try {
    // Once setup is past this step, /setup's own guard sends the reader on.
    if (!(await isSetupCompleted()) && !(await hasAnySignIn())) await declineMigration();
    redirect("/setup");
  } catch (error) {
    unstable_rethrow(error);
    // A bare form action has nowhere to show a message; the page stays as it was.
    console.error("Setup: failed to skip the migration", error);
  }
}
