/**
 * The offline install page lists the third-party images from the compose file at build time; this
 * holds that list to what the air-gap manifest is written from, digest by digest.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { thirdPartyImages } from "../../../../scripts/airgap/manifest";
import { documentedThirdPartyImages } from "../../src/data/third-party-images";

const compose = readFileSync(
  fileURLToPath(new URL("../../../../docker-compose.yml", import.meta.url)),
  "utf-8",
);

test("the page lists every pinned third-party image, and only those", () => {
  const documented = documentedThirdPartyImages(compose);
  expect(documented.map((image) => image.image)).toEqual(
    thirdPartyImages(compose).map((image) => image.image),
  );
  for (const image of documented) {
    expect(image.digest, image.service).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(`${image.name}@${image.digest}`).toBe(image.image);
  }
  expect(documented.map((image) => image.service)).toContain("postgres");
});
