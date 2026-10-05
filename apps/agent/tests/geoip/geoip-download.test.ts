/**
 * Edition names and database bodies come from the controller, so neither is trusted: a name
 * becomes a path, and a body is written to the volume Caddy reads.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isGeoipEdition, syncGeoipDatabases, writeCappedDownload } from "../../src/analytics/geoip";
import { AgentStore } from "../../src/db";

let dir: string;
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-geoip-"));
  process.env.GEOIP_DIR = join(dir, "geoip");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GEOIP_DIR;
  Bun.gc(true);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a test over */
  }
});

/** A body that never ends on its own. */
function endless(): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024));
      },
    }),
  );
}

describe("writeCappedDownload", () => {
  it("installs a body under the limit", async () => {
    const target = join(dir, "GeoLite2-ASN.mmdb");
    expect(await writeCappedDownload(new Response("database"), target, 1024)).toBe(8);
    expect(readFileSync(target, "utf-8")).toBe("database");
    expect(existsSync(`${target}.download`)).toBe(false);
  });

  it("abandons a body that runs past the limit, leaving the old database in place", async () => {
    const target = join(dir, "GeoLite2-ASN.mmdb");
    writeFileSync(target, "old");
    await expect(writeCappedDownload(endless(), target, 8192)).rejects.toThrow(/limit/);
    expect(readFileSync(target, "utf-8")).toBe("old");
    expect(existsSync(`${target}.download`)).toBe(false);
  });

  it("refuses a declared length over the limit without reading it", async () => {
    const target = join(dir, "GeoLite2-ASN.mmdb");
    const response = new Response("small", { headers: { "content-length": "999999999" } });
    await expect(writeCappedDownload(response, target, 1024)).rejects.toThrow(/limit/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("syncGeoipDatabases", () => {
  it("only knows the editions the controller route serves", () => {
    expect(isGeoipEdition("GeoLite2-City")).toBe(true);
    expect(isGeoipEdition("../../etc/passwd")).toBe(false);
    expect(isGeoipEdition(42)).toBe(false);
  });

  it("never fetches or writes an edition outside the allowlist", async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (url: string) => {
      requested.push(String(url));
      return new Response("database");
    }) as unknown as typeof fetch;

    const store = new AgentStore(join(dir, "agent.db"));
    try {
      await syncGeoipDatabases(
        store,
        "http://controller.invalid",
        ["../../escape", "GeoLite2-ASN", 42],
        "agent",
        "secret",
      );
    } finally {
      store.close();
    }

    expect(requested).toHaveLength(1);
    expect(requested[0]).toEndWith("/GeoLite2-ASN");
    expect(readdirSync(join(dir, "geoip"))).toEqual(["GeoLite2-ASN.mmdb"]);
    expect(existsSync(join(dir, "escape.mmdb"))).toBe(false);
  });
});
