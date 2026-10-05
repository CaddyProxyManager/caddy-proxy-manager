"use server";

import { getFormatter, getTranslations } from "next-intl/server";
import { requireAdmin } from "@/src/lib/auth";
import { type ActionState, extractErrorMessage } from "@/src/lib/errors/action-error";
import {
  type AnalyticsView,
  createAnalyticsView,
  deleteAnalyticsView,
  listAnalyticsViews,
  updateAnalyticsView,
} from "@/src/lib/models/analytics-views";

export type AnalyticsViewResult = ActionState & { view?: AnalyticsView };

type FallbackKey = "viewSaveFailed" | "viewDeleteFailed" | "viewsLoadFailed";

async function failure(error: unknown, fallbackKey: FallbackKey): Promise<ActionState> {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return {
    status: "error",
    message: extractErrorMessage(t, error, t(`analytics.${fallbackKey}`), format),
  };
}

export async function listAnalyticsViewsAction(): Promise<
  { status: "success"; views: AnalyticsView[] } | ActionState
> {
  try {
    const session = await requireAdmin();
    return { status: "success", views: await listAnalyticsViews(Number(session.user.id)) };
  } catch (error) {
    return failure(error, "viewsLoadFailed");
  }
}

/** Creates without an id; with one, changes whichever of name, query and shared are given. */
export async function saveAnalyticsViewAction(input: {
  id?: number;
  name?: string;
  query?: string;
  shared?: boolean;
}): Promise<AnalyticsViewResult> {
  try {
    const session = await requireAdmin();
    const userId = Number(session.user.id);
    const view =
      input.id === undefined
        ? await createAnalyticsView(userId, input)
        : await updateAnalyticsView(userId, input.id, input);
    const t = await getTranslations("analytics");
    return { status: "success", message: t("viewSaved", { name: view.name }), view };
  } catch (error) {
    return failure(error, "viewSaveFailed");
  }
}

export async function deleteAnalyticsViewAction(id: number): Promise<ActionState> {
  try {
    const session = await requireAdmin();
    await deleteAnalyticsView(Number(session.user.id), id);
    const t = await getTranslations("analytics");
    return { status: "success", message: t("viewDeleted") };
  } catch (error) {
    return failure(error, "viewDeleteFailed");
  }
}
