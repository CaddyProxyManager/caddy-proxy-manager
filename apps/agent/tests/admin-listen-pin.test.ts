/**
 * The controller's admin block binds every interface, including the upstreams' network; and the
 * monitor's fingerprint is hashed here rather than shipped whole.
 */
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { CADDY_DIGEST_HEADER } from "@cpm/shared";
import { digestResponse, loadsConfig, pinAdminListen } from "../src/caddy-admin";

const LISTEN = "caddy-admin:2019";

function pin(config: unknown): Record<string, unknown> | null {
  const out = pinAdminListen(JSON.stringify(config), LISTEN);
  return out === null ? null : (JSON.parse(out) as Record<string, unknown>);
}

describe("pinAdminListen", () => {
  it("replaces the controller's open bind and adds the name to its origins", () => {
    const pinned = pin({
      admin: { listen: ":2019", origins: ["caddy:2019", "localhost"] },
      apps: { http: { servers: {} } },
    });
    expect(pinned?.admin).toEqual({
      listen: LISTEN,
      origins: ["caddy:2019", "localhost", LISTEN],
    });
    expect(pinned?.apps).toEqual({ http: { servers: {} } });
  });

  it("gives a config with no admin block one, rather than Caddy's localhost default", () => {
    expect(pin({ apps: {} })?.admin).toEqual({ listen: LISTEN, origins: [LISTEN] });
  });

  it("keeps the rest of the admin block and does not repeat an origin", () => {
    const pinned = pin({
      admin: { listen: "0.0.0.0:2019", origins: [LISTEN], enforce_origin: true },
    });
    expect(pinned?.admin).toEqual({ listen: LISTEN, origins: [LISTEN], enforce_origin: true });
  });

  it("refuses a body that is not a JSON object instead of forwarding it unpinned", () => {
    expect(pinAdminListen("admin :2019", LISTEN)).toBeNull();
    expect(pinAdminListen("[]", LISTEN)).toBeNull();
    expect(pinAdminListen("null", LISTEN)).toBeNull();
  });
});

describe("loadsConfig", () => {
  it("covers /load and writes to /config/, and nothing that only reads or adapts", () => {
    expect(loadsConfig({ method: "POST", path: "/load" })).toBe(true);
    expect(loadsConfig({ method: "POST", path: "/load?x=1" })).toBe(true);
    expect(loadsConfig({ method: "PATCH", path: "/config/" })).toBe(true);
    expect(loadsConfig({ method: "GET", path: "/config/" })).toBe(false);
    expect(loadsConfig({ method: "POST", path: "/adapt" })).toBe(false);
  });
});

describe("digestResponse", () => {
  it("answers a 2xx body with the hash the controller would take of it", () => {
    const text = JSON.stringify({ apps: { http: {} } });
    const digest = digestResponse({ status: 200, text, headers: { etag: "x" } });
    expect(digest).toEqual({
      status: 200,
      text: createHash("sha256").update(text).digest("hex"),
      headers: { [CADDY_DIGEST_HEADER]: "sha256" },
    });
  });

  it("leaves an error as it is, so the controller sees why", () => {
    const failed = { status: 500, text: "boom", headers: {} };
    expect(digestResponse(failed)).toBe(failed);
  });
});
