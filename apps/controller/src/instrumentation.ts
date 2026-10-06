/** Next.js instrumentation hook - runs once when the server starts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The standalone build dies earlier, while linking; scripts/inject-runtime-guard.mjs covers it.
    const { assertBunRuntime } = await import("./lib/runtime/runtime-guard");
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

    const { isDemoMode } = await import("./lib/demo/mode");
    const demoMode = isDemoMode();
    if (demoMode) {
      (await import("./lib/demo/start")).installDemoCaddy();
      console.log("Demo mode: no Caddy server is configured and no DNS records are changed");
    }

    // Before anything logs an event: one written under a key the chain's seal does not match breaks it.
    const { prepareAuditChain } = await import("./lib/audit/chain");
    try {
      const outcome = await prepareAuditChain();
      if (outcome === "sealed") {
        console.log("Sealed the audit log's hash chain with SESSION_SECRET");
      }
      if (outcome === "rekeyed") {
        console.log("Re-keyed the audit log's hash chain from SESSION_SECRET_PREVIOUS");
      }
      if (outcome === "unverified") {
        console.warn(
          "The audit log's hash chain is not sealed with SESSION_SECRET and did not verify under " +
            "SESSION_SECRET_PREVIOUS; Verify integrity reports it as altered",
        );
      }
    } catch (error) {
      console.error("Failed to prepare the audit log's hash chain:", error);
    }

    // Not during a build, whose workers would each take it from the others.
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      const { claimSqliteDatabase, SqliteInUseError } = await import("./lib/db/single-process");
      try {
        claimSqliteDatabase();
      } catch (error) {
        if (error instanceof SqliteInUseError) {
          console.error(error.message);
          if (process.env.NODE_ENV === "production") throw error;
        } else {
          console.error("Could not check for another controller on the SQLite database:", error);
        }
      }
    }

    // Through the passes that rewrite rows, so replicas starting together take turns. Released
    // before the apply; one dying while holding it frees it with its connection.
    const { acquireStartupLock } = await import("./lib/db/startup-lock");
    const releaseStartupLock = await acquireStartupLock();

    // Before the passes: one re-encrypting under a different SESSION_SECRET breaks the others.
    const cluster = await import("./lib/cluster");
    try {
      await cluster.registerReplica();
    } catch (error) {
      if (error instanceof cluster.ReplicaKeyMismatchError) {
        console.error(error.message);
        if (process.env.NODE_ENV === "production") throw error;
      } else {
        console.error("Failed to register this controller replica:", error);
      }
    }

    const { ensureAdminUser } = await import("./lib/db/init");
    try {
      await ensureAdminUser();
      console.log("Database initialization complete");
    } catch (error) {
      console.error("Failed to initialize database:", error);
      // Let the app start; errors surface when users reach the features.
    }

    const { ensureUserUuids } = await import("./lib/models/user");
    try {
      const filled = await ensureUserUuids();
      if (filled > 0) console.log(`Assigned forward-auth UUIDs to ${filled} user(s)`);
    } catch (error) {
      console.error("Failed to assign user UUIDs:", error);
    }

    // Only reports: a stored username is never changed on startup.
    const { warnAboutSignInUsernamesToReview } = await import("./lib/models/user");
    try {
      await warnAboutSignInUsernamesToReview();
    } catch (error) {
      console.error("Failed to check sign-in usernames:", error);
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

    // Whether a pass below rewrote secrets, leaving their old bytes in SQLite's free pages.
    let rewroteSecrets = false;

    // Older releases stored plaintext secrets; repair before any handler reads the rows.
    const { migrateLegacyCertificateStorage } = await import("./lib/models/certificates");
    const { migrateLegacyCaCertificateStorage } = await import("./lib/models/ca-certificates");
    try {
      const migrated =
        (await migrateLegacyCertificateStorage()) + (await migrateLegacyCaCertificateStorage());
      rewroteSecrets ||= migrated > 0;
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
      rewroteSecrets ||= encrypted > 0;
      if (encrypted > 0) {
        console.log(`Encrypted DNS provider credentials stored in plaintext (${encrypted} row(s))`);
      }
    } catch (error) {
      console.error("Failed to encrypt plaintext DNS provider credentials:", error);
    }

    // Before anything decrypts to build the Caddy config, so a rotation costs one restart.
    const { reencryptStoredSecrets } = await import("./lib/secrets/rotation");
    try {
      const { reencrypted, failed, clearedOAuthTokens } = await reencryptStoredSecrets();
      rewroteSecrets ||= reencrypted > 0 || clearedOAuthTokens > 0;
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

    // secure_delete covers deletes from now on; VACUUM drops what earlier ones and the passes
    // above left in the file. Once per database, then only after a rewrite.
    const { purgeDeletedDatabaseContent } = await import("./lib/db/connection");
    if (purgeDeletedDatabaseContent(rewroteSecrets)) {
      console.log("Vacuumed the database so deleted and replaced secrets no longer remain in it");
    }

    // Before the startup apply, so the config lands on the demo agent's in-memory Caddy.
    if (demoMode) {
      try {
        await (await import("./lib/demo/start")).startSimulatedAgent();
      } catch (error) {
        console.error("Failed to start the demo agent:", error);
      }
    }

    // A controller down for days must not load a stale answer as an allow before its first lookup.
    const { expireStaleHostnames, startAccessListDnsRefresher } = await import(
      "./lib/access-lists/dns"
    );
    try {
      await expireStaleHostnames();
    } catch (error) {
      console.error("Failed to expire stale access-list hostnames:", error);
    }

    // Before the apply; the config it produces is the same, so nothing reloads differently.
    const { migrateLegacyWafSuppressions } = await import("./lib/models/waf-exclusions");
    try {
      const moved = await migrateLegacyWafSuppressions();
      if (moved > 0) console.log(`Moved ${moved} suppressed WAF rule(s) into WAF exclusions`);
    } catch (error) {
      console.error("Failed to move suppressed WAF rules into exclusions:", error);
    }

    await releaseStartupLock();

    const { applyCaddyConfig } = await import("./lib/caddy");
    try {
      console.log("Applying Caddy configuration from database...");
      await applyCaddyConfig();
      console.log("Caddy configuration applied successfully");
      // So the monitor's first pass does not build and load the same document again.
      (await import("./lib/caddy/monitor")).noteStartupApply();
    } catch (error) {
      // Caddy may not be ready yet; the monitor applies it later.
      const { CaddyApplyError } = await import("./lib/caddy/apply-error");
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

    // Every replica: it watches the agents whose streams this process holds.
    const { startCaddyMonitoring } = await import("./lib/caddy/monitor");
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
      // Expected on a fresh stack: the agent starts ClickHouse after pairing.
      console.warn(
        "ClickHouse not ready; its schema is created on the first analytics write:",
        error,
      );
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

    // The jobs below run on one replica at a time: whichever leads (lib/cluster).

    // A tick reaches MaxMind only while GeoIP is on with credentials set.
    const { startGeoipUpdater, stopGeoipUpdater } = await import("./lib/geoip/updater");
    cluster.runAsLeader({
      name: "the GeoIP updater",
      start: startGeoipUpdater,
      stop: stopGeoipUpdater,
    });

    // Looks up hostnames in access-list IP rules as their TTLs run out.
    const { stopAccessListDnsRefresher } = await import("./lib/access-lists/dns");
    cluster.runAsLeader({
      name: "the access-list hostname refresher",
      start: startAccessListDnsRefresher,
      stop: stopAccessListDnsRefresher,
    });

    // Deletes expired blocks every 30 seconds and re-applies, so one lapses within a minute.
    const { startSecurityHousekeeping, stopSecurityHousekeeping } = await import(
      "./lib/security/housekeeping"
    );
    cluster.runAsLeader({
      name: "the security housekeeping",
      start: startSecurityHousekeeping,
      stop: stopSecurityHousekeeping,
    });

    const { startCrsRegistryUpdater, stopCrsRegistryUpdater } = await import(
      "./lib/waf/crs-plugins/sync"
    );
    const { installedCrsPluginRepositories } = await import("./lib/models/crs-plugins");
    cluster.runAsLeader({
      name: "the CRS plugin registry updater",
      start: () => startCrsRegistryUpdater(installedCrsPluginRepositories),
      stop: stopCrsRegistryUpdater,
    });

    // A pass sends nothing until email is set up and the threshold is above zero.
    const { startCertificateExpiryAlerts, stopCertificateExpiryAlerts } = await import(
      "./lib/email/certificate-alerts"
    );
    cluster.runAsLeader({
      name: "the certificate expiry alerts",
      start: startCertificateExpiryAlerts,
      stop: stopCertificateExpiryAlerts,
    });

    // Queues nothing while email is off; each tick also runs the checks the events register.
    const { startNotifications, stopNotifications } = await import("./lib/notifications");
    cluster.runAsLeader({
      name: "the admin notifications",
      start: startNotifications,
      stop: stopNotifications,
    });

    try {
      await cluster.startCluster();
    } catch (error) {
      console.error("Failed to join the controller cluster:", error);
    }

    // A listener stops Node exiting on SIGTERM by itself, and nothing else here handles it: left
    // running, a replica that has left the cluster would keep taking agents nobody can reach.
    process.once("SIGTERM", () => {
      closeClickHouse();
      setTimeout(() => process.exit(0), 5_000).unref();
      void cluster.stopCluster().finally(() => process.exit(0));
    });
  }
}
