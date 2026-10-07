"use server";

import { revalidatePath } from "next/cache";
import { withTranslatedErrors } from "@/src/lib/errors/translated-action";
import {
  type CampaignInput,
  type DecisionInput,
  createCampaign,
  decideItem,
  deleteCampaign,
  reassignItems,
  updateCampaign,
} from "@/src/lib/access-reviews";
import { closeCampaign, confirmCampaign } from "@/src/lib/access-reviews/apply";
import { requireUser } from "@/src/lib/auth";
import { requireCanAccess } from "@/src/lib/users/permissions";

const PAGE = "/users/access-reviews";

async function actor() {
  const { session, access } = await requireCanAccess("users:write");
  return { userId: Number(session.user.id), capabilities: access.capabilities };
}

export async function createAccessReviewAction(input: CampaignInput): Promise<number> {
  const by = await actor();
  return withTranslatedErrors(async () => {
    const campaign = await createCampaign(input, by);
    revalidatePath(PAGE);
    return campaign.id;
  });
}

export async function updateAccessReviewAction(
  id: number,
  input: { name?: string; dueOn?: string },
): Promise<void> {
  const by = await actor();
  await withTranslatedErrors(async () => {
    await updateCampaign(id, input, by);
    revalidatePath(PAGE);
  });
}

export async function reassignAccessReviewItemsAction(
  id: number,
  itemIds: number[],
  reviewerId: number,
): Promise<void> {
  const by = await actor();
  await withTranslatedErrors(async () => {
    await reassignItems(id, itemIds, reviewerId, by);
    revalidatePath(PAGE);
  });
}

export async function deleteAccessReviewAction(id: number): Promise<void> {
  const by = await actor();
  await withTranslatedErrors(async () => {
    await deleteCampaign(id, by);
    revalidatePath(PAGE);
  });
}

export async function closeAccessReviewAction(id: number): Promise<void> {
  const by = await actor();
  await withTranslatedErrors(async () => {
    await closeCampaign(id, by);
    revalidatePath(PAGE);
    revalidatePath("/users");
  });
}

export async function confirmAccessReviewAction(id: number): Promise<void> {
  const by = await actor();
  await withTranslatedErrors(async () => {
    await confirmCampaign(id, by);
    revalidatePath(PAGE);
    revalidatePath("/users");
  });
}

/** Any account: a reviewer needs no capability, and decideItem takes only their own items. */
export async function decideAccessReviewItemAction(
  itemId: number,
  input: DecisionInput,
): Promise<void> {
  const session = await requireUser();
  await withTranslatedErrors(async () => {
    await decideItem(itemId, input, Number(session.user.id));
    revalidatePath(PAGE);
  });
}
