/** Alert channels, rules and history over GraphQL. Admin only, as the Alerts page is. */
import {
  createChannel,
  deleteChannel,
  listChannels,
  testChannel,
  updateChannel,
} from "../alerts/channel-store";
import type { ChannelInput } from "../alerts/channels";
import { type HistoryFilter, listHistory } from "../alerts/history";
import {
  createRule,
  deleteRule,
  listRules,
  type RuleInput,
  silenceRule,
  testRule,
  updateRule,
} from "../alerts/rule-store";
import { previewDigest, sendDigestNow } from "../alerts/digest-runner";
import {
  createDigest,
  type DigestInput,
  type DigestRun,
  deleteDigest,
  listDigestRuns,
  listDigests,
  updateDigest,
} from "../alerts/digests";
import { type GraphQLContext, requireAdmin } from "./context";

function runForApi(run: DigestRun | null) {
  return run && { ...run, slot: new Date(run.slot).toISOString() };
}

export const alertQueryResolvers = {
  alertChannels: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return (await listChannels()).map((channel) => ({ ...channel, signingSecret: null }));
  },
  alertRules: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return listRules();
  },
  alertHistory: async (_: unknown, args: HistoryFilter, context: GraphQLContext) => {
    await requireAdmin(context);
    return listHistory(args);
  },
  alertDigests: async (_: unknown, __: unknown, context: GraphQLContext) => {
    await requireAdmin(context);
    return (await listDigests()).map((digest) => ({
      ...digest,
      lastRun: runForApi(digest.lastRun),
    }));
  },
  alertDigestRuns: async (
    _: unknown,
    args: { digestId: number; limit?: number | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return (await listDigestRuns(args.digestId, args.limit ?? undefined)).map(runForApi);
  },
  previewAlertDigest: async (
    _: unknown,
    args: { id: number; timeZone?: string | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return previewDigest(args.id, { timeZone: args.timeZone });
  },
};

export const alertMutationResolvers = {
  createAlertChannel: async (
    _: unknown,
    args: { input: ChannelInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return createChannel(args.input, userId);
  },
  updateAlertChannel: async (
    _: unknown,
    args: { id: number; input: ChannelInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateChannel(args.id, args.input, userId);
  },
  deleteAlertChannel: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteChannel(args.id, userId);
    return true;
  },
  testAlertChannel: async (
    _: unknown,
    args: { id?: number | null; input?: ChannelInput | null },
    context: GraphQLContext,
  ) => {
    await requireAdmin(context);
    return testChannel(args.id ?? null, args.input ?? null);
  },
  createAlertRule: async (_: unknown, args: { input: RuleInput }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    return createRule(args.input, userId);
  },
  updateAlertRule: async (
    _: unknown,
    args: { id: number; input: RuleInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateRule(args.id, args.input, userId);
  },
  deleteAlertRule: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteRule(args.id, userId);
    return true;
  },
  silenceAlertRule: async (
    _: unknown,
    args: { id: number; until?: string | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return silenceRule(args.id, args.until ?? null, userId);
  },
  testAlertRule: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await requireAdmin(context);
    return testRule(args.id);
  },
  createAlertDigest: async (_: unknown, args: { input: DigestInput }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    return createDigest(args.input, userId);
  },
  updateAlertDigest: async (
    _: unknown,
    args: { id: number; input: DigestInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await requireAdmin(context);
    return updateDigest(args.id, args.input, userId);
  },
  deleteAlertDigest: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await requireAdmin(context);
    await deleteDigest(args.id, userId);
    return true;
  },
  sendAlertDigestNow: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await requireAdmin(context);
    return runForApi(await sendDigestNow(args.id));
  },
};
