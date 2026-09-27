/**
 * The agent's own SQLite store: only what must survive a restart and cannot be recovered elsewhere
 * (trusted controllers, last operation). Anything the controller knows is asked for again, never
 * cached, so the two cannot diverge.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  CaddyBuildStatus,
  FleetConfig,
  L4PortsStatus,
  ManagedServiceName,
  ManagedServicesStatus,
} from "@cpm/shared";

export type PairedController = {
  controllerId: string;
  controllerName: string | null;
  secret: string;
  pairedAt: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS controllers (
  controllerId   TEXT PRIMARY KEY,
  controllerName TEXT,
  secret         TEXT NOT NULL,
  pairedAt       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

-- How far the log parsers have read. Its own table rather than more rows in state: these are
-- written on every parse tick, and keeping the hot rows apart from configuration makes it obvious
-- which of them is safe to delete when a log is rotated out from under the agent.
CREATE TABLE IF NOT EXISTS parse_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const AGENT_ID_KEY = "agent_id";
const CONTROLLER_URL_KEY = "controller_url";
const L4_STATUS_KEY = "l4_ports_status";
const BUILD_STATUS_KEY = "caddy_build_status";
const APPLIED_PORTS_KEY = "applied_l4_ports";
const APPLIED_MODULES_KEY = "applied_caddy_modules";
const FLEET_CONFIG_KEY = "fleet_config";
const SERVICES_STATUS_KEY = "managed_services_status";
const APPLIED_SERVICES_KEY = "applied_managed_services";
const CADDY_STOPPED_FOR_SHUTDOWN_KEY = "caddy_stopped_for_shutdown";

export class AgentStore {
  private readonly db: Database;

  constructor(path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path, { create: true });
    // WAL so a long-running rebuild writing progress cannot block a status read.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ─── Identity ──────────────────────────────────────────────────────────────

  /** Stable across restarts; a new id would read to the controller as a different machine. */
  agentId(): string {
    const existing = this.readState(AGENT_ID_KEY);
    if (existing) return existing;
    const id = randomBytes(16).toString("hex");
    this.writeState(AGENT_ID_KEY, id);
    return id;
  }

  // ─── Pairing ───────────────────────────────────────────────────────────────

  listControllers(): PairedController[] {
    return this.db
      .query("SELECT controllerId, controllerName, secret, pairedAt FROM controllers")
      .all() as PairedController[];
  }

  findController(controllerId: string): PairedController | null {
    const row = this.db
      .query(
        "SELECT controllerId, controllerName, secret, pairedAt FROM controllers WHERE controllerId = ?",
      )
      .get(controllerId) as PairedController | null;
    return row ?? null;
  }

  /**
   * Replaces rather than rejects, so a controller that lost its secret (rebuilt volume, restored
   * backup) can re-pair with a fresh code.
   */
  upsertController(entry: {
    controllerId: string;
    controllerName: string | null;
    secret: string;
  }): PairedController {
    const pairedAt = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO controllers (controllerId, controllerName, secret, pairedAt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(controllerId) DO UPDATE SET
           controllerName = excluded.controllerName,
           secret         = excluded.secret,
           pairedAt       = excluded.pairedAt`,
      )
      .run(entry.controllerId, entry.controllerName, entry.secret, pairedAt);
    return { ...entry, pairedAt };
  }

  /** In `state`, not a `controllers` column, to avoid migrating every agent db for one value. */
  pairedControllerUrl(): string | null {
    return this.readState(CONTROLLER_URL_KEY);
  }

  setPairedControllerUrl(url: string): void {
    this.writeState(CONTROLLER_URL_KEY, url);
  }

  /**
   * For when the controller no longer recognises this agent: a dead secret held on would make the
   * next `--pair` fail on a conflict the operator cannot see.
   */
  clearPairing(): void {
    this.db.query("DELETE FROM controllers").run();
    this.db.query("DELETE FROM state WHERE key = ?").run(CONTROLLER_URL_KEY);
  }

  // ─── Operation state ───────────────────────────────────────────────────────

  l4PortsStatus(): L4PortsStatus {
    return this.readJson<L4PortsStatus>(L4_STATUS_KEY) ?? { state: "idle" };
  }

  setL4PortsStatus(status: L4PortsStatus): void {
    this.writeState(L4_STATUS_KEY, JSON.stringify(status));
  }

  caddyBuildStatus(): CaddyBuildStatus {
    return this.readJson<CaddyBuildStatus>(BUILD_STATUS_KEY) ?? { state: "idle" };
  }

  setCaddyBuildStatus(status: CaddyBuildStatus): void {
    this.writeState(BUILD_STATUS_KEY, JSON.stringify(status));
  }

  managedServicesStatus(): ManagedServicesStatus {
    return this.readJson<ManagedServicesStatus>(SERVICES_STATUS_KEY) ?? { state: "idle" };
  }

  setManagedServicesStatus(status: ManagedServicesStatus): void {
    this.writeState(SERVICES_STATUS_KEY, JSON.stringify(status));
  }

  /**
   * Null means the controller never spoke about these, so services started by hand with
   * COMPOSE_PROFILES are still the operator's; "both false" means it asked for them off.
   */
  appliedManagedServices(): Record<ManagedServiceName, boolean> | null {
    return this.readJson<Record<ManagedServiceName, boolean>>(APPLIED_SERVICES_KEY);
  }

  setAppliedManagedServices(services: Record<ManagedServiceName, boolean>): void {
    this.writeState(APPLIED_SERVICES_KEY, JSON.stringify(services));
  }

  /**
   * Not parsed from the compose override, which holds what the *next* recreate will use; written
   * only once a recreate succeeds.
   */
  appliedL4Ports(): string[] {
    return this.readJson<string[]>(APPLIED_PORTS_KEY) ?? [];
  }

  setAppliedL4Ports(ports: string[]): void {
    this.writeState(APPLIED_PORTS_KEY, JSON.stringify(ports));
  }

  /**
   * The controller emits no module outside this list, since Caddy rejects a document naming an
   * unknown one in full. Null means never rebuilt: the shipped image's full catalog.
   */
  appliedCaddyModules(): string[] | null {
    return this.readJson<string[]>(APPLIED_MODULES_KEY);
  }

  setAppliedCaddyModules(modules: string[]): void {
    this.writeState(APPLIED_MODULES_KEY, JSON.stringify(modules));
  }

  /**
   * An explicit stop survives `restart: unless-stopped`, and the agent only starts Caddy when the
   * controller says so; this flag brings Caddy back after a reboot without waiting for it.
   */
  caddyStoppedForShutdown(): boolean {
    return this.readState(CADDY_STOPPED_FOR_SHUTDOWN_KEY) === "true";
  }

  setCaddyStoppedForShutdown(stopped: boolean): void {
    if (stopped) {
      this.writeState(CADDY_STOPPED_FOR_SHUTDOWN_KEY, "true");
    } else {
      this.db.query("DELETE FROM state WHERE key = ?").run(CADDY_STOPPED_FOR_SHUTDOWN_KEY);
    }
  }

  // ─── Fleet configuration ───────────────────────────────────────────────────

  /**
   * Persisted so analytics resume after a restart. Unencrypted: this file already holds the pairing
   * secrets that grant container control, so a database password beside them adds nothing.
   */
  fleetConfig(): FleetConfig | null {
    return this.readJson<FleetConfig>(FLEET_CONFIG_KEY);
  }

  setFleetConfig(config: FleetConfig): void {
    this.writeState(FLEET_CONFIG_KEY, JSON.stringify(config));
  }

  // ─── Log parse offsets ─────────────────────────────────────────────────────

  parseState(key: string): string | null {
    const row = this.db.query("SELECT value FROM parse_state WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  setParseState(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO parse_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ─── Key/value plumbing ────────────────────────────────────────────────────

  private readState(key: string): string | null {
    const row = this.db.query("SELECT value FROM state WHERE key = ?").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  private readJson<T>(key: string): T | null {
    const raw = this.readState(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Only an edited or truncated file gets here; no value beats crashing every status read.
      console.warn(`[agent] discarding unparseable state row "${key}"`);
      return null;
    }
  }

  private writeState(key: string, value: string): void {
    this.db
      .query(
        `INSERT INTO state (key, value, updatedAt) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
      )
      .run(key, value, new Date().toISOString());
  }
}
