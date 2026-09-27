/** Pushed to the controller by the lifecycle and served to `cpm-agent` by the local routes. */

import {
  AGENT_CAPABILITIES,
  type AgentStatus,
  type ManagedServiceName,
  type ManagedServicesStatus,
} from "@cpm/shared";
import { accessLogPresent } from "./analytics/log-parser";
import { analyticsEnabled } from "./analytics/relay";
import { checkLogAccess } from "./analytics/log-access";
import type { AgentConfig } from "./config";
import type { AgentStore } from "./db";
import type { DockerHost } from "./docker";
import pkg from "../package.json";

/** From the manifest, so there is one version to bump. */
export const AGENT_VERSION: string = pkg.version;

export type StatusDeps = {
  config: AgentConfig;
  store: AgentStore;
  docker: DockerHost;
};

/** Only a plausible id: anything else would fail the controller's decoder and the whole report. */
function numericId(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  return /^\d{1,10}$/.test(trimmed) ? trimmed : "";
}

export async function buildStatus({ config, store, docker }: StatusDeps): Promise<AgentStatus> {
  return {
    agentId: store.agentId(),
    version: AGENT_VERSION,
    mode: config.mode,
    composeProject: await docker.composeProject(),
    l4Ports: {
      applied: store.appliedL4Ports(),
      status: store.l4PortsStatus(),
    },
    caddyBuild: {
      applied: store.appliedCaddyModules(),
      status: store.caddyBuildStatus(),
      ...(config.caddyBuildMode === "external"
        ? {
            external: {
              image: store.caddyImage(),
              puid: numericId(process.env.PUID),
              pgid: numericId(process.env.PGID),
            },
          }
        : {}),
    },
    services: {
      applied: store.appliedManagedServices() as Record<ManagedServiceName, boolean> | null,
      status: store.managedServicesStatus() as ManagedServicesStatus,
    },
    analytics: {
      enabled: analyticsEnabled(),
      accessLogPresent: accessLogPresent(),
    },
    // The files matter only while parsed; the directory is Caddy's either way.
    logAccess: checkLogAccess(config.caddyContainerName, analyticsEnabled()),
    capabilities: [...AGENT_CAPABILITIES],
  };
}
