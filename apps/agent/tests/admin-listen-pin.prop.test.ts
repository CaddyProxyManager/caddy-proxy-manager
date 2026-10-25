/**
 * Property-based: whatever the controller sends as a config, what the agent forwards has the admin
 * API pinned, or is refused. Everything outside the admin block passes through untouched.
 */
import { describe, expect, it } from "bun:test";
import { loadsConfig, pinAdminListen } from "@cpm/shared";
import * as fc from "fast-check";
import { FUZZ_TIMEOUT_MS, fuzz } from "./helpers/fuzz";

const LISTEN = "caddy-admin:2019";
const isPlainObject = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

describe("pinAdminListen", () => {
  it(
    "refuses exactly the bodies that are not a JSON object, and never throws",
    () => {
      fc.assert(
        fc.property(
          fc.oneof(fc.string({ unit: "grapheme", maxLength: 200 }), fc.json()),
          (body) => {
            let parsed: unknown;
            let json = true;
            try {
              parsed = JSON.parse(body);
            } catch {
              json = false;
            }
            expect(pinAdminListen(body, LISTEN) === null).toBe(!(json && isPlainObject(parsed)));
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );

  it(
    "pins the listen, adds the name to the origins once, keeps the rest, and is idempotent",
    () => {
      fc.assert(
        fc.property(
          fc.dictionary(fc.string({ maxLength: 10 }), fc.jsonValue({ maxDepth: 3 }), {
            maxKeys: 6,
          }),
          (generated) => {
            // What the wire carries: -0 and the like do not survive JSON, so compare after it.
            const config = JSON.parse(JSON.stringify(generated)) as Record<string, unknown>;
            const pinned = pinAdminListen(JSON.stringify(config), LISTEN);
            expect(pinned).not.toBeNull();
            const out = JSON.parse(pinned as string) as Record<string, unknown>;
            const { admin: adminIn, ...restIn } = config;
            const { admin: adminOut, ...restOut } = out;
            expect(restOut).toEqual(restIn);
            const admin = adminOut as Record<string, unknown>;
            expect(admin.listen).toBe(LISTEN);
            const origins = admin.origins as string[];
            expect(origins.filter((o) => o === LISTEN).length).toBe(1);
            if (isPlainObject(adminIn)) {
              const before = adminIn as Record<string, unknown>;
              const given = Array.isArray(before.origins)
                ? before.origins.filter((o): o is string => typeof o === "string")
                : [];
              expect(origins).toEqual(given.includes(LISTEN) ? given : [...given, LISTEN]);
              for (const [key, value] of Object.entries(before)) {
                if (key !== "listen" && key !== "origins") expect(admin[key]).toEqual(value);
              }
            } else {
              expect(origins).toEqual([LISTEN]);
            }
            expect(pinAdminListen(pinned as string, LISTEN)).toBe(pinned);
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});

describe("loadsConfig", () => {
  it(
    "never throws; a query string or the method's case changes nothing",
    () => {
      const method = fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE");
      const query = fc.option(
        fc.string({ maxLength: 20 }).map((q) => `?${q}`),
        { nil: "" },
      );
      fc.assert(
        fc.property(
          fc.oneof(method, fc.string({ unit: "grapheme", maxLength: 10 })),
          fc.string({ unit: "grapheme", maxLength: 40 }),
          query,
          (m, path, q) => {
            const result = loadsConfig({ method: m, path: `${path}${q}` });
            expect(result).toBe(loadsConfig({ method: m.toLowerCase(), path }));
            expect(loadsConfig({ method: m, path: `/load${q}` })).toBe(true);
            expect(loadsConfig({ method: m, path: `/config${q}` })).toBe(m.toUpperCase() !== "GET");
          },
        ),
        fuzz,
      );
    },
    FUZZ_TIMEOUT_MS,
  );
});
