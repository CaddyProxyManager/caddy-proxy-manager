/**
 * Checks an auth key via the Tailscale API: one dead key fails the apply for every host on every
 * agent. Opt-in, since the API needs an access token besides the auth key. Kept out of
 * caddy-tailscale.ts, as config generation must never touch the network.
 */

import { isCaddyPlaceholder, tailscaleKeyId } from "./caddy-tailscale";

const API_BASE = "https://api.tailscale.com/api/v2";

/** Short: this runs inside a settings save, and a hung request would hang the page. */
const REQUEST_TIMEOUT_MS = 10_000;

export type TailscaleKeyCheck =
  | { status: "ok" }
  /** Must let the save through: a Headscale key or `{env.*}` placeholder is legitimate. */
  | { status: "unknown"; reason: string }
  /** The key, or the token used to ask about it. `reason` is shown to the operator. */
  | { status: "rejected"; reason: string };

type KeyResponse = {
  id?: string;
  revoked?: string;
  invalid?: boolean;
  expires?: string;
};

/** Failure modes stay distinct: each sends the operator to fix a different thing. */
export async function checkTailscaleAuthKey(options: {
  authKey: string;
  apiAccessToken: string;
  tailnet: string;
  fetchImpl?: typeof fetch;
}): Promise<TailscaleKeyCheck> {
  const authKey = options.authKey.trim();
  const token = options.apiAccessToken.trim();

  if (!authKey) return { status: "unknown", reason: "no auth key is stored" };
  if (isCaddyPlaceholder(authKey)) {
    return {
      status: "unknown",
      reason:
        "the auth key is a Caddy placeholder, so its value only exists inside the Caddy container",
    };
  }
  if (!token) {
    return {
      status: "rejected",
      reason:
        "Checking auth keys needs a Tailscale API access token (tskey-api-…). Add one, or turn the check off.",
    };
  }

  const keyId = tailscaleKeyId(authKey);
  if (!keyId) {
    return {
      status: "unknown",
      reason:
        "the key does not carry an id the API can address - this is normal for an older key or a Headscale one",
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const url = `${API_BASE}/tailnet/${encodeURIComponent(options.tailnet)}/keys/${encodeURIComponent(keyId)}`;

  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: "rejected",
      reason: `Could not reach the Tailscale API to check the key (${
        error instanceof Error ? error.message : "network error"
      }). Try again, or turn the check off to save without it.`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: "rejected",
      reason:
        "Tailscale refused the API access token. Check the token itself - this says nothing about the auth key.",
    };
  }
  if (response.status === 404) {
    return {
      status: "rejected",
      reason: `Tailnet "${options.tailnet}" has no key with id "${keyId}". It may have been deleted, or belong to a different tailnet.`,
    };
  }
  if (!response.ok) {
    return {
      status: "rejected",
      reason: `The Tailscale API answered ${response.status} when asked about the key. Try again, or turn the check off to save without it.`,
    };
  }

  let key: KeyResponse;
  try {
    key = (await response.json()) as KeyResponse;
  } catch {
    return { status: "unknown", reason: "the Tailscale API returned a response this cannot read" };
  }

  if (key.invalid) return { status: "rejected", reason: "Tailscale reports this key as invalid." };
  if (key.revoked) {
    return { status: "rejected", reason: `This key was revoked on ${key.revoked}.` };
  }
  // Not left to `invalid`: some tailnets report expiry only through the timestamp.
  if (key.expires) {
    const expires = Date.parse(key.expires);
    if (Number.isFinite(expires) && expires <= Date.now()) {
      return { status: "rejected", reason: `This key expired on ${key.expires}.` };
    }
  }

  return { status: "ok" };
}
