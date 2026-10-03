import GroupsClient from "./GroupsClient";
import { listGroups } from "@/src/lib/models/groups";
import { listUsers } from "@/src/lib/models/user";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { listL4ProxyHosts } from "@/src/lib/models/l4-proxy-hosts";
import { listAgents } from "@/src/lib/models/agents";
import { listOAuthProviders } from "@/src/lib/models/oauth-providers";
import { listLdapDirectories } from "@/src/lib/models/ldap-directories";
import { listAllGrants } from "@/src/lib/models/group-grants";
import { listAllMappings } from "@/src/lib/models/group-idp-mappings";
import type { GroupAccess } from "@/components/groups/GroupAccessDialog";
import { requireAdmin } from "@/src/lib/auth";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("groups") };
}

export default async function GroupsPage() {
  await requireAdmin();
  const [
    allGroups,
    allUsers,
    proxyHosts,
    l4Hosts,
    agents,
    providers,
    directories,
    grants,
    mappings,
  ] = await Promise.all([
    listGroups(),
    listUsers(),
    listProxyHosts(),
    listL4ProxyHosts(),
    listAgents(),
    listOAuthProviders(),
    // A directory's groups map to CPM groups the same way a provider's claim does.
    listLdapDirectories(),
    listAllGrants(),
    listAllMappings(),
  ]);

  const userList = allUsers.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
  }));

  const access: Record<number, GroupAccess> = {};
  for (const group of allGroups) {
    const groupGrants = grants.get(group.id) ?? [];
    access[group.id] = {
      mappings: (mappings.get(group.id) ?? []).map((m) => ({
        providerId: m.providerId,
        externalName: m.externalName,
      })),
      proxyHostIds: groupGrants
        .filter((g) => g.resource.kind === "proxyHost")
        .map((g) => g.resource.id),
      l4ProxyHostIds: groupGrants
        .filter((g) => g.resource.kind === "l4ProxyHost")
        .map((g) => g.resource.id),
      agentIds: groupGrants.filter((g) => g.resource.kind === "agent").map((g) => g.resource.id),
      // One capability for the whole group; a mixed or empty set reads as "manage", as it saves.
      capability:
        groupGrants.length === 0 || groupGrants.some((g) => g.capability === "manage")
          ? "manage"
          : "view",
    };
  }

  return (
    <GroupsClient
      groups={allGroups}
      users={userList}
      providers={[...providers, ...directories].map((p) => ({ id: p.id, name: p.name }))}
      proxyHosts={proxyHosts.map((h) => ({ id: h.id, name: h.name }))}
      l4ProxyHosts={l4Hosts.map((h) => ({ id: h.id, name: h.name }))}
      agents={agents.map((a) => ({ id: a.id, name: a.name }))}
      access={access}
    />
  );
}
