/** The cadence the controller pushes for log parsing, clamped so a bad value cannot spin the parser. */
import { describe, expect, it } from "bun:test";
import { parseIntervalFor } from "../../src/analytics/runner";

describe("parseIntervalFor", () => {
  it("keeps the old 30 seconds when the controller sent nothing", () => {
    expect(parseIntervalFor(undefined)).toBe(30_000);
    expect(parseIntervalFor(null)).toBe(30_000);
    expect(parseIntervalFor("5")).toBe(30_000);
    expect(parseIntervalFor(Number.NaN)).toBe(30_000);
  });

  it("uses a sane value as sent", () => {
    expect(parseIntervalFor(5)).toBe(5_000);
    expect(parseIntervalFor(2.5)).toBe(2_500);
  });

  it("clamps one that would spin or starve the parser", () => {
    expect(parseIntervalFor(0)).toBe(2_000);
    expect(parseIntervalFor(-4)).toBe(2_000);
    expect(parseIntervalFor(86_400)).toBe(300_000);
  });
});
