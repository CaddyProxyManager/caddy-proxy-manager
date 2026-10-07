/** Role keys to what they hold: the built-in roles from code, the rest from the roles table. */
import { BUILT_IN_ROLES, isBuiltInRoleKey } from "./built-in";
import type { RoleDefinition } from "./capabilities";

export async function roleDefinitions(keys: readonly string[]): Promise<RoleDefinition[]> {
  const unique = [...new Set(keys)];
  const builtIn = unique.flatMap((key) => (isBuiltInRoleKey(key) ? [BUILT_IN_ROLES[key]] : []));
  if (builtIn.length === unique.length) return builtIn;
  // Lazily: a caller holding only built-in roles never reads the table.
  const { storedRoleDefinitions } = await import("./store");
  return [...builtIn, ...(await storedRoleDefinitions(unique))];
}
