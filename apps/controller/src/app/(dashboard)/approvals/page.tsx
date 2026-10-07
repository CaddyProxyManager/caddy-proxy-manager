import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { getApprovalPolicy, getChangeRequest, listChangeRequests } from "@/src/lib/approvals";
import { listGroups } from "@/src/lib/models/groups";
import { listRoles } from "@/src/lib/roles/store";
import { can, currentAccess } from "@/src/lib/users/permissions";
import ApprovalsClient from "./ApprovalsClient";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("approvals") };
}

type PageProps = { searchParams: Promise<{ id?: string }> };

/**
 * Open to every account: whoever submitted a change follows it here, and an approver is named by
 * the policy rather than by a capability. Each sees only what the model lets them.
 */
export default async function ApprovalsPage({ searchParams }: PageProps) {
  const { access } = await currentAccess();
  const viewer = { access };
  const id = Number((await searchParams).id);
  const canReadPolicy = can(access, "settings:read");
  const [requests, detail, policy, roles, groups] = await Promise.all([
    listChangeRequests(viewer),
    Number.isInteger(id) && id > 0 ? getChangeRequest(id, viewer) : null,
    getApprovalPolicy(),
    canReadPolicy ? listRoles() : [],
    canReadPolicy ? listGroups() : [],
  ]);
  return (
    <ApprovalsClient
      me={access.userId}
      requests={requests}
      detail={detail}
      policy={canReadPolicy ? policy : null}
      policyEnabled={policy.enabled}
      canEditPolicy={can(access, "settings:write")}
      roles={roles.map((role) => ({ key: role.key, name: role.name, builtIn: role.builtIn }))}
      groups={groups.map((group) => ({ id: group.id, name: group.name }))}
    />
  );
}
