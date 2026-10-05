/**
 * Shims `app/(dashboard)/l4-proxy-hosts/actions` (aliased in astro.config.mjs). A save succeeds,
 * closing the editor, and the posted form goes to the demo to show what it sent.
 */
import type { ActionState } from "@cpm/controller/src/lib/errors/action-error";
import { t } from "../catalog";

export type SavedL4Host = { id: number | null; form: FormData };

const listeners = new Set<(saved: SavedL4Host) => void>();

/** Until the returned function is called. */
export function onL4HostSaved(listener: (saved: SavedL4Host) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
