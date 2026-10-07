/**
 * Groups and role from a SAML sign-in, on every sign-in. The plugin maps roles only through an
 * organization plugin CPM does not use, so the assertion's groups attribute goes through the same
 * mapping and sync as an OIDC groups claim.
 */
import { and, eq } from "drizzle-orm";
import db from "../../db";
import { oauthProviders } from "../../db/schema";
import { withRoleGroups } from "../../roles/mappings";
import {
  extractGroups,
  mapGroupsToLocalGroups,
  mapGroupsToRole,
  toGroupMappingConfig,
} from "../oidc/groups";
import { applyOidcSync } from "../../services/oidc-group-sync";
import { SAML_GROUPS_FIELD, SAML_PROVIDER_TYPE } from "./urls";

export async function provisionSamlUser(input: {
  user: { id: string | number };
  userInfo: Record<string, unknown>;
  provider: { providerId: string };
}): Promise<void> {
  const userId = Number(input.user.id);
  if (!Number.isFinite(userId)) return;
  const [row] = await db
    .select()
    .from(oauthProviders)
    .where(
      and(
        eq(oauthProviders.id, input.provider.providerId),
        eq(oauthProviders.type, SAML_PROVIDER_TYPE),
      ),
    )
    .limit(1);
  if (!row) return;
  const [provider] = await withRoleGroups([row]);
  const mapping = toGroupMappingConfig(provider);
  if (!mapping.roleMappingEnabled && !mapping.syncGroups) return;

  // The plugin hands multi-valued attributes over as arrays and single ones as strings.
  const claimedGroups = extractGroups(input.userInfo, SAML_GROUPS_FIELD);
  await applyOidcSync(userId, {
    providerId: provider.id,
    subject: String(input.userInfo.id ?? ""),
    providerName: provider.name,
    role: mapGroupsToRole(claimedGroups, mapping),
    localGroups: mapGroupsToLocalGroups(claimedGroups, mapping),
    claimedGroups,
    syncGroups: mapping.syncGroups,
  });
}
