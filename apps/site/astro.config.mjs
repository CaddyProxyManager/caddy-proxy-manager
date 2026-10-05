// @ts-check
import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import catppuccin from "@catppuccin/starlight";
import { defineConfig } from "astro/config";

/** @param {string} path */
const controller = (path) => fileURLToPath(new URL(`../controller/${path}`, import.meta.url));

/** Inlined the way the controller's vite.config.ts does, so the sign-in demo shows its version. */
const { version: controllerVersion } = createRequire(import.meta.url)("../controller/package.json");

/**
 * Starlight's sitemap is `sitemap-index.xml`; `/sitemap.xml` is where crawlers and people look
 * first. Copied rather than redirected: Pages can't redirect, and a crawler may not follow one.
 */
function sitemapAlias() {
  return {
    name: "sitemap-alias",
    hooks: {
      /** @param {{ dir: URL }} options */
      "astro:build:done": async ({ dir }) => {
        await copyFile(new URL("sitemap-index.xml", dir), new URL("sitemap.xml", dir));
      },
    },
  };
}

/**
 * Shims `./actions` under the folders listed here only. A plugin, since an alias on a relative
 * specifier would catch every `./actions`, and the rest stay undemoable on purpose (see AGENTS.md).
 */
function relativeActionsShim() {
  /** @type {[string, string][]} */
  const folders = [
    ["src/app/setup/", "./src/demos/shims/setup-actions.ts"],
    ["src/app/(dashboard)/access-lists/", "./src/demos/shims/access-list-actions.ts"],
  ].map(([folder, shim]) => [
    controller(folder).replaceAll("\\", "/"),
    // Slashed as Vite's own ids are, or a demo importing the shim directly gets a second copy.
    fileURLToPath(new URL(shim, import.meta.url)).replaceAll("\\", "/"),
  ]);
  return {
    name: "cpm-relative-actions-shim",
    enforce: /** @type {const} */ ("pre"),
    /**
     * @param {string} source
     * @param {string | undefined} importer
     */
    resolveId(source, importer) {
      if (source !== "./actions" || !importer) return null;
      const from = importer.replaceAll("\\", "/");
      return folders.find(([folder]) => from.startsWith(folder))?.[1] ?? null;
    },
  };
}

/**
 * `satteri` is a direct dependency on purpose: Starlight's native binding is `require`d from a
 * prerender chunk in `dist/`, which cannot see bun's `.bun/node_modules`. Remove it and the build
 * fails with "Cannot find native binding".
 */

/**
 * At the domain's root, which the docs' `/features/...` links assume. The domain itself is set in
 * the repository's Pages settings: a site deployed by Actions ignores a CNAME file.
 */
export default defineConfig({
  site: "https://caddyproxy.com",
  base: "/",
  integrations: [
    react(),
    starlight({
      title: "Caddy Proxy Manager",
      description:
        "A modern web interface for Caddy Server: reverse proxy, WAF, automatic HTTPS, mTLS, forward auth, geo blocking, L4 TCP/UDP proxying, traffic analytics and a GraphQL API.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/CaddyProxyManager/caddy-proxy-manager",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/CaddyProxyManager/caddy-proxy-manager/edit/main/apps/site/",
      },
      /*
       * Its CSS is appended after demo.css, which only reads --sl-color-*. It depends on Starlight
       * outright, not as a peer; the root package.json `overrides` pins one copy, or typecheck
       * walks a second one's uncompiled internals.
       */
      plugins: [
        catppuccin({
          dark: { flavor: "mocha", accent: "lavender" },
          light: { flavor: "latte", accent: "lavender" },
        }),
      ],
      customCss: ["./src/styles/demo.css"],
      // Hand-ordered: the order a newcomer should meet the pages, not the directory's.
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "What it is", slug: "start/what-it-is" },
            { label: "Install", slug: "start/install" },
            { label: "First run", slug: "start/first-run" },
          ],
        },
        {
          label: "Traffic",
          items: [
            { label: "Reverse proxy", slug: "features/reverse-proxy" },
            { label: "L4 TCP/UDP proxy", slug: "features/l4-proxy" },
            { label: "Certificates & HTTPS", slug: "features/certificates" },
            { label: "Dashboard host", slug: "features/dashboard-host" },
          ],
        },
        {
          label: "Protection",
          items: [
            { label: "WAF", slug: "features/waf" },
            { label: "Geo blocking", slug: "features/geo-blocking" },
            { label: "CrowdSec", slug: "features/crowdsec" },
            { label: "Bot challenge", slug: "features/bot-challenge" },
            { label: "Access lists & mTLS", slug: "features/access-control" },
            { label: "Forward auth", slug: "features/forward-auth" },
          ],
        },
        {
          label: "Operations",
          items: [
            { label: "Overview", slug: "features/overview" },
            { label: "Analytics", slug: "features/analytics" },
            { label: "Settings", slug: "features/settings" },
            { label: "Email", slug: "features/email" },
            { label: "Users, roles & groups", slug: "features/users-and-groups" },
            { label: "The agent", slug: "features/agent" },
            { label: "Caddy Build", slug: "features/caddy-build" },
            { label: "Tailscale", slug: "features/tailscale" },
            { label: "API", slug: "features/api" },
            { label: "Audit log", slug: "features/audit-log" },
          ],
        },
      ],
    }),
    sitemapAlias(),
  ],

  vite: {
    plugins: [relativeActionsShim()],
    resolve: {
      /**
       * Three controller tsconfig paths repeated (`@/*` is unused by demos), plus shims for
       * next-intl, next/navigation, the auth client, full page loads, the host and overview
       * actions. The shims must precede the `@/src/` alias, which would otherwise match first.
       */
      alias: [
        {
          find: /^@\/src\/lib\/auth\/client$/,
          replacement: fileURLToPath(new URL("./src/demos/shims/auth-client.ts", import.meta.url)),
        },
        {
          find: /^@\/src\/lib\/browser\/navigation$/,
          replacement: fileURLToPath(
            new URL("./src/demos/shims/browser-navigation.ts", import.meta.url),
          ),
        },
        {
          find: /^@\/src\/app\/\(dashboard\)\/proxy-hosts\/actions$/,
          replacement: fileURLToPath(
            new URL("./src/demos/shims/proxy-host-actions.ts", import.meta.url),
          ),
        },
        {
          find: /^@\/src\/app\/\(dashboard\)\/overview-actions$/,
          replacement: fileURLToPath(
            new URL("./src/demos/shims/overview-actions.ts", import.meta.url),
          ),
        },
        {
          find: /^@\/src\/app\/\(dashboard\)\/l4-proxy-hosts\/actions$/,
          replacement: fileURLToPath(new URL("./src/demos/shims/l4-actions.ts", import.meta.url)),
        },
        { find: /^@\/components\//, replacement: `${controller("src/components")}/` },
        { find: /^@\/lib\//, replacement: `${controller("src/lib")}/` },
        { find: /^@\/src\//, replacement: `${controller("src")}/` },
        {
          find: /^next-intl$/,
          replacement: fileURLToPath(new URL("./src/demos/shims/next-intl.ts", import.meta.url)),
        },
        {
          find: /^next\/navigation$/,
          replacement: fileURLToPath(
            new URL("./src/demos/shims/next-navigation.ts", import.meta.url),
          ),
        },
      ],
      // The controller is a symlink; a second React copy would make every demo hook throw.
      dedupe: ["react", "react-dom"],
    },
    // Read by the controller's src/lib/runtime/app-version.ts.
    define: {
      "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(controllerVersion),
    },
  },
});
