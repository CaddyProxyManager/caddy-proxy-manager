import { defineConfig, devices } from "@playwright/test";

/** Off the dev server's 4321 and the preview launch config's 4322, so either can stay running. */
const PORT = 4329;

/**
 * Runs against the built site, not `astro dev`: what is published is the bundle, and a demo that
 * only breaks once bundled (a server module pulled into the browser) is the case worth catching.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  reporter: "list",
  use: { baseURL: `http://localhost:${PORT}/` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // --ignore-lock: a preview someone already has running (one per project, whatever the port)
    // would otherwise make this exit at once, which Playwright reports as the server dying.
    command: `bun run preview --port ${PORT} --ignore-lock`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
