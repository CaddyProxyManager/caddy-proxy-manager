/**
 * Desired-state values that reach a compose file or a `docker` child's environment, shared by
 * both sides. The agent re-checks them: it holds the socket, so a compromised controller must not
 * widen what a frame can do.
 */

/** Lands verbatim in a shell command in the Caddy Dockerfile, so an allowlist, not escaping. */
export const MODULE_PATH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._~/-]*[a-zA-Z0-9]$/;
export const MODULE_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;
export const MODULE_PATH_MAX_LENGTH = 200;

/** Expects it already normalized. */
export function isValidModulePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MODULE_PATH_MAX_LENGTH &&
    MODULE_PATH_PATTERN.test(path) &&
    path.includes("/")
  );
}

/** An xcaddy `--with` spec: a module path, optionally `@version`. */
export function isValidModuleSpec(spec: string): boolean {
  const at = spec.indexOf("@");
  if (at === -1) return isValidModulePath(spec);
  return isValidModulePath(spec.slice(0, at)) && MODULE_VERSION_PATTERN.test(spec.slice(at + 1));
}

/** `HOST:CONTAINER[/proto]`, the compose short form the controller and `docker inspect` produce. */
const L4_PORT_PATTERN = /^(\d{1,5}):(\d{1,5})(?:\/(?:tcp|udp))?$/;

export function isValidL4PortMapping(mapping: string): boolean {
  const match = L4_PORT_PATTERN.exec(mapping);
  if (!match) return false;
  return [match[1], match[2]].every((part) => {
    const port = Number(part);
    return port >= 1 && port <= 65535;
  });
}
