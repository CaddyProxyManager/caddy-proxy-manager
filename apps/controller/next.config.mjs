/** @type {import('next').NextConfig} */
const nextConfig = {
  // A Bun built-in, left to the runtime; there is no Node.js fallback to alias it to.
  serverExternalPackages: ["bun:sqlite"],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  output: "standalone",
  poweredByHeader: false,
  // A page's tab is a path segment (useTabRoute). Rewritten to the page itself rather than a
  // route of its own: a server action refreshes the tree of the route it was posted to, and a
  // second route there remounts the page, dropping an open dialog and a form's result.
  async rewrites() {
    const tabs = {
      waf: ["events", "exclusions", "hosts", "presets", "plugins", "settings"],
      alerts: ["rules", "channels", "history", "digests"],
      certificates: ["acme", "imported", "ca", "roles"],
      approvals: ["requests", "policy"],
    };
    // Before the file system, or the [tab] route beside each page would answer first.
    return {
      beforeFiles: Object.entries(tabs).map(([page, names]) => ({
        source: `/${page}/:tab(${names.join("|")})`,
        destination: `/${page}`,
      })),
    };
  },
  // Metadata in <head> for every request: otherwise vinext streams it into a hidden <div> where
  // `<title>` is text getByText matches. Each generateMetadata is a catalog lookup, so it is free.
  htmlLimitedBots: /.*/,
  // Security headers are per-request in src/proxy.ts, for the CSP nonce.
};

export default nextConfig;
