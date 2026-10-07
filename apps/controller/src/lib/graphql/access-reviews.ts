/** Access reviews over GraphQL: the same model and checks the page uses. */
import {
  type CampaignInput,
  createCampaign,
  decideItem,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  reassignItems,
  updateCampaign,
} from "../access-reviews";
import { closeCampaign, confirmCampaign } from "../access-reviews/apply";
import type { GraphQLContext } from "./context";

async function actor(context: GraphQLContext) {
  const [{ userId }, { capabilities }] = await Promise.all([context.viewer(), context.access()]);
  return { userId, capabilities };
}

export const accessReviewQueryResolvers = {
  accessReviews: async (_: unknown, __: unknown, context: GraphQLContext) =>
    await listCampaigns(await context.access()),
  accessReview: async (_: unknown, args: { id: number }, context: GraphQLContext) =>
    await getCampaign(args.id, await context.access()),
};

export const accessReviewMutationResolvers = {
  createAccessReview: async (_: unknown, args: { input: CampaignInput }, context: GraphQLContext) =>
    await createCampaign(args.input, await actor(context)),
  updateAccessReview: async (
    _: unknown,
    args: { id: number; input: { name?: string; dueOn?: string } },
    context: GraphQLContext,
  ) => await updateCampaign(args.id, args.input ?? {}, await actor(context)),
  reassignAccessReviewItems: async (
    _: unknown,
    args: { id: number; itemIds: number[]; reviewerId: number },
    context: GraphQLContext,
  ) => await reassignItems(args.id, args.itemIds, args.reviewerId, await actor(context)),
  decideAccessReviewItem: async (
    _: unknown,
    args: { itemId: number; decision: string; changeTo?: string | null; note?: string | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return await decideItem(args.itemId, args, userId);
  },
  closeAccessReview: async (_: unknown, args: { id: number }, context: GraphQLContext) =>
    await closeCampaign(args.id, await actor(context)),
  confirmAccessReview: async (_: unknown, args: { id: number }, context: GraphQLContext) =>
    await confirmCampaign(args.id, await actor(context)),
  deleteAccessReview: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await deleteCampaign(args.id, await actor(context));
    return true;
  },
};
