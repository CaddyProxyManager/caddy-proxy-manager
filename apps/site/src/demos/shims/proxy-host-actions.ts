/**
 * Stands in for `app/(dashboard)/proxy-hosts/actions` in the demos (aliased in astro.config.mjs):
 * HostDialogs imports it, and a demo that ever submits fails as a save with no controller would.
 */
import type { ActionState } from "@cpm/controller/src/lib/errors/action-error";
import type { HostPreviewResult } from "@cpm/controller/src/lib/host-review/types";
import {
  type HostUpstreamHealth,
  summarizeUpstreamHealth,
} from "@cpm/controller/src/lib/proxy-hosts/upstream-health-summary";

const refused: ActionState = {
  status: "error",
  message: "There is no controller behind the documentation site.",
};

export async function createProxyHostAction(
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return refused;
}

export async function updateProxyHostAction(
  _id: number,
  _previous: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return refused;
}

export async function previewProxyHostAction(
  _id: number | null,
  _formData: FormData,
): Promise<HostPreviewResult> {
  return { ok: false, message: refused.message ?? "" };
}

export async function deleteProxyHostAction(
  _id: number,
  _previous: ActionState,
): Promise<ActionState> {
  return refused;
}

export async function toggleProxyHostAction(_id: number, _enabled: boolean): Promise<ActionState> {
  return refused;
}

export async function setProxyHostMaintenanceAction(
  _id: number,
  _enabled: boolean,
): Promise<ActionState> {
  return refused;
}

/** What two agents' Caddy might say about a host with two upstreams, one of them in trouble. */
export async function proxyHostUpstreamHealthAction(
  hostId: number,
): Promise<{ ok: true; health: HostUpstreamHealth } | { ok: false; message: string }> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  return {
    ok: true,
    health: summarizeUpstreamHealth({
      hostId,
      upstreams: [
        { upstream: "http://app-1:8080", dials: ["app-1:8080"] },
        { upstream: "http://app-2:8080", dials: ["app-2:8080"] },
      ],
      healthChecks: true,
      maxFails: 3,
      answers: [
        {
          agentId: 1,
          name: "edge-fra",
          entries: [
            { address: "app-1:8080", requests: 4, fails: 0 },
            { address: "app-2:8080", requests: 0, fails: 3 },
          ],
        },
        { agentId: 2, name: "edge-ams", entries: null },
      ],
    }),
  };
}
