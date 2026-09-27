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
  // Metadata in <head> for every request: otherwise vinext streams it into a hidden <div> where
  // `<title>` is text getByText matches. Each generateMetadata is a catalog lookup, so it is free.
  htmlLimitedBots: /.*/,
  // Security headers are per-request in src/proxy.ts, for the CSP nonce.
};

export default nextConfig;
