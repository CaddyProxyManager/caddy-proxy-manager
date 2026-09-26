/** Next.js instrumentation hook - runs once when the server starts. */
export async function register() {
  // Only run on the server side
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Refuse to run under anything but Bun. This catches the paths where the app gets to execute
    // at all; the standalone build dies earlier, while linking, so `bun run build` plants an
    // equivalent check atop dist/standalone/server.js (scripts/inject-runtime-guard.mjs).
    const { assertBunRuntime } = await import("./lib/runtime-guard");
    assertBunRuntime();

    // Validate production configuration early to catch misconfigurations
    const { validateProductionConfig } = await import("./lib/config");
    try {
      validateProductionConfig();
    } catch (error) {
      console.error("Configuration validation failed:", error);
      if (process.env.NODE_ENV === "production") {
        // Fail fast in production with bad config
        throw error;
      }
    }

    const { isDemoMode } = await import("./lib/demo-mode");
    const demoMode = isDemoMode();
    if (demoMode) {
      (await import("./lib/demo/start")).installDemoCaddy();
      console.log("Demo mode: no Caddy server is configured and no DNS records are changed");
    }

    const { ensureAdminUser } = await import("./lib/init-db");
    try {
      await ensureAdminUser();
      console.log("Database initialization complete");
    } catch (error) {
      console.error("Failed to initialize database:", error);
      // Don't throw - let the app start; errors surface when users reach the features
    }

    // After the seed, so an environment-configured deployment is recognised by the account it has
    // just created rather than being sent through a setup flow it does not need.
    const { backfillSetupCompletion } = await import("./lib/setup");
    try {
      await backfillSetupCompletion();
    } catch (error) {
      console.error("Failed to check first-run setup state:", error);
    }

    // With local users disabled, an OAuth provider is the only way in. Warn loudly rather than
    // throwing: an operator locked out of the UI can only recover by configuring a provider via
    // OAUTH_* environment variables, which needs the app to keep starting.
    const { config: appConfig } = await import("./lib/config");
    if (appConfig.auth.disableLocalUsers) {
      try {
        const { listEnabledOAuthProviders } = await import("./lib/models/oauth-providers");
        const providers = await listEnabledOAuthProviders();
        if (providers.length === 0) {
          console.error(
            "WARNING: AUTH_DISABLE_LOCAL_USERS=true but no OAuth provider is enabled - " +
              "no one can sign in. Configure a provider with the OAUTH_* environment variables.",
          );
        } else {
          console.log(
            `Local user management disabled - sign-in via ${providers.map((p) => p.name).join(", ")}`,
          );
        }
      } catch (error) {
        console.error("Failed to check OAuth provider availability:", error);
      }
    }

    // Imported keys and provider options could contain plaintext secrets in
    // older releases. Repair them before any request handler reads the rows.
    const { migrateLegacyCertificateStorage } = await import("./lib/models/certificates");
    const { migrateLegacyCaCertificateStorage } = await import("./lib/models/ca-certificates");
    try {
      const migrated =
        (await migrateLegacyCertificateStorage()) + (await migrateLegacyCaCertificateStorage());
      if (migrated > 0) {
        console.log(`Hardened ${migrated} legacy certificate record(s)`);
      }
    } catch (error) {
      console.error("Failed to harden legacy certificate storage");
      if (process.env.NODE_ENV === "production") throw error;
    }

    // Attached before the startup apply, so the config lands on the demo agent's in-memory Caddy.
    if (demoMode) {
      try {
        await (await import("./lib/demo/start")).startSimulatedAgent();
      } catch (error) {
        console.error("Failed to start the demo agent:", error);
      }
    }

    // Apply Caddy configuration from database on startup
    const { applyCaddyConfig } = await import("./lib/caddy");
    try {
      console.log("Applying Caddy configuration from database...");
      await applyCaddyConfig();
      console.log("Caddy configuration applied successfully");
      // So the monitor's first pass does not build and load the same document again.
      (await import("./lib/caddy-monitor")).noteStartupApply();
    } catch (error) {
      // Don't throw - Caddy may not be ready yet, or the config may be applied later; this keeps
      // proxy hosts working after a container restart
      const { CaddyApplyError } = await import("./lib/caddy-apply-error");
      if (error instanceof CaddyApplyError && error.code === "CADDY_UNREACHABLE") {
        // The usual first start: the agent has not paired yet, so it has not started Caddy.
        console.log("Caddy is not reachable yet - its configuration is applied once it comes up");
      } else if (error instanceof CaddyApplyError) {
        // The message and code, not the error: logCaddyApplyFailure already logged the details
        // under an error ID, and Bun prints a stack by quoting the minified bundle line it names.
        console.error(
          `Failed to apply Caddy configuration on startup: ${error.message} (${error.code})`,
        );
      } else {
        console.error("Failed to apply Caddy configuration on startup:", error);
      }
    }

    // Start Caddy health monitoring to detect restarts and auto-reapply config
    const { startCaddyMonitoring } = await import("./lib/caddy-monitor");
    try {
      startCaddyMonitoring();
      console.log("Caddy health monitoring started");
    } catch (error) {
      console.error("Failed to start Caddy health monitoring:", error);
      // Don't throw - monitoring is a nice-to-have feature
    }

    // Initialize ClickHouse analytics database
    const { initClickHouse, closeClickHouse } = await import("./lib/clickhouse/client");
    try {
      await initClickHouse();
      console.log("ClickHouse analytics initialized");
      if (demoMode) await (await import("./lib/demo/traffic")).startLiveDemoTraffic();
    } catch (error) {
      console.error("Failed to initialize ClickHouse:", error);
      // Don't throw - analytics is non-critical
    }

    // Leave a token on the shared volume so the agent in this same stack can pair itself, if it is
    // not paired already. Before the fleet push, so an agent that comes up while the controller is
    // still starting finds one waiting rather than idling until the next restart.
    const { ensureBootstrapToken } = await import("./lib/agent/bootstrap");
    try {
      await ensureBootstrapToken();
    } catch (error) {
      console.error("Failed to write the agent bootstrap token:", error);
    }

    // The log parsers moved to the agent: the Caddy log is a file on the agent's host, which a
    // controller elsewhere cannot read at all. Hand each agent the credentials to write its own
    // events instead.
    const { pushFleetConfig } = await import("./lib/agent/fleet-config");
    try {
      await pushFleetConfig();
    } catch (error) {
      console.error("Failed to send the fleet configuration to the agents:", error);
    }

    // After the push, not before: an agent that is about to start ClickHouse should already know
    // where to write. Reconciled on every start because the operator's own `docker compose up`
    // brings the stack back without these profiles, so a host reboot leaves them stopped.
    const { applyManagedServices } = await import("./lib/agent/managed-services");
    try {
      await applyManagedServices();
    } catch (error) {
      console.error("Failed to apply the optional services on the agents:", error);
    }

    // A tick reaches MaxMind only while GeoIP is on with credentials set.
    const { startGeoipUpdater } = await import("./lib/geoip/updater");
    try {
      startGeoipUpdater();
    } catch (error) {
      console.error("Failed to start the GeoIP updater:", error);
    }

    // Reads the CRS plugin registries and checks their plugins on the configured interval.
    const { startCrsRegistryUpdater } = await import("./lib/crs-plugins/sync");
    const { installedCrsPluginRepositories } = await import("./lib/models/crs-plugins");
    try {
      startCrsRegistryUpdater(installedCrsPluginRepositories);
    } catch (error) {
      console.error("Failed to start the CRS plugin registry updater:", error);
    }

    process.on("SIGTERM", () => {
      closeClickHouse();
    });
  }
}
