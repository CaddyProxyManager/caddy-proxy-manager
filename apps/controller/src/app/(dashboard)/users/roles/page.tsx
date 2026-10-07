import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { listRoles } from "@/src/lib/roles/store";
import { can, requireCanAccess } from "@/src/lib/users/permissions";
import RolesClient from "./RolesClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("roles");
  return { title: t("title") };
}

export default async function RolesPage() {
  const { access } = await requireCanAccess("roles:read");
  const roles = await listRoles();
  return (
    <RolesClient
      roles={roles.map(({ key, name, description, capabilities, scoped, builtIn }) => ({
        key,
        name,
        description,
        capabilities: [...capabilities],
        scoped,
        builtIn,
      }))}
      canWrite={can(access, "roles:write")}
      holdsKey={access.role}
    />
  );
}
