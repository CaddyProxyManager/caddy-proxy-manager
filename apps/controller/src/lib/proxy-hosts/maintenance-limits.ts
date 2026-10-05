/**
 * Maintenance mode's limits, shared by the host editor and the model. Separate from
 * `proxy-hosts/maintenance.ts`, which reaches node:net and so cannot reach a client component.
 */

export const MAINTENANCE_BYPASS_MAX = 100;
export const MAINTENANCE_RETRY_AFTER_MAX = 7 * 86_400;
export const MAINTENANCE_BODY_MAX = 65_536;
