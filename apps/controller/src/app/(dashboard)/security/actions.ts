"use server";

import { unstable_rethrow } from "next/navigation";
import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  type ActionState,
  actionSuccess,
  extractErrorMessage,
} from "@/src/lib/errors/action-error";
import {
  type BlockedSourceInput,
  createBlockedSource,
  deleteBlockedSource,
} from "@/src/lib/models/blocked-sources";

async function failure(error: unknown, fallbackKey: "blockFailed" | "unblockFailed") {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return {
    status: "error",
    message: extractErrorMessage(t, error, t(`security.${fallbackKey}`), format),
  } satisfies ActionState;
}

/** Re-applies the config, so the block holds once this returns. */
export async function blockSourceAction(input: BlockedSourceInput): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const source = await createBlockedSource(input, Number(session.user.id));
    revalidatePath("/security");
    revalidatePath("/security/blocked-sources");
    const t = await getTranslations("security");
    return actionSuccess(t("blocked", { value: source.value }));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "blockFailed");
  }
}

export async function unblockSourceAction(id: number): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    await deleteBlockedSource(id, Number(session.user.id));
    revalidatePath("/security");
    revalidatePath("/security/blocked-sources");
    const t = await getTranslations("security");
    return actionSuccess(t("unblocked"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "unblockFailed");
  }
}
