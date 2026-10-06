"use client";

/**
 * Flags as SVG images: Windows has no emoji flags, so a regional-indicator pair renders as two
 * letters there. The whole set is one lazy chunk (about 47 KiB gzipped), fetched the first time a
 * flag is drawn, so pages without one never pay for it and a page with many fetches it once.
 */

import {
  createContext,
  useContext,
  useRef,
  useSyncExternalStore,
  type Ref,
  type SVGProps,
} from "react";
import { Globe } from "lucide-react";
import { Icon, type IconSize } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useLocale, useTranslations } from "next-intl";
import { COUNTRY_CODES } from "@/src/components/proxy-hosts/protection/countries";
import { regionName } from "@/src/lib/locale/region-names";

const KNOWN = new Set(COUNTRY_CODES);

/** An ISO 3166-1 alpha-2 country, which has a flag; GeoIP's XX, EU or AP is not one. */
export function isKnownCountry(code: string | null | undefined): code is string {
  return !!code && KNOWN.has(code.toUpperCase());
}

type FlagSvgs = Readonly<Record<string, string>>;

let svgs: FlagSvgs | null = null;
let requested = false;
const listeners = new Set<() => void>();
const urls = new Map<string, string>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!requested) {
    requested = true;
    import("country-flag-icons/string/3x2").then(
      (mod) => {
        svgs = mod as unknown as FlagSvgs;
        for (const notify of listeners) notify();
      },
      () => {
        // Let the next flag to mount retry rather than leaving every one blank for the session.
        requested = false;
      },
    );
  }
  return () => {
    listeners.delete(listener);
  };
}

const stayIdle = () => () => {};

// The server snapshot is null, so the server and the hydrating client both draw the blank first.
function useFlagUrl(code: string): string | null {
  const loaded = useSyncExternalStore(
    isKnownCountry(code) ? subscribe : stayIdle,
    () => svgs,
    () => null,
  );
  const svg = isKnownCountry(code) ? loaded?.[code] : undefined;
  if (!svg) return null;
  let url = urls.get(code);
  if (!url) {
    url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    urls.set(code, url);
  }
  return url;
}

// Same element before and after loading: the tooltip holds on to it.
const BLANK =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";

type FlagImageProps = {
  src: string;
  alt: string;
  ref?: Ref<HTMLImageElement>;
  tabIndex?: number;
};

const FlagImageContext = createContext<FlagImageProps>({ src: BLANK, alt: "" });

/** Rendered by `Icon`, which sizes it with its tokens but only hands down SVG props. */
function FlagImage({ className, style }: SVGProps<SVGSVGElement>) {
  const { src, alt, ref, tabIndex } = useContext(FlagImageContext);
  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      tabIndex={tabIndex}
      draggable={false}
      className={className}
      style={style}
    />
  );
}

function Flag({ image, size }: { image: FlagImageProps; size: IconSize }) {
  return (
    <FlagImageContext value={image}>
      <Icon icon={FlagImage} size={size} />
    </FlagImageContext>
  );
}

/**
 * A country's flag and nothing else, hidden from assistive technology: for beside its name, or
 * inside a control that already says which country it is. An unknown code gets a globe.
 */
export function FlagIcon({ code, size = "sm" }: { code: string; size?: IconSize }) {
  const upper = code.toUpperCase();
  const src = useFlagUrl(upper);
  if (!isKnownCountry(upper)) return <Icon icon={Globe} size={size} color="secondary" />;
  return <Flag image={{ src: src ?? BLANK, alt: "" }} size={size} />;
}

/**
 * A country code as its flag alone, named in a tooltip and to screen readers; never the code as
 * text. `showName` puts the name beside it instead, where a list needs a label, and drops the
 * tooltip that would only repeat it. A code that is no country, or none, gets a neutral globe.
 */
export function CountryFlag({
  code,
  showName = false,
  size = "sm",
}: {
  code: string | null | undefined;
  showName?: boolean;
  size?: IconSize;
}) {
  const t = useTranslations("ui.countryFlag");
  const locale = useLocale();
  const anchor = useRef<HTMLImageElement>(null);
  const upper = (code ?? "").trim().toUpperCase();
  const src = useFlagUrl(upper);
  const known = isKnownCountry(upper);
  const name = known ? regionName(upper, locale) : t("unknown");

  if (showName) {
    return (
      <HStack as="span" gap={2} vAlign="center">
        <FlagIcon code={upper} size={size} />
        <Text type="inherit" maxLines={1}>
          {name}
        </Text>
      </HStack>
    );
  }

  if (!known) {
    return (
      <Tooltip content={name}>
        <Icon icon={Globe} size={size} color="secondary" label={name} tabIndex={0} />
      </Tooltip>
    );
  }

  return (
    <HStack as="span" vAlign="center">
      <Flag image={{ src: src ?? BLANK, alt: name, ref: anchor, tabIndex: 0 }} size={size} />
      <Tooltip anchorRef={anchor} content={name} />
    </HStack>
  );
}
