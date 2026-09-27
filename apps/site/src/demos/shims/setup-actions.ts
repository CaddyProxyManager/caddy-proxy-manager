/**
 * Stands in for `app/setup/actions.ts` and `app/setup/migrate/actions.ts` (see astro.config.mjs):
 * instead of writing the database and redirecting, forms go to the running setup simulation.
 */
import { currentSimulation } from "../setup-simulation";

export type SetupActionState = { error: string | null };

const noSimulation = { error: "There is no controller behind the documentation site." };

export async function createFirstAdmin(
  _previous: SetupActionState,
  formData: FormData,
): Promise<SetupActionState> {
  return currentSimulation()?.createFirstAdmin(formData) ?? noSimulation;
}

export async function configureFirstOAuthProvider(
  _previous: SetupActionState,
  formData: FormData,
): Promise<SetupActionState> {
  return currentSimulation()?.configureFirstOAuthProvider(formData) ?? noSimulation;
}

export async function skipMigration(): Promise<void> {
  await currentSimulation()?.skipMigration();
}
