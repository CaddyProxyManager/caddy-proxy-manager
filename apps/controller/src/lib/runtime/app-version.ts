// Inlined at build time by vite.config.ts (APP_VERSION build arg, else package.json) as a define,
// so the rest of the manifest stays out of the client bundle.
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "unknown";

export function formatAppVersion(version: string = APP_VERSION): string {
  return `v${version}`;
}
