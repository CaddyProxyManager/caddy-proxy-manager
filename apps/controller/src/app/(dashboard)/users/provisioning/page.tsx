import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getPublicBaseUrl } from "@/src/lib/http/public-url";
import { listRoles } from "@/src/lib/roles/store";
import { listScimConnections } from "@/src/lib/scim/connections";
import { scimSupported } from "@/src/lib/scim/plugin";
import { can, requireCanAccess } from "@/src/lib/users/permissions";
import ScimConnectionsClient from "./ScimConnectionsClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("scim");
  return { title: t("title") };
}

export default async function ProvisioningPage() {
  const { access } = await requireCanAccess("users:read");
  const supported = scimSupported();
  const [connections, roles, baseUrl] = await Promise.all([
    supported ? listScimConnections() : [],
    listRoles(),
    getPublicBaseUrl(),
  ]);
  return (
    <ScimConnectionsClient
      supported={supported}
      endpoint={`${baseUrl}/api/auth/scim/v2`}
      connections={connections}
      // Groups cannot give admin, so a mapping cannot either.
      roles={roles
        .filter((role) => role.key !== "admin")
        .map((role) => ({ key: role.key, name: role.name, builtIn: role.builtIn }))}
      canWrite={can(access, "users:write") && can(access, "groups:write")}
    />
  );
}
