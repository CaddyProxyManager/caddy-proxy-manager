/**
 * Property-based: the values the agent lets reach a compose file. A range and its ports one by one
 * are the same set, an invalid entry survives expansion so the apply that refuses it still runs,
 * and no accepted module spec or certificate path holds a character the allowlists keep out.
 */
import { describe, expect, it } from "bun:test";
import {
  expandL4PortMappings,
  isValidCertificateFilePath,
  isValidL4PortMapping,
  isValidModulePath,
  isValidModuleSpec,
  sameL4PortSet,
} from "@cpm/shared";
import * as fc from "fast-check";
import { FUZZ_TIMEOUT_MS, fuzz } from "./helpers/fuzz";

const anyText = fc.string({ unit: "grapheme", maxLength: 60 });
const port = fc.integer({ min: 1, max: 65535 });
const proto = fc.constantFrom("", "/tcp", "/udp");
const single = fc.tuple(port, port, proto).map(([h, c, p]) => `${h}:${c}${p}`);
/** `h-h+n-1:c-c+n-1`, both ends in range. */
const range = fc
  .tuple(port, port, fc.integer({ min: 2, max: 64 }), proto)
  .filter(([h, c, n]) => h + n - 1 <= 65535 && c + n - 1 <= 65535)
  .map(([h, c, n, p]) => ({
    text: `${h}-${h + n - 1}:${c}-${c + n - 1}${p}`,
    ports: Array.from({ length: n }, (_, i) => `${h + i}:${c + i}${p === "/udp" ? "/udp" : ""}`),
  }));

describe("expandL4PortMappings", () => {
  it(
    "lists a range port by port, sorted, with /tcp dropped",
    () => {
      fc.assert(
        fc.property(range, ({ text, ports }) => {
          expect(expandL4PortMappings([text])).toEqual([...new Set(ports)].sort());
          expect(sameL4PortSet([text], ports)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "is idempotent, order-blind and keeps what it cannot read",
    () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.oneof(
              single,
              range.map((r) => r.text),
              anyText,
            ),
            { maxLength: 8 },
          ),
          fc.nat(),
          (mappings, seed) => {
            const expanded = expandL4PortMappings(mappings);
            expect(expandL4PortMappings(expanded)).toEqual(expanded);
            expect(expanded).toEqual([...expanded].sort());
            expect(new Set(expanded).size).toBe(expanded.length);
            for (const mapping of mappings) {
              if (!isValidL4PortMapping(mapping)) expect(expanded).toContain(mapping);
            }
            const shuffled = [...mappings].sort(() => (seed % 2 === 0 ? 1 : -1));
            expect(sameL4PortSet(mappings, shuffled)).toBe(true);
            expect(sameL4PortSet(mappings, expanded)).toBe(true);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("isValidL4PortMapping", () => {
  it(
    "accepts every in-range single port and same-size range",
    () => {
      fc.assert(
        fc.property(
          fc.oneof(
            single,
            range.map((r) => r.text),
          ),
          (mapping) => {
            expect(isValidL4PortMapping(mapping)).toBe(true);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "refuses port 0, a port past 65535, an uneven range and anything else",
    () => {
      const uneven = fc
        .tuple(port, port, fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }))
        .filter(([h, c, n, m]) => n !== m && h + n <= 65535 && c + m <= 65535)
        .map(([h, c, n, m]) => `${h}-${h + n}:${c}-${c + m}`);
      fc.assert(
        fc.property(
          fc.oneof(
            port.map((c) => `0:${c}`),
            port.map((h) => `${h}:0`),
            fc.tuple(fc.integer({ min: 65536, max: 99999 }), port).map(([h, c]) => `${h}:${c}`),
            uneven,
            single.map((s) => `${s}/sctp`),
            single.map((s) => ` ${s}`),
            anyText.filter((s) => !/^\d/.test(s)),
          ),
          (mapping) => {
            expect(isValidL4PortMapping(mapping)).toBe(false);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("module specs", () => {
  const segment = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,20}[a-zA-Z0-9]$/);
  const path = fc
    .array(segment, { minLength: 2, maxLength: 5 })
    .map((s) => s.join("/"))
    .filter((p) => p.length <= 200);
  const version = fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,20}$/);

  it(
    "accept a slash-separated path with an optional @version",
    () => {
      fc.assert(
        fc.property(path, fc.option(version, { nil: undefined }), (p, v) => {
          expect(isValidModulePath(p)).toBe(true);
          expect(isValidModuleSpec(v === undefined ? p : `${p}@${v}`)).toBe(true);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "never throw, and what they accept has one path, at most one version and nothing else",
    () => {
      fc.assert(
        fc.property(anyText, (spec) => {
          if (!isValidModuleSpec(spec)) return;
          const [modulePath, ...rest] = spec.split("@");
          expect(rest.length).toBeLessThanOrEqual(1);
          expect(modulePath).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._~/-]*[a-zA-Z0-9]$/);
          expect(modulePath).toContain("/");
          expect(modulePath.length).toBeLessThanOrEqual(200);
          if (rest.length === 1) expect(rest[0]).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("isValidCertificateFilePath", () => {
  const segment = fc.stringMatching(/^[A-Za-z0-9_@+=,*~][A-Za-z0-9._@+=,*~-]{0,30}$/);

  it(
    "accepts up to sixteen clean segments and refuses a seventeenth",
    () => {
      fc.assert(
        fc.property(fc.array(segment, { minLength: 1, maxLength: 17 }), (segments) => {
          expect(isValidCertificateFilePath(segments.join("/"))).toBe(segments.length <= 16);
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "never accepts traversal, a hidden or flag-like segment, an absolute path or a backslash",
    () => {
      fc.assert(
        fc.property(fc.oneof(anyText, fc.anything()), (path) => {
          if (!isValidCertificateFilePath(path)) return;
          expect(path.startsWith("/")).toBe(false);
          expect(path).not.toContain("\\");
          for (const segment of path.split("/")) {
            expect(segment).not.toBe("");
            expect(segment).not.toMatch(/^[.-]/);
          }
        }),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
