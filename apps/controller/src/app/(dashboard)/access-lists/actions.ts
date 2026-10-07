"use server";

import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { domainError } from "@/src/lib/errors/domain-error";
import { normalizeCidr } from "@/src/lib/access-lists/rules";
import type { AccessRuleKind } from "@/src/lib/access-lists/limits";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import { getTranslations } from "next-intl/server";
import {
  addAccessListEntry,
  getAccessList,
  getAccessListStats,
  removeAccessListEntry,
  type AccessListSettingsInput,
  type AccessListStats,
} from "@/src/lib/models/access-lists";
import { submitOrApply } from "@/src/lib/approvals";
import { orSubmitted } from "@/src/lib/approvals/action-result";

export async function createAccessListAction(input: {
  name: string;
  description: string | null;
  users: { username: string; password: string }[];
}) {
  const session = await requireCan("accessLists:write");
  const userId = Number(session.user.id);
  const list = await orSubmitted(() =>
    submitOrApply(
      { userId },
      {
        kind: "accessListCreate",
        payload: {
          input: {
            name: input.name,
            description: input.description,
            users: input.users.filter((u) => u.username.trim() && u.password),
          },
        },
      },
    ),
  );
  revalidatePath("/access-lists");
  return list;
}

export async function updateAccessListAction(id: number, input: AccessListSettingsInput) {
  return withTranslatedErrors(async () => {
    const session = await requireCan("accessLists:write");
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId: Number(session.user.id) },
        { kind: "accessListUpdate", payload: { id, input } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

/**
 * The whole ordered set, replacing what was there. An `address` that is no IP or range is a
 * hostname; the model checks every value.
 */
export async function setAccessListIpRulesAction(
  id: number,
  rules: {
    action: string;
    kind: AccessRuleKind;
    target: string;
    note?: string | null;
    expiresAt?: string | null;
  }[],
) {
  return withTranslatedErrors(async () => {
    const session = await requireCan("accessLists:write");
    const typed = rules.map(({ kind, target, ...rule }) => {
      if (kind === "address") {
        return normalizeCidr(target) ? { ...rule, cidr: target } : { ...rule, hostname: target };
      }
      return { ...rule, [kind]: target };
    });
    const list = await orSubmitted(() =>
      submitOrApply(
        { userId: Number(session.user.id) },
        { kind: "accessListRules", payload: { id, rules: typed } },
      ),
    );
    revalidatePath("/access-lists");
    return list;
  });
}

/** Hosts using the list, and what it stopped over the last day when analytics are on. */
export async function getAccessListStatsAction(id: number): Promise<AccessListStats> {
  await requireCan("accessLists:read");
  return getAccessListStats(id);
}

export async function deleteAccessListAction(
  id: number,
): Promise<{ success: boolean; error?: string; submitted?: string }> {
  const session = await requireCan("accessLists:write");
  const userId = Number(session.user.id);
  try {
    // A refusal names the hosts still using it, which only the server can list-format.
    const outcome = await withTranslatedErrors(() =>
      orSubmitted(() => submitOrApply({ userId }, { kind: "accessListDelete", payload: { id } })),
    );
    revalidatePath("/access-lists");
    return typeof outcome === "object"
      ? { success: true, submitted: outcome.message }
      : { success: true };
  } catch (e) {
    const t = await getTranslations("accessLists");
    return { success: false, error: e instanceof Error ? e.message : t("deleteFailed") };
  }
}

export async function addAccessEntryAction(
  accessListId: number,
  entry: { username: string; password: string },
) {
  const session = await requireCan("accessLists:write");
  const userId = Number(session.user.id);
  const list = await orSubmitted(() =>
    submitOrApply({ userId }, { kind: "accessListEntryAdd", payload: { id: accessListId, entry } }),
  );
  revalidatePath("/access-lists");
  return list;
}

export async function deleteAccessEntryAction(accessListId: number, entryId: number) {
  const session = await requireCan("accessLists:write");
  const userId = Number(session.user.id);
  const list = await orSubmitted(() =>
    submitOrApply(
      { userId },
      { kind: "accessListEntryRemove", payload: { id: accessListId, entryIds: [entryId] } },
    ),
  );
  revalidatePath("/access-lists");
  return list;
}

export async function bulkDeleteEntriesAction(accessListId: number, entryIds: number[]) {
  const session = await requireCan("accessLists:write");
  const userId = Number(session.user.id);
  const list = await orSubmitted(() =>
    submitOrApply(
      { userId },
      { kind: "accessListEntryRemove", payload: { id: accessListId, entryIds } },
    ),
  );
  revalidatePath("/access-lists");
  return list;
}

async function regeneratePasswordActionUntranslated(
  accessListId: number,
  entryId: number,
  newPassword: string,
) {
  const session = await requireCan("accessLists:write");
  const userId = Number(session.user.id);
  // Replaced as remove-and-add under the same username, which has to be read first.
  const listBefore = await getAccessList(accessListId);
  if (!listBefore) throw domainError("accessListNotFound");
  const entry = listBefore.entries.find((e) => e.id === entryId);
  if (!entry) throw domainError("accessListEntryNotFound");

  await removeAccessListEntry(accessListId, entryId, userId);
  const list = await addAccessListEntry(
    accessListId,
    { username: entry.username, password: newPassword },
    userId,
  );
  revalidatePath("/access-lists");
  return list;
}

/** Returns the updated list, so it reports failure by throwing - translated on the way out. */
export async function regeneratePasswordAction(
  accessListId: number,
  entryId: number,
  newPassword: string,
) {
  return withTranslatedErrors(() =>
    regeneratePasswordActionUntranslated(accessListId, entryId, newPassword),
  );
}
