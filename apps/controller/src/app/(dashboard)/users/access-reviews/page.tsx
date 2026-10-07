import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { eq } from "drizzle-orm";
import db from "@/src/lib/db";
import { users } from "@/src/lib/db/schema";
import { getCampaign, listCampaigns } from "@/src/lib/access-reviews";
import { listGroups } from "@/src/lib/models/groups";
import { listRoles } from "@/src/lib/roles/store";
import { can, currentAccess } from "@/src/lib/users/permissions";
import AccessReviewsClient from "./AccessReviewsClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("accessReviews");
  return { title: t("title") };
}

type PageProps = { searchParams: Promise<{ id?: string }> };

/** Open to every account: a reviewer may hold no capability, and sees only their own items. */
export default async function AccessReviewsPage({ searchParams }: PageProps) {
  const { session, access } = await currentAccess();
  const canRead = can(access, "users:read");
  const canManage = can(access, "users:write");
  const id = Number((await searchParams).id);
  const [campaigns, detail, roles] = await Promise.all([
    listCampaigns(access),
    Number.isInteger(id) && id > 0 ? getCampaign(id, access) : null,
    listRoles(),
  ]);
  const [people, groups] = canManage
    ? await Promise.all([
        db
          .select({ id: users.id, email: users.email, name: users.name })
          .from(users)
          .where(eq(users.status, "active"))
          .orderBy(users.email),
        listGroups(),
      ])
    : [[], []];
  return (
    <AccessReviewsClient
      me={Number(session.user.id)}
      canRead={canRead}
      canManage={canManage}
      campaigns={campaigns}
      detail={detail}
      roles={roles.map((role) => ({ key: role.key, name: role.name, builtIn: role.builtIn }))}
      people={people.map((person) => ({ id: person.id, label: person.name || person.email }))}
      groups={groups.map((group) => ({ id: group.id, name: group.name }))}
    />
  );
}
