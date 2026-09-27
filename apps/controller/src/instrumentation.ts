/** Next.js instrumentation hook - runs once when the server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The standalone build dies earlier, while linking; scripts/inject-runtime-guard.mjs covers it.
    const { assertBunRuntime } = await import("./lib/runtime-guard");
    assertBunRuntime();

    const { validateProductionConfig } = await import("./lib/config");
    try {
      validateProductionConfig();
    } catch (error) {
      console.error("Configuration validation failed:", error);
      if (process.env.NODE_ENV === "production") {
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
      // Let the app start; errors surface when users reach the features.
    }

    // After the seed, so an env-configured deployment is recognised by the account it just made.
    const { backfillSetupCompletion } = await import("./lib/setup");
    try {
      await backfillSetupCompletion();
    } catch (error) {
      console.error("Failed to check first-run setup state:", error);
    }

    // Warn, not throw: a locked-out operator recovers through OAUTH_*, which needs the app running.
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

    // Older releases stored plaintext secrets; repair before any handler reads the rows.
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

    const { encryptPlaintextDnsCredentials } = await import("./lib/settings/plaintext-credentials");
    try {
      const encrypted = await encryptPlaintextDnsCredentials();
      if (encrypted > 0) {
        console.log(`Encrypted DNS provider credentials stored in plaintext (${encrypted} row(s))`);
      }
    } catch (error) {
      console.error("Failed to encrypt plaintext DNS provider credentials:", error);
    }

    // Before anything decrypts to build the Caddy config, so a rotation costs one restart.
    const { reencryptStoredSecrets } = await import("./lib/secret-rotation");
    try {
      const { reencrypted, failed, clearedOAuthTokens } = await reencryptStoredSecrets();
      if (reencrypted > 0) {
        console.log(`Re-encrypted ${reencrypted} stored secret(s) with the current SESSION_SECRET`);
      }
      if (clearedOAuthTokens > 0) {
        console.log(
          `Cleared ${clearedOAuthTokens} stored OAuth token(s) no key decrypts; the next sign-in stores new ones`,
        );
      }
      if (failed > 0) {
        console.warn(
          `${failed} stored secret(s) listed above could not be decrypted with SESSION_SECRET or ` +
            "SESSION_SECRET_PREVIOUS; re-enter them or set SESSION_SECRET_PREVIOUS to the secret they were stored with",
        );
      }
    } catch (error) {
      // Values left behind still decrypt through the fallback keys.
      console.error("Failed to re-encrypt stored secrets:", error);
    }

    // Before the startup apply, so the config lands on the demo agent's in-memory Caddy.
    if (demoMode) {
      try {
        await (await import("./lib/demo/start")).startSimulatedAgent();
      } catch (error) {
        console.error("Failed to start the demo agent:", error);
      }
    }

    const { applyCaddyConfig } = await import("./lib/caddy");
    try {
      console.log("Applying Caddy configuration from database...");
      await applyCaddyConfig();
      console.log("Caddy configuration applied successfully");
      // So the monitor's first pass does not build and load the same document again.
      (await import("./lib/caddy-monitor")).noteStartupApply();
    } catch (error) {
      // Caddy may not be ready yet; the monitor applies it later.
      const { CaddyApplyError } = await import("./lib/caddy-apply-error");
      if (error instanceof CaddyApplyError && error.code === "CADDY_UNREACHABLE") {
        // The usual first start: the agent has not paired yet, so it has not started Caddy.
        console.log("Caddy is not reachable yet - its configuration is applied once it comes up");
      } else if (error instanceof CaddyApplyError) {
        // Not the error: it is logged under an ID, and Bun's stack quotes the minified bundle.
        console.error(
          `Failed to apply Caddy configuration on startup: ${error.message} (${error.code})`,
        );
      } else {
        console.error("Failed to apply Caddy configuration on startup:", error);
      }
    }

    const { startCaddyMonitoring } = await import("./lib/caddy-monitor");
    try {
      startCaddyMonitoring();
      console.log("Caddy health monitoring started");
    } catch (error) {
      console.error("Failed to start Caddy health monitoring:", error);
    }

    const { initClickHouse, closeClickHouse } = await import("./lib/clickhouse/client");
    try {
      await initClickHouse();
      console.log("ClickHouse analytics initialized");
      if (demoMode) await (await import("./lib/demo/traffic")).startLiveDemoTraffic();
    } catch (error) {
      console.error("Failed to initialize ClickHouse:", error);
    }

    // Before the fleet push, so an agent coming up now finds a token rather than idling.
    const { ensureBootstrapToken } = await import("./lib/agent/bootstrap");
    try {
      await ensureBootstrapToken();
    } catch (error) {
      console.error("Failed to write the agent bootstrap token:", error);
    }

    // Agents parse the Caddy log on their own host, so each gets credentials to write its events.
    const { pushFleetConfig } = await import("./lib/agent/fleet-config");
    try {
      await pushFleetConfig();
    } catch (error) {
      console.error("Failed to send the fleet configuration to the agents:", error);
    }

    // After the push, so an agent starting ClickHouse knows where to write. Every start, because a
    // plain `docker compose up` after a reboot leaves profiled services stopped.
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
