"use server";

import { unstable_rethrow } from "next/navigation";
import { requireCan } from "@/src/lib/users/permissions";
import { revalidatePath } from "next/cache";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  actionSuccess,
  extractErrorMessage,
  storedErrorMessage,
  type ActionState,
} from "@/src/lib/errors/action-error";
import type { WafExclusionInput } from "@/src/lib/models/waf-exclusions";
import { submitOrApply } from "@/src/lib/approvals";
import { ChangeSubmitted } from "@/src/lib/approvals/submitted";
import {
  type WafEventDetail,
  type WafEventVerdict,
  getWafEventDetail,
  reviewWafEvent,
} from "@/src/lib/security/waf-event";
import {
  type CrsRegistryListing as CrsRegistryRow,
  checkCrsPluginUpdates,
  installedCrsPluginRepositories,
  listCrsRegistry,
  retryCrsPlugin,
} from "@/src/lib/models/crs-plugins";
import {
  type CrsRegistrySettings,
  type CrsRegistrySettingsInput,
  getCrsRegistrySettings,
  saveCrsRegistrySettings,
} from "@/src/lib/waf/crs-plugins/settings";
import {
  type CrsRegistryState,
  getCrsRegistryState,
  runCrsRegistrySync,
} from "@/src/lib/waf/crs-plugins/sync";

type FallbackKey =
  | "presetSaveFailed"
  | "presetDeleteFailed"
  | "pluginRegistryFailed"
  | "pluginInstallFailed"
  | "pluginUpdateFailed"
  | "pluginConfigFailed"
  | "pluginUninstallFailed"
  | "pluginRegistrySaveFailed"
  | "pluginRegistryCheckFailed"
  | "pluginRetryError"
  | "exclusionSaveFailed"
  | "exclusionDeleteFailed"
  | "eventDetailFailed"
  | "reviewFailed";

async function failure(error: unknown, fallbackKey: FallbackKey) {
  const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
  return {
    // Held for approval is not a failure; the message says which request it became.
    status: error instanceof ChangeSubmitted ? "success" : "error",
    message: extractErrorMessage(t, error, t(`waf.${fallbackKey}`), format),
  } satisfies ActionState;
}

/** Creates when the form carries no id, updates otherwise. */
export async function saveWafPresetAction(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const userId = Number(session.user.id);
    const input = {
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      directives: String(formData.get("directives") ?? ""),
    };
    const id = Number(formData.get("id"));
    const t = await getTranslations("waf");
    if (Number.isInteger(id) && id > 0) {
      await submitOrApply({ userId }, { kind: "wafPresetUpdate", payload: { id, input } });
      revalidatePath("/waf");
      return actionSuccess(t("presetUpdated", { name: input.name.trim() }));
    }
    await submitOrApply({ userId }, { kind: "wafPresetCreate", payload: { input } });
    revalidatePath("/waf");
    return actionSuccess(t("presetCreated", { name: input.name.trim() }));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "presetSaveFailed");
  }
}

export async function deleteWafPresetAction(id: number): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "wafPresetDelete", payload: { id } },
    );
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return actionSuccess(t("presetDeleted"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "presetDeleteFailed");
  }
}

// ── CRS plugins ──────────────────────────────────────────────────────

export type CrsRegistryOverview = {
  entries: CrsRegistryRow[];
  settings: CrsRegistrySettings;
  checkedAt: string | null;
  /** Why the last check stopped short, in the reader's language. */
  error: string | null;
  /** Registries that could not be read, by name. */
  sourceErrors: { name: string; message: string }[];
};

export type CrsRegistryListing =
  | ({ status: "success" } & CrsRegistryOverview)
  | { status: "error"; message: string };

async function overview(state?: CrsRegistryState): Promise<CrsRegistryOverview> {
  const [entries, settings, t] = await Promise.all([
    listCrsRegistry(),
    getCrsRegistrySettings(),
    getTranslations(),
  ]);
  const current = state ?? (await getCrsRegistryState());
  return {
    entries,
    settings,
    checkedAt: current.checkedAt,
    error: current.error ? storedErrorMessage(t, current.error.message, current.error.code) : null,
    sourceErrors: settings.registries.flatMap((source) => {
      const failed = current.sources[source.id]?.error;
      return failed
        ? [{ name: source.name, message: storedErrorMessage(t, failed.message, failed.code) }]
        : [];
    }),
  };
}

/** From what the last check stored; only a registry not read yet is fetched, with no API calls. */
export async function listCrsRegistryAction(): Promise<CrsRegistryListing> {
  try {
    await requireCan("security:read");
    return { status: "success", ...(await overview()) };
  } catch (error) {
    unstable_rethrow(error);
    const result = await failure(error, "pluginRegistryFailed");
    return { status: "error", message: result.message };
  }
}

