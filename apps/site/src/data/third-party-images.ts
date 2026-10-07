/**
 * The third-party images an offline install brings in itself, read at build time from the
 * compose file every release ships, by the same function that writes the air-gap manifest - so the
 * page cannot list an image or a digest the release does not pin.
 */
import { type ThirdPartyImage, thirdPartyImages } from "../../../../scripts/airgap/manifest";

export type DocumentedImage = ThirdPartyImage & {
  /** The reference without its digest, as a person types it into `docker pull`. */
  name: string;
  /** Compose profile it runs behind, or null when every install runs it. */
  profile: string | null;
};

/** Optional services and the profile that starts them. */
const PROFILES: Record<string, string> = { clickhouse: "clickhouse", crowdsec: "crowdsec" };

/** `compose` is the repository's docker-compose.yml, which the page imports raw. */
export function documentedThirdPartyImages(compose: string) {
  return thirdPartyImages(compose).map(
    (image): DocumentedImage => ({
      ...image,
      name: image.image.replace(/@sha256:[0-9a-f]+$/, ""),
      profile: PROFILES[image.service] ?? null,
    }),
  );
}
