/** Change approvals over GraphQL: the same model and checks the page uses. */
import { NotFoundError } from "../api/auth";
import {
  apiSubmitter,
  approveChange,
  bypassChange,
  getApprovalPolicy,
  getChangeRequest,
  listChangeRequests,
  rejectChange,
  submitOrApply,
  withdrawChange,
} from "../approvals";
import { readApprovalPolicy } from "../approvals/policy";
import type { GraphQLContext } from "./context";

async function viewer(context: GraphQLContext) {
  return { access: await context.access() };
}

async function answer(id: number, context: GraphQLContext) {
  const request = await getChangeRequest(id, await viewer(context));
  if (!request) throw new NotFoundError("Change request not found");
  return request;
}

export const approvalQueryResolvers = {
  changeRequests: async (
    _: unknown,
    args: { status?: string | null; limit?: number | null },
    context: GraphQLContext,
  ) =>
    listChangeRequests(await viewer(context), {
      status: args.status === "pending" || args.status === "decided" ? args.status : undefined,
      limit: args.limit ?? undefined,
    }),
  changeRequest: async (_: unknown, args: { id: number }, context: GraphQLContext) =>
    getChangeRequest(args.id, await viewer(context)),
  approvalPolicy: async () => getApprovalPolicy(),
};

export const approvalMutationResolvers = {
  approveChangeRequest: async (
    _: unknown,
    args: { id: number; note?: string | null },
    context: GraphQLContext,
  ) => {
    await approveChange(args.id, await context.access(), args.note);
    return answer(args.id, context);
  },
  rejectChangeRequest: async (
    _: unknown,
    args: { id: number; note?: string | null },
    context: GraphQLContext,
  ) => {
    await rejectChange(args.id, await context.access(), args.note);
    return answer(args.id, context);
  },
  withdrawChangeRequest: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await withdrawChange(args.id, await context.access());
    return answer(args.id, context);
  },
  bypassChangeRequest: async (
    _: unknown,
    args: { id: number; reason: string },
    context: GraphQLContext,
  ) => {
    await bypassChange(args.id, await context.access(), args.reason);
    return answer(args.id, context);
  },
  setApprovalPolicy: async (_: unknown, args: { input: unknown }, context: GraphQLContext) =>
    submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "approvalPolicy",
      payload: { policy: readApprovalPolicy(args.input) },
    }),
};
