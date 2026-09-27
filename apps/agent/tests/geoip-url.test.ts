import { describe, expect, it } from "bun:test";
import { geoipControllerUrl } from "../src/analytics/geoip";

describe("geoipControllerUrl", () => {
  it("prefers the address the agent is paired with", () => {
    expect(geoipControllerUrl("http://web:3000", "https://cpm.example.com/api/agent/geoip")).toBe(
      "http://web:3000",
    );
  });

  // The pushed URL already ends in the route the fetch appends, which would double it and 404.
  it("strips the route from the pushed URL rather than doubling it", () => {
    expect(geoipControllerUrl(null, "https://cpm.example.com/api/agent/geoip/")).toBe(
      "https://cpm.example.com",
    );
  });

  it("keeps a pushed URL that is already an origin", () => {
    expect(geoipControllerUrl(null, "https://cpm.example.com")).toBe("https://cpm.example.com");
  });
});
