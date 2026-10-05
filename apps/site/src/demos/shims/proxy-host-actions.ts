/**
 * Stands in for `app/(dashboard)/proxy-hosts/actions` in the demos (aliased in astro.config.mjs):
 * HostDialogs imports it, and a demo that ever submits fails as a save with no controller would.
 */
import type { ActionState } from "@cpm/controller/src/lib/errors/action-error";

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
