/**
 * The `docker build` an operator runs for an agent in external mode (CADDY_BUILD_MODE), which
 * never builds Caddy itself. From this release's own tag, so the go.mod pins match the controller
 * and no checkout is needed. Client-safe: the Caddy Build panel renders it.
 */

import { APP_VERSION } from "../../runtime/app-version";

export const CADDY_IMAGE_SOURCE = "https://github.com/SilentSpud/caddy-proxy-manager.git";
export const CADDY_IMAGE_DOCKERFILE = "docker/caddy/Dockerfile";
/** A tag of the operator's own: building under the shipped name, the load's pull would replace it. */
export const SUGGESTED_CADDY_IMAGE = "caddy-proxy-manager-caddy:custom";
const DEFAULT_ID = "10000";

// Both owners: installs from before the move to the org still run the first.
const SHIPPED_IMAGE =
  /^ghcr\.io\/(?:silentspud|caddyproxymanager)\/caddy-proxy-manager\/caddy(?:[:@]|$)/;
/**
 * name[:tag], registry host allowed. The agent reports it, and an agent is less trusted: anything
 * else would be pasted into a shell, so it falls back to the suggestion rather than being quoted.
 */
const IMAGE_REF =
  /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const NUMERIC_ID = /^\d{1,10}$/;

const MODULES_PER_LINE = 3;

/** A release's tag; `main` for a development build, which has none. */
export function caddyImageSourceRef(version: string = APP_VERSION): string {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? `v${version}` : "main";
}

/** Whether an agent still runs the shipped image, so it has no CADDY_IMAGE of its own yet. */
export function isShippedCaddyImage(image: string | null): boolean {
  return image === null || SHIPPED_IMAGE.test(image);
}

/** The tag to build: the agent's own when it has one, otherwise the suggestion. */
export function caddyImageTag(image: string | null): string {
  return image && !isShippedCaddyImage(image) && IMAGE_REF.test(image)
    ? image
    : SUGGESTED_CADDY_IMAGE;
}

export function caddyImageBuildCommand(options: {
  /** Module specs, already validated by the Caddy Build settings. */
  modules: readonly string[];
  image: string | null;
  puid: string;
  pgid: string;
  version?: string;
}): string {
  const id = (value: string) => (NUMERIC_ID.test(value) ? value : DEFAULT_ID);
  // A few modules per line, no backslashes: inside the quotes a newline is just part of the value,
  // and build.sh and the agent split CADDY_MODULES on any whitespace.
  const rows: string[] = [];
  for (let index = 0; index < options.modules.length; index += MODULES_PER_LINE) {
    rows.push(`    ${options.modules.slice(index, index + MODULES_PER_LINE).join(" ")}`);
  }
  const modules =
    rows.length === 0
      ? ['  --build-arg CADDY_MODULES="" \\']
      : ['  --build-arg CADDY_MODULES="', ...rows.slice(0, -1), `${rows.at(-1)}" \\`];
  return [
    "docker build \\",
    `  -f ${CADDY_IMAGE_DOCKERFILE} \\`,
    ...modules,
    `  --build-arg PUID=${id(options.puid)} --build-arg PGID=${id(options.pgid)} \\`,
    `  -t ${caddyImageTag(options.image)} \\`,
    `  ${CADDY_IMAGE_SOURCE}#${caddyImageSourceRef(options.version)}`,
  ].join("\n");
}
