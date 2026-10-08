/**
 * An OIDC provider, SAML provider or LDAP directory hands out its default role and every mapped
 * role, and with linking on signs its users in as whichever account shares their email. Whoever
 * writes one must hold all of that, or `settings:write` alone is a way to become anyone.
 */
import { splitGroupList } from "../auth/oidc/groups";
import { domainError } from "../errors/domain-error";
import { BUILT_IN_ROLES } from "./built-in";
import { type CapabilitySet, covers } from "./capabilities";
import { type LegacyRoleColumns, type RoleGroups, requestedRoleGroups } from "./mappings";
import { assertMayAssignRole, isKnownRole } from "./store";

export type SignInGrants = Partial<LegacyRoleColumns> & {
  roleGroups?: RoleGroups | null;
  defaultRole?: string | null;
  autoLink?: boolean;
};

/**
 * Checks the source as it will be once `input` is saved over `existing`, so repointing a source
 * someone else set up to hand out more is refused as well as setting one up.
 */
export async function assertMayConfigureSignIn(
  holding: CapabilitySet,
  existing: SignInGrants | null,
  input: SignInGrants & Record<string, unknown>,
): Promise<void> {
  // The list's switch: a source turned on or off hands out only what it was set up to.
  if (Object.keys(input).every((key) => key === "enabled")) return;

  const groups = { ...requestedRoleGroups(existing ?? {}), ...requestedRoleGroups(input) };
  const defaultRole = input.defaultRole !== undefined ? input.defaultRole : existing?.defaultRole;
  const roles = new Set(
    Object.entries(groups)
      .filter(([, names]) => splitGroupList(names.join(",")).length > 0)
      .map(([role]) => role),
  );
  if (defaultRole) roles.add(defaultRole);
  for (const role of roles) {
    // An unknown default falls back to `user`, and an unknown mapping is refused when saved.
    if (await isKnownRole(role)) await assertMayAssignRole(holding, role);
  }

  const autoLink = input.autoLink ?? existing?.autoLink ?? false;
  if (autoLink && !covers(holding, BUILT_IN_ROLES.admin)) {
    throw domainError("signInLinkNeedsEverything", {}, { status: 403 });
  }
}
