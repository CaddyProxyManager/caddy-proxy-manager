/** An `Access` for a built-in role without a database, for tests that hand one to code directly. */
import type { EffectiveGrants } from '../../src/lib/models/group-grants';
import { BUILT_IN_ROLES, isBuiltInRoleKey } from '../../src/lib/roles/built-in';
import { type CapabilitySet, capabilitySetOf } from '../../src/lib/roles/capabilities';
import type { Access } from '../../src/lib/users/permissions';

export function capabilitiesOf(role: string | null | undefined): CapabilitySet {
  return isBuiltInRoleKey(role) ? capabilitySetOf([BUILT_IN_ROLES[role]]) : {};
}

export function accessOf(
  role: string | null | undefined,
  grants: Partial<EffectiveGrants> = {},
  userId = 1,
): Access {
  return {
    userId,
    role: role ?? '',
    capabilities: capabilitiesOf(role),
    grants: {
      proxyHosts: grants.proxyHosts ?? new Map(),
      l4ProxyHosts: grants.l4ProxyHosts ?? new Map(),
      agents: grants.agents ?? new Map(),
    },
  };
}
