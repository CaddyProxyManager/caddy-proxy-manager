/**
 * The `docker build` an operator runs for an agent in external mode (CADDY_BUILD_MODE), which
 * never builds Caddy itself. From this release's own tag, so the go.mod pins match the controller
 * and no checkout is needed. Client-safe: the Caddy Build panel renders it.
 */

import { APP_VERSION } from "./app-version";

export const CADDY_IMAGE_SOURCE = "https://github.com/SilentSpud/caddy-proxy-manager.git";
export const CADDY_IMAGE_DOCKERFILE = "docker/caddy/Dockerfile";
/** A tag of the operator's own: building under the shipped name, the load's pull would replace it. */
export const SUGGESTED_CADDY_IMAGE = "caddy-proxy-manager-caddy:custom";
const DEFAULT_ID = "10000";

const SHIPPED_IMAGE = /^ghcr\.io\/silentspud\/caddy-proxy-manager\/caddy(?:[:@]|$)/;
/**
 * name[:tag], registry host allowed. The agent reports it, and an agent is less trusted: anything
 * else would be pasted into a shell, so it falls back to the suggestion rather than being quoted.
 */
const IMAGE_REF =
  /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const NUMERIC_ID = /^\d{1,10}$/;

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
  return [
    "docker build \\",
    `  -f ${CADDY_IMAGE_DOCKERFILE} \\`,
    `  --build-arg CADDY_MODULES="${options.modules.join(" ")}" \\`,
    `  --build-arg PUID=${id(options.puid)} --build-arg PGID=${id(options.pgid)} \\`,
    `  -t ${caddyImageTag(options.image)} \\`,
    `  ${CADDY_IMAGE_SOURCE}#${caddyImageSourceRef(options.version)}`,
  ].join("\n");
}
