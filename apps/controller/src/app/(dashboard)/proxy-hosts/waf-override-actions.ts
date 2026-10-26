"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { submitOrApply } from "@/src/lib/approvals";
import { ChangeSubmitted } from "@/src/lib/approvals/submitted";
import {
  type ActionState,
  actionSuccess,
  extractErrorMessage,
} from "@/src/lib/errors/action-error";
import { getClientIp } from "@/src/lib/http/client-ip";
import {
  type WafOverrideResult,
  discardWafOverride,
  finishWafOverride,
  getWafOverride,
  getWafOverrideResult,
  startWafOverride,
} from "@/src/lib/models/waf-overrides";
import { assertCanManage, assertCanView, requireReach } from "@/src/lib/users/permissions";
import type { WafOverrideSession } from "@/src/lib/waf/override";

type FallbackKey = "startFailed" | "finishFailed" | "applyFailed" | "discardFailed" | "loadFailed";

async function failure(error: unknown, fallbackKey: FallbackKey): Promise<ActionState> {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return {
    // Held for approval is not a failure; the message says which request it became.
    status: error instanceof ChangeSubmitted ? "success" : "error",
    message: extractErrorMessage(t, error, t(`proxyHosts.wafOverride.${fallbackKey}`), format),
  };
}

function revalidate(hostId: number) {
  revalidatePath(`/proxy-hosts/${hostId}`);
  revalidatePath("/waf");
}

export type WafOverrideStateResult =
  | { status: "success"; session: WafOverrideSession | null }
  | { status: "error"; message: string };

/** The host's latest session, for the panel's poll while one runs. */
export async function wafOverrideStateAction(hostId: number): Promise<WafOverrideStateResult> {
  try {
    const access = await requireReach("hosts:read");
    assertCanView(access, "proxyHost", hostId);
    return { status: "success", session: await getWafOverride(hostId) };
  } catch (error) {
    unstable_rethrow(error);
    return { status: "error", message: (await failure(error, "loadFailed")).message ?? "" };
  }
}

export type WafOverrideResultState =
  | { status: "success"; result: WafOverrideResult }
  | { status: "error"; message: string };

export async function wafOverrideResultAction(
  hostId: number,
  sessionId: number,
): Promise<WafOverrideResultState> {
  try {
    const access = await requireReach("hosts:read");
    assertCanView(access, "proxyHost", hostId);
    const result = await getWafOverrideResult(sessionId);
    if (result.session.proxyHostId !== hostId) throw new Error("Session is not this host's");
    return { status: "success", result };
  } catch (error) {
    unstable_rethrow(error);
    return { status: "error", message: (await failure(error, "loadFailed")).message ?? "" };
  }
}

/**
 * The address is the caller's own, as the controller sees it behind its trusted proxies; where
 * it cannot be read (no proxy in front, so no forwarded header), the one the panel asked for.
 */
export async function startWafOverrideAction(
  hostId: number,
  address: string | null = null,
): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", hostId);
    const clientIp = address?.trim() || (await getClientIp(await headers()));
    await startWafOverride(hostId, clientIp, access.userId);
    revalidate(hostId);
    const t = await getTranslations("proxyHosts.wafOverride");
    return actionSuccess(t("started"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "startFailed");
  }
}

export async function finishWafOverrideAction(hostId: number): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", hostId);
    await finishWafOverride(hostId, access.userId);
    revalidate(hostId);
    const t = await getTranslations("proxyHosts.wafOverride");
    return actionSuccess(t("finished"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "finishFailed");
  }
}

export async function discardWafOverrideAction(
  hostId: number,
  sessionId: number,
): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", hostId);
    const session = await getWafOverride(hostId);
    if (session?.id !== sessionId) throw new Error("Session is not this host's");
    await discardWafOverride(sessionId);
    revalidate(hostId);
    const t = await getTranslations("proxyHosts.wafOverride");
    return actionSuccess(t("discarded"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "discardFailed");
  }
}

/** The chosen rules into a new preset the host selects; a policy may hold it for approval. */
export async function applyWafOverrideAction(
  hostId: number,
  sessionId: number,
  name: string,
  ruleIds: number[],
): Promise<ActionState> {
  try {
    const access = await requireReach("hosts:write");
    assertCanManage(access, "proxyHost", hostId);
    const session = await getWafOverride(hostId);
    if (session?.id !== sessionId) throw new Error("Session is not this host's");
    const { preset } = await submitOrApply(
      { userId: access.userId },
      { kind: "wafOverrideApply", payload: { hostId, sessionId, name, ruleIds } },
    );
    revalidate(hostId);
    const t = await getTranslations("proxyHosts.wafOverride");
    return actionSuccess(t("applied", { name: preset.name }));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "applyFailed");
  }
}
