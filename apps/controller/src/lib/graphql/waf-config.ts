/**
 * WAF presets, CRS plugins and the Caddy module selection over GraphQL: the same model calls and
 * approval kinds as their `/api/v1/` routes, with the routes' body checks kept as client errors.
 */

import { pushDesiredState } from "../agent/desired-state";
import { ApiClientError } from "../api/errors";
import { apiSubmitter, submitOrApply } from "../approvals";
import { applyCaddyConfig } from "../caddy";
import { getCaddyBuildDiff, sanitizeCaddyBuildSettings } from "../caddy/image-build";
import { describeModuleConflicts } from "../caddy/image-build/conflicts";
import {
  installedCrsPluginRepositories,
  listCrsPlugins,
  listCrsRegistry,
} from "../models/crs-plugins";
import { listWafPresets } from "../models/waf-presets";
import { saveCaddyBuildSettings } from "../settings";
import { getCrsRegistrySettings, saveCrsRegistrySettings } from "../waf/crs-plugins/settings";
import { runCrsRegistrySync } from "../waf/crs-plugins/sync";
import type { GraphQLContext } from "./context";

type Body = Record<string, unknown>;

function body(input: unknown): Body {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Body) : {};
}

function assertStringOrNull(value: unknown, key: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ApiClientError(`${key} must be a string`, 400);
  }
}

export const wafConfigQueryResolvers = {
  wafPresets: async (_: unknown, __: unknown, _context: GraphQLContext) => await listWafPresets(),
  crsPlugins: async (_: unknown, __: unknown, _context: GraphQLContext) => await listCrsPlugins(),
  crsPluginRegistry: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    const [plugins, settings] = await Promise.all([listCrsRegistry(), getCrsRegistrySettings()]);
    return { plugins, settings };
  },
};

export const wafConfigMutationResolvers = {
  createWafPreset: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
    const input = body(args.input);
    if (typeof input.name !== "string" || typeof input.directives !== "string") {
      throw new ApiClientError("name and directives are required", 400);
    }
    return await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "wafPresetCreate",
      payload: { input: input as never },
    });
  },
  updateWafPreset: async (
    _: unknown,
    args: { id: number; input: unknown },
    context: GraphQLContext,
  ) => {
    const input = body(args.input);
    for (const key of ["name", "description", "directives"]) assertStringOrNull(input[key], key);
    return await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "wafPresetUpdate",
      payload: { id: args.id, input: input as never },
    });
  },
  deleteWafPreset: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "wafPresetDelete",
      payload: { id: args.id },
    });
    return true;
  },

  createCrsPlugin: async (_: unknown, args: { input: unknown }, context: GraphQLContext) => {
    const input = body(args.input);
    if (typeof input.name !== "string" || !input.name.trim()) {
      throw new ApiClientError("name is required", 400);
    }
    if (input.registry !== undefined && typeof input.registry !== "string") {
      throw new ApiClientError("registry must be a string", 400);
    }
    const name = input.name.trim();
    let registry = input.registry;
    if (!registry) {
      // Optional while only one registry lists the name.
      const listed = (await listCrsRegistry()).filter((entry) => entry.name === name);
      if (listed.length > 1) {
        throw new ApiClientError("several registries list this name; say which with registry", 400);
      }
      registry = listed[0]?.registryId ?? "";
    }
    return await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "crsPluginInstall",
      payload: { registryId: registry, name },
    });
  },
  updateCrsPlugin: async (
    _: unknown,
    args: { id: number; input: unknown },
    context: GraphQLContext,
  ) => {
    const { config } = body(args.input);
    if (config !== null && typeof config !== "string") {
      throw new ApiClientError("config must be a string or null", 400);
    }
    return await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "crsPluginConfig",
      payload: { id: args.id, config },
    });
  },
  deleteCrsPlugin: async (_: unknown, args: { id: number }, context: GraphQLContext) => {
    await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "crsPluginUninstall",
      payload: { id: args.id },
    });
    return true;
  },
  updateCrsPluginFromRegistry: async (
    _: unknown,
    args: { id: number },
    context: GraphQLContext,
  ) => {
    return await submitOrApply(apiSubmitter(await context.viewer()), {
      kind: "crsPluginUpdate",
      payload: { id: args.id },
    });
  },
  checkCrsPluginRegistry: async (_: unknown, __: unknown, _context: GraphQLContext) => {
    const state = await runCrsRegistrySync({
      extraRepositories: await installedCrsPluginRepositories(),
    });
    return {
      checkedAt: state.checkedAt,
      error: state.error?.message ?? null,
      sources: state.sources,
      plugins: await listCrsRegistry(),
    };
  },
  setCrsPluginRegistrySettings: async (
    _: unknown,
    args: { input: unknown },
    _context: GraphQLContext,
  ) => {
    const input = body(args.input);
    const settings: Parameters<typeof saveCrsRegistrySettings>[0] = {};
    if (input.registries !== undefined) {
      if (
        !Array.isArray(input.registries) ||
        input.registries.some(
          (r: unknown) =>
            typeof (r as { name?: unknown })?.name !== "string" ||
            typeof (r as { url?: unknown })?.url !== "string",
        )
      ) {
        throw new ApiClientError("registries must be a list of { id?, name, url }", 400);
      }
      settings.registries = input.registries;
    }
    if (input.refreshIntervalHours !== undefined) {
      if (typeof input.refreshIntervalHours !== "number") {
        throw new ApiClientError("refreshIntervalHours must be a number", 400);
      }
      settings.refreshIntervalHours = input.refreshIntervalHours;
    }
    if (input.githubToken !== undefined) {
      if (typeof input.githubToken !== "string") {
        throw new ApiClientError("githubToken must be a string", 400);
      }
      settings.githubToken = input.githubToken;
    }
    if (await saveCrsRegistrySettings(settings)) {
      void installedCrsPluginRepositories()
        .then((extraRepositories) => runCrsRegistrySync({ extraRepositories }))
        .catch((error: unknown) => console.error("[crs-plugins] registry check failed:", error));
    }
    return await getCrsRegistrySettings();
  },

  setCaddyModules: async (_: unknown, args: { input: unknown }, _context: GraphQLContext) => {
    const input = body(args.input);
    const settings = sanitizeCaddyBuildSettings({
      modules: input.modules as never,
      customModules: input.customModules as never,
    });
    // As in Settings, or disabling an in-use module would silently drop that feature's handlers.
    const conflict = await describeModuleConflicts(settings);
    if (conflict) throw new ApiClientError(conflict, 409);
    await saveCaddyBuildSettings(settings);
    // Before the push: a Caddy the rebuild recreates resumes its autosave, which must not name a
    // module the new binary lacks.
    await applyCaddyConfig();
    await pushDesiredState();
    return { selection: settings, diff: await getCaddyBuildDiff() };
  },
};
