/**
 * The controller's admin block binds every interface, which on a network shared with upstreams
 * hands them the admin API. The agent, and the controller's direct transport, pin it.
 */

/** Such a request carries an admin block of its own. */
export function loadsConfig(request: { method: string; path: string }): boolean {
  const path = request.path.split("?")[0];
  if (path === "/load") return true;
  return /^\/config\/?$/.test(path) && request.method.toUpperCase() !== "GET";
}

/** Null for a non-object body, which is refused rather than forwarded unpinned. */
export function pinAdminListen(body: string, listen: string): string | null {
  let config: unknown;
  try {
    config = JSON.parse(body);
  } catch {
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;

  const root = config as Record<string, unknown>;
  const admin =
    root.admin && typeof root.admin === "object" && !Array.isArray(root.admin)
      ? (root.admin as Record<string, unknown>)
      : {};
  // A named bind turns on Caddy's Host check, so the name the sender dials has to be an origin.
  const origins = Array.isArray(admin.origins)
    ? admin.origins.filter((origin): origin is string => typeof origin === "string")
    : [];
  root.admin = {
    ...admin,
    listen,
    origins: origins.includes(listen) ? origins : [...origins, listen],
  };
  return JSON.stringify(root);
}