/** Re-reads every registry and checks each plugin now, waiting for the pass to finish. */
export async function checkCrsRegistryNowAction(): Promise<CrsRegistryListing> {
  try {
    await requireCan("security:read");
    const state = await runCrsRegistrySync({
      extraRepositories: await installedCrsPluginRepositories(),
    });
    revalidatePath("/waf");
    return { status: "success", ...(await overview(state)) };
  } catch (error) {
    unstable_rethrow(error);
    const result = await failure(error, "pluginRegistryCheckFailed");
    return { status: "error", message: result.message };
  }
}

export async function saveCrsRegistrySettingsAction(
  input: CrsRegistrySettingsInput,
): Promise<ActionState> {
  try {
    await requireCan("security:write");
    const changed = await saveCrsRegistrySettings(input);
    // Checked in the background: a first check of a new registry takes a while, and the table
    // shows its plugins as soon as the list alone is read.
    if (changed) {
      void installedCrsPluginRepositories()
        .then((extraRepositories) => runCrsRegistrySync({ extraRepositories }))
        .catch((error: unknown) => console.error("[crs-plugins] registry check failed:", error));
    }
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return actionSuccess(t("pluginRegistrySaved"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "pluginRegistrySaveFailed");
  }
}

export async function installCrsPluginAction(
  registryId: string,
  name: string,
): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const plugin = await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "crsPluginInstall", payload: { registryId, name } },
    );
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return actionSuccess(t("pluginInstalled", { name: plugin.name, version: plugin.version }));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "pluginInstallFailed");
  }
}

export type CrsPluginUpdateCheck =
  | { status: "success"; updates: Record<number, string> }
  | { status: "error"; message: string };

export async function checkCrsPluginUpdatesAction(): Promise<CrsPluginUpdateCheck> {
  try {
    await requireCan("security:read");
    return { status: "success", updates: Object.fromEntries(await checkCrsPluginUpdates()) };
  } catch (error) {
    unstable_rethrow(error);
    const result = await failure(error, "pluginUpdateFailed");
    return { status: "error", message: result.message };
  }
}

export async function updateCrsPluginAction(id: number): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const plugin = await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "crsPluginUpdate", payload: { id } },
    );
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return actionSuccess(t("pluginUpdated", { name: plugin.name, version: plugin.version }));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "pluginUpdateFailed");
  }
}

export async function saveCrsPluginConfigAction(
  id: number,
  config: string | null,
): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const plugin = await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "crsPluginConfig", payload: { id, config } },
    );
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return actionSuccess(t("pluginConfigSaved", { name: plugin.name }));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "pluginConfigFailed");
  }
}

export async function uninstallCrsPluginAction(id: number): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "crsPluginUninstall", payload: { id } },
    );
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return actionSuccess(t("pluginUninstalled"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "pluginUninstallFailed");
  }
}

/** Switches a plugin Caddy refused back on; the result says whether Caddy took it this time. */
export async function retryCrsPluginAction(id: number, name: string): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const loaded = await retryCrsPlugin(id, Number(session.user.id));
    revalidatePath("/waf");
    const t = await getTranslations("waf");
    return loaded
      ? actionSuccess(t("pluginRetryWorked", { name }))
      : { status: "error", message: t("pluginRetryFailed", { name }) };
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "pluginRetryError");
  }
}

// ── Exclusions and event review ──────────────────────────────────────

export async function saveWafExclusionAction(
  id: number | null,
  input: WafExclusionInput,
): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    const userId = Number(session.user.id);
    if (id === null) {
      await submitOrApply({ userId }, { kind: "wafExclusionCreate", payload: { input } });
    } else {
      await submitOrApply({ userId }, { kind: "wafExclusionUpdate", payload: { id, input } });
    }
    revalidatePath("/waf");
    revalidatePath("/security");
    const t = await getTranslations("waf");
    return actionSuccess(id === null ? t("exclusionCreated") : t("exclusionUpdated"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "exclusionSaveFailed");
  }
}

export async function deleteWafExclusionAction(id: number): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    await submitOrApply(
      { userId: Number(session.user.id) },
      { kind: "wafExclusionDelete", payload: { id } },
    );
    revalidatePath("/waf");
    revalidatePath("/security");
    const t = await getTranslations("waf");
    return actionSuccess(t("exclusionDeleted"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "exclusionDeleteFailed");
  }
}

export type WafEventDetailResult =
  | { status: "success"; detail: WafEventDetail }
  | { status: "error"; message: string };

export async function getWafEventDetailAction(key: string): Promise<WafEventDetailResult> {
  try {
    await requireCan("security:read");
    return { status: "success", detail: await getWafEventDetail(key) };
  } catch (error) {
    unstable_rethrow(error);
    const result = await failure(error, "eventDetailFailed");
    return { status: "error", message: result.message };
  }
}

export async function reviewWafEventAction(
  key: string,
  verdict: WafEventVerdict | null,
): Promise<ActionState> {
  try {
    const session = await requireCan("security:write");
    await reviewWafEvent(key, verdict, Number(session.user.id));
    revalidatePath("/security");
    const t = await getTranslations("waf");
    return actionSuccess(verdict === null ? t("reviewCleared") : t("reviewSaved"));
  } catch (error) {
    unstable_rethrow(error);
    return failure(error, "reviewFailed");
  }
}
