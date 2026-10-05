/**
 * Shims `app/(dashboard)/l4-proxy-hosts/actions` (aliased in astro.config.mjs). A save succeeds,
 * closing the editor, and the posted form goes to the demo to show what it sent. The review step
 * diffs the form's plain fields against the host the demo registered, with the real diff code.
 */
import type { ActionState } from "@cpm/controller/src/lib/errors/action-error";
import { diffHostFields } from "@cpm/controller/src/lib/host-review/diff";
import type {
  HostChangePreview,
  HostPreviewResult,
  ImpactWarning,
} from "@cpm/controller/src/lib/host-review/types";
import type { L4ProxyHost } from "@cpm/controller/src/lib/models/l4-proxy-hosts";
import { t } from "../catalog";

export type SavedL4Host = { id: number | null; form: FormData };

const listeners = new Set<(saved: SavedL4Host) => void>();

/** Until the returned function is called. */
export function onL4HostSaved(listener: (saved: SavedL4Host) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type DemoAgent = { id: number; name: string; connected: boolean };
let demoHosts: L4ProxyHost[] = [];
let demoAgents: DemoAgent[] = [];

/** What the review compares against; the demo's own hosts and agents. */
export function registerL4DemoHosts(hosts: L4ProxyHost[], agents: DemoAgent[]): void {
  demoHosts = hosts;
  demoAgents = agents;
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 500));

async function save(id: number | null, formData: FormData): Promise<ActionState> {
  await pause();
  for (const listener of listeners) listener({ id, form: formData });
  return {
    status: "success",
    message: t(id === null ? "l4ProxyHosts.hostCreated" : "l4ProxyHosts.hostUpdated"),
  };
}

export async function createL4ProxyHostAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return save(null, formData);
}

export async function updateL4ProxyHostAction(
  id: number,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return save(id, formData);
}

export async function deleteL4ProxyHostAction(
  _id: number,
  _previous: ActionState,
): Promise<ActionState> {
  await pause();
  return { status: "success" };
}

export async function toggleL4ProxyHostAction(
  _id: number,
  _enabled: boolean,
): Promise<ActionState> {
  return { status: "success" };
}

const BLANK: Record<string, unknown> = {
  name: "",
  description: null,
  tags: [],
  enabled: true,
  protocol: "tcp",
  listenAddress: "",
  agentIds: [],
  matcherType: "none",
  matcherValue: [],
  tlsTermination: false,
  proxyProtocolReceive: false,
  upstreams: [],
  upstreamPortMode: "fixed",
  proxyProtocolVersion: null,
  accessListId: null,
  crowdsec: true,
};

const list = (value: FormDataEntryValue | null, split: RegExp) =>
  String(value ?? "")
    .split(split)
    .map((item) => item.trim())
    .filter(Boolean);

/** The plain fields only; nested settings are left as stored, so they never show as changed. */
function formFields(form: FormData, agents: DemoAgent[]): Record<string, unknown> {
  const names = new Map(agents.map((agent) => [String(agent.id), agent.name]));
  const reverted = new Set(form.getAll("revertField").map(String));
  const fields: Record<string, unknown> = {
    name: String(form.get("name") ?? "").trim(),
    description: String(form.get("description") ?? "").trim() || null,
    tags: form.getAll("tag").map(String).sort(),
    enabled: form.get("enabled") === "on",
    protocol: String(form.get("protocol") ?? "tcp"),
    listenAddress: String(form.get("listenAddress") ?? "").trim(),
    agentIds: form
      .getAll("agentId")
      .map((id) => names.get(String(id)) ?? `#${id}`)
      .sort(),
    matcherType: String(form.get("matcherType") ?? "none"),
    matcherValue: list(form.get("matcherValue"), /,/),
    tlsTermination: form.get("tlsTermination") === "on",
    proxyProtocolReceive: form.get("proxyProtocolReceive") === "on",
    upstreams: list(form.get("upstreams"), /\n/),
    upstreamPortMode: form.get("upstreamPortMode") === "same" ? "same" : "fixed",
    proxyProtocolVersion:
      form.get("proxyProtocolVersion") === "__none__" ? null : form.get("proxyProtocolVersion"),
  };
  for (const field of reverted) delete fields[field];
  return fields;
}

export async function previewL4ProxyHostAction(
  id: number | null,
  formData: FormData,
): Promise<HostPreviewResult> {
  await pause();
  const host = demoHosts.find((candidate) => candidate.id === id) ?? null;
  const before = host ? { ...host, agentIds: [] as string[] } : null;
  const after = { ...(before ?? BLANK), ...formFields(formData, demoAgents) };
  const changes = diffHostFields("l4", before, after, BLANK);
  const warnings: ImpactWarning[] = [];
  if (!before || before.listenAddress !== after.listenAddress) {
    warnings.push({
      code: "l4PortsApply",
      severity: "info",
      values: { listen: String(after.listenAddress) },
    });
  }
  const pinned = (after.agentIds as string[]).length > 0;
  const preview: HostChangePreview = {
    kind: "l4",
    hostId: id,
    changes,
    impact: {
      reload: before === null || changes.some((c) => !["description", "tags"].includes(c.field)),
      agents: pinned
        ? demoAgents.filter((agent) => (after.agentIds as string[]).includes(agent.name))
        : demoAgents,
      everyAgent: !pinned,
      pinned,
      pinChanged: before !== null && pinned,
      certificates: [],
      warnings,
    },
  };
  return { ok: true, preview };
}
