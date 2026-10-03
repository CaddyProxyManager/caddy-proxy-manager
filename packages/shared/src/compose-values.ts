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

/**
 * `HOST:CONTAINER[/proto]`, the compose short form the controller and `docker inspect` produce.
 * Either side may be a range `A-B`, which compose requires to be the same size on both.
 */
const L4_PORT_PATTERN = /^(\d{1,5})(?:-(\d{1,5}))?:(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp))?$/;

type ParsedL4PortMapping = {
  hostStart: number;
  containerStart: number;
  count: number;
  udp: boolean;
};

function parseL4PortMapping(mapping: string): ParsedL4PortMapping | null {
  const match = L4_PORT_PATTERN.exec(mapping);
  if (!match) return null;
  const hostStart = Number(match[1]);
  const hostEnd = match[2] === undefined ? hostStart : Number(match[2]);
  const containerStart = Number(match[3]);
  const containerEnd = match[4] === undefined ? containerStart : Number(match[4]);
  const ports = [hostStart, hostEnd, containerStart, containerEnd];
  if (!ports.every((port) => port >= 1 && port <= 65535)) return null;
  if (hostEnd < hostStart || containerEnd - containerStart !== hostEnd - hostStart) return null;
  return { hostStart, containerStart, count: hostEnd - hostStart + 1, udp: match[5] === "udp" };
}

export function isValidL4PortMapping(mapping: string): boolean {
  return parseL4PortMapping(mapping) !== null;
}

/**
 * One entry per port, as `docker inspect` lists a published range, with `/tcp` dropped as compose
 * does. Sorted and deduplicated. An invalid entry is kept as it is, so a comparison still sees it
 * and the apply that refuses it runs.
 */
export function expandL4PortMappings(mappings: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const mapping of mappings) {
    const parsed = parseL4PortMapping(mapping);
    if (!parsed) {
      expanded.add(mapping);
      continue;
    }
    const suffix = parsed.udp ? "/udp" : "";
    for (let i = 0; i < parsed.count; i++) {
      expanded.add(`${parsed.hostStart + i}:${parsed.containerStart + i}${suffix}`);
    }
  }
  return Array.from(expanded).sort();
}

/** A range and its ports one by one publish the same thing; recreating Caddy over it would not. */
export function sameL4PortSet(a: readonly string[], b: readonly string[]): boolean {
  const left = expandL4PortMappings(a);
  const right = expandL4PortMappings(b);
  return left.length === right.length && left.every((port, i) => port === right[i]);
}
