/**
 * Needs attention, the setup checklist and a host's traffic over GraphQL. Item text is rendered in
 * English from the catalog, as every API answer is; `code` and `values` are there to render it
 * in another language.
 */

import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import { NotFoundError } from "../api/auth";
import { collectAttention } from "../attention";
import { type AttentionItem, attentionMessageValues } from "../attention/types";
import { getProxyHost } from "../models/proxy-hosts";
import { getHostTrafficReport } from "../proxy-hosts/detail";
import { getSetupChecklist, setSetupChecklistHidden, setSetupStepDone } from "../setup-checklist";
import type { GraphQLContext } from "./context";

type DynamicTranslate = (key: string, values?: Record<string, string | number | Date>) => string;

const translate = createTranslator({
  locale: "en",
  messages: en,
  namespace: "attention",
}) as unknown as DynamicTranslate;

export function attentionItemForApi(item: AttentionItem) {
  const values = attentionMessageValues(item);
  return {
    id: item.id,
    provider: item.provider,
    code: item.code,
    severity: item.severity,
    title: translate(`items.${item.code}.title`, values),
    detail: translate(`items.${item.code}.detail`, values),
    values: item.values,
    href: item.href,
    at: item.at,
  };
}

export const attentionQueryResolvers = {
  attention: async (_: unknown, args: { proxyHostId?: number | null }, context: GraphQLContext) => {
    const list = await collectAttention(await context.access(), {
      proxyHostId: args.proxyHostId ?? undefined,
    });
    return { ...list, items: list.items.map(attentionItemForApi) };
  },
  setupChecklist: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    return getSetupChecklist();
  },
  proxyHostTraffic: async (_: unknown, args: { id: number }, _context: GraphQLContext) => {
    const host = await getProxyHost(args.id);
    if (!host) throw new NotFoundError("Proxy host not found");
    return getHostTrafficReport(host);
  },
};

export const attentionMutationResolvers = {
  setSetupStepDone: async (
    _: unknown,
    args: { step: string; done: boolean },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return setSetupStepDone(args.step, args.done, userId);
  },
  setSetupChecklistHidden: async (
    _: unknown,
    args: { hidden: boolean },
    context: GraphQLContext,
  ) => {
    const { userId } = await context.viewer();
    return setSetupChecklistHidden(args.hidden, userId);
  },
};
