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
import type { GraphQLContext } from "./context";

function runForApi(run: DigestRun | null) {
  return run && { ...run, slot: new Date(run.slot).toISOString() };
}

export const alertQueryResolvers = {
  alertChannels: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return (await listChannels()).map((channel) => ({ ...channel, signingSecret: null }));
  },
  alertRules: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return listRules();
  },
  alertHistory: async (_: unknown, args: HistoryFilter, _context: GraphQLContext) => {
    return listHistory(args);
  },
  alertDigests: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return (await listDigests()).map((digest) => ({
      ...digest,
      lastRun: runForApi(digest.lastRun),
    }));
  },
  alertDigestRuns: async (
    _: unknown,
    args: { digestId: number; limit?: number | null },
    _context: GraphQLContext,
  ) => {
    return (await listDigestRuns(args.digestId, args.limit ?? undefined)).map(runForApi);
  },
  previewAlertDigest: async (
    _: unknown,
    args: { id: number; timeZone?: string | null },
    _context: GraphQLContext,
  ) => {
    return previewDigest(args.id, { timeZone: args.timeZone });
  },
};

export const alertMutationResolvers = {
  createAlertChannel: async (
    _: unknown,
    args: { input: ChannelInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return createChannel(args.input, userId);
  },
  updateAlertChannel: async (
    _: unknown,
    args: { id: number; input: ChannelInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return updateChannel(args.id, args.input, userId);
  },
  deleteAlertChannel: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteChannel(args.id, userId);
    return true;
  },
  testAlertChannel: async (
    _: unknown,
    args: { id?: number | null; input?: ChannelInput | null },
    _context: GraphQLContext,
  ) => {
    return testChannel(args.id ?? null, args.input ?? null);
  },
  createAlertRule: async (_: unknown, args: { input: RuleInput }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    return createRule(args.input, userId);
  },
  updateAlertRule: async (
    _: unknown,
    args: { id: number; input: RuleInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return updateRule(args.id, args.input, userId);
  },
  deleteAlertRule: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteRule(args.id, userId);
    return true;
  },
  silenceAlertRule: async (
    _: unknown,
    args: { id: number; until?: string | null },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return silenceRule(args.id, args.until ?? null, userId);
  },
  testAlertRule: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
    return testRule(args.id);
  },
  createAlertDigest: async (_: unknown, args: { input: DigestInput }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    return createDigest(args.input, userId);
  },
  updateAlertDigest: async (
    _: unknown,
    args: { id: number; input: DigestInput },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return updateDigest(args.id, args.input, userId);
  },
  deleteAlertDigest: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    const { userId } = await context.viewer();
    await deleteDigest(args.id, userId);
    return true;
  },
  sendAlertDigestNow: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
    return runForApi(await sendDigestNow(args.id));
  },
};
