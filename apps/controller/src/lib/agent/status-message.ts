/**
 * An agent's operation status in the reader's language. Keyed at runtime by the code the agent
 * sent; tests/unit/agent/agent-status-messages.test.ts asserts the catalog covers every one.
 */

import type { AgentOperationStatus } from "@cpm/shared";
import type { useTranslations } from "next-intl";

type Translator = ReturnType<typeof useTranslations>;

type DynamicTranslate = (key: string, values?: Record<string, string | number>) => string;

export type AgentStatusWords = Pick<
  AgentOperationStatus<string>,
  "message" | "messageCode" | "messageParams"
>;

/** The agent's own English when it sent no code: an older agent, or a code it predates. */
export function agentStatusMessage(t: Translator, status: AgentStatusWords): string | null {
  if (status.messageCode) {
    return (t as unknown as DynamicTranslate)(
      `agents.statusMessages.${status.messageCode}`,
      status.messageParams,
    );
  }
  return status.message ?? null;
}
