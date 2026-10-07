"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/src/lib/errors/action-result";
import { runAction } from "@/src/lib/errors/run-action";
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

export async function createAccessReviewAction(
  input: CampaignInput,
): Promise<ActionResult<number>> {
  return runAction(async () => {
    const campaign = await createCampaign(input, await actor());
    revalidatePath(PAGE);
    return campaign.id;
  });
}

export async function updateAccessReviewAction(
  id: number,
  input: { name?: string; dueOn?: string },
): Promise<ActionResult> {
  return runAction(async () => {
    await updateCampaign(id, input, await actor());
    revalidatePath(PAGE);
  });
}

export async function reassignAccessReviewItemsAction(
  id: number,
  itemIds: number[],
  reviewerId: number,
): Promise<ActionResult> {
  return runAction(async () => {
    await reassignItems(id, itemIds, reviewerId, await actor());
    revalidatePath(PAGE);
  });
}

export async function deleteAccessReviewAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    await deleteCampaign(id, await actor());
    revalidatePath(PAGE);
  });
}

export async function closeAccessReviewAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    await closeCampaign(id, await actor());
    revalidatePath(PAGE);
    revalidatePath("/users");
  });
}

export async function confirmAccessReviewAction(id: number): Promise<ActionResult> {
  return runAction(async () => {
    await confirmCampaign(id, await actor());
    revalidatePath(PAGE);
    revalidatePath("/users");
  });
}

/** Any account: a reviewer needs no capability, and decideItem takes only their own items. */
export async function decideAccessReviewItemAction(
  itemId: number,
  input: DecisionInput,
): Promise<ActionResult> {
  return runAction(async () => {
    const session = await requireUser();
    await decideItem(itemId, input, Number(session.user.id));
    revalidatePath(PAGE);
  });
}
