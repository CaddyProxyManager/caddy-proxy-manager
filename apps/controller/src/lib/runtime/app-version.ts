// Inlined at build time by vite.config.ts (APP_VERSION build arg, else package.json) as a define,
// so the rest of the manifest stays out of the client bundle.
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "unknown";

export const PRODUCT_NAME = "Caddy Proxy Manager";

export function formatAppVersion(version: string = APP_VERSION): string {
  return `v${version}`;
}

/**
 * The line under the app's name: `versionLabel` ("Version 3.8.0", from the catalog) while the name
 * is the product's own, else the product and version, since a custom name no longer says what runs.
 */
export function appVersionLabel(
  appName: string,
  versionLabel: string,
  version: string = APP_VERSION,
): string {
  return appName.trim() === PRODUCT_NAME
    ? versionLabel
    : `${PRODUCT_NAME} ${formatAppVersion(version)}`;
}
