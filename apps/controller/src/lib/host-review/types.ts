/**
 * What the review step shows before a host is saved, as the dashboard, GraphQL and REST all return
 * it. Client safe. Codes, not sentences: `hostReview.*` in the catalog renders them.
 */

export type HostKind = "http" | "l4";

export type DiffScalar = string | number | boolean | null;
/** A list of scalars stays one value: a domain list reads better whole than per index. */
export type DiffValue = DiffScalar | DiffScalar[];

/** Shown in place of anything secret-looking, on both sides of a change. */
export const MASKED_VALUE = "[masked]";

/** One setting inside a nested field, by its dotted path ("loadBalancer.policy", "zones.0.window"). */
export type LeafChange = { path: string; before: DiffValue; after: DiffValue };

export type FieldChange = {
  /** The input key a save would send; also what an undo names. */
  field: string;
  /** The editor section it sits in, for grouping and the jump back to it. */
  section: string;
  /** Null for a nested field, which lists `leaves` instead. */
  before: DiffValue;
  after: DiffValue;
  leaves: LeafChange[] | null;
  /** A secret-looking value was replaced by MASKED_VALUE somewhere in this change. */
  masked: boolean;
  /** False for what a new host cannot be saved without. */
  revertible: boolean;
};

export const IMPACT_WARNINGS = [
  "domainInUse",
  "protectionRemoved",
  "signInChanged",
  "wafDetectionOnly",
  "rateLimitModeChanged",
  "accessListDenyResponse",
  "accessListFailClosed",
  "accessListGeoRules",
  "accessListEmpty",
  "certificateDoesNotCover",
  "hostDisabled",
  "maintenanceOn",
  "l4PortsApply",
  "agentOffline",
] as const;
export type ImpactWarningCode = (typeof IMPACT_WARNINGS)[number];

export type ImpactWarning = {
  code: ImpactWarningCode;
  severity: "warning" | "info";
  values: Record<string, string | number>;
};

export type ImpactAgent = { id: number; name: string; connected: boolean };

export type HostChangeImpact = {
  /** False when nothing that reaches Caddy changed (notes and tags only, or nothing at all). */
  reload: boolean;
  /** The agents whose Caddy is sent a new config: those serving the host before or after. */
  agents: ImpactAgent[];
  /** The host is served by every agent, as an unpinned one is. */
  everyAgent: boolean;
  /** Pinned to some agents after the save. */
  pinned: boolean;
  pinChanged: boolean;
  /** Names Caddy will request a certificate for, new with this save. */
  certificates: { domain: string; wildcard: boolean }[];
  warnings: ImpactWarning[];
};

export type HostChangePreview = {
  kind: HostKind;
  /** Null for a host not created yet. */
  hostId: number | null;
  changes: FieldChange[];
  impact: HostChangeImpact;
};

export type HostPreviewResult =
  | { ok: true; preview: HostChangePreview }
  | { ok: false; message: string };
