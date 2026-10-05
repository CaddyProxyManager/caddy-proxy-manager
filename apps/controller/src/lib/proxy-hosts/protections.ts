/**
 * What stands between a client and a host's upstream, for the list's badges and the host page.
 * Pure and client safe.
 */

export const PROTECTIONS = [
  "waf",
  "signIn",
  "accessList",
  "mtls",
  "rateLimit",
  "geo",
  "crowdsec",
  "botChallenge",
] as const;
export type Protection = (typeof PROTECTIONS)[number];

/** CPM's own portal, an Authentik outpost, or another forward-auth service. */
export type SignInKind = "cpm" | "authentik" | "forwardAuth";

export type HostProtections = { active: Protection[]; signIn: SignInKind | null };

type ProtectedHost = {
  accessListId: number | null;
  waf: { enabled?: boolean } | null;
  mtls: { enabled?: boolean } | null;
  rateLimit: { enabled?: boolean } | null;
  geoblock: { enabled?: boolean } | null;
  crowdsec: boolean;
  anubis: { enabled?: boolean } | null;
  cpmForwardAuth: { enabled?: boolean } | null;
  authentik: { enabled?: boolean } | null;
  forwardAuth: { enabled?: boolean } | null;
};

export function signInKind(host: ProtectedHost): SignInKind | null {
  if (host.cpmForwardAuth?.enabled) return "cpm";
  if (host.authentik?.enabled) return "authentik";
  if (host.forwardAuth?.enabled) return "forwardAuth";
  return null;
}

/** A host's CrowdSec switch is on by default, so it counts only once CrowdSec is set up. */
export function hostProtections(host: ProtectedHost, crowdsecActive: boolean): HostProtections {
  const signIn = signInKind(host);
  const on: Record<Protection, boolean> = {
    waf: Boolean(host.waf?.enabled),
    signIn: signIn !== null,
    accessList: host.accessListId !== null,
    mtls: Boolean(host.mtls?.enabled),
    rateLimit: Boolean(host.rateLimit?.enabled),
    geo: Boolean(host.geoblock?.enabled),
    crowdsec: crowdsecActive && host.crowdsec,
    botChallenge: Boolean(host.anubis?.enabled),
  };
  return { active: PROTECTIONS.filter((key) => on[key]), signIn };
}
