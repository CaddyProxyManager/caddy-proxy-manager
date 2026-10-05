"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import MapGL, { Layer, Popup, Source, type MapLayerMouseEvent } from "react-map-gl/maplibre";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import { setWorkerUrl, type ExpressionSpecification } from "maplibre-gl";
import { useTheme } from "@astryxdesign/core";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import "maplibre-gl/dist/maplibre-gl.css";

import {
  fillLayerFor,
  hoverLayerFor,
  mapPalette,
  mapStyleFor,
  outlineLayerFor,
  selectedLayerFor,
} from "./map-theme";

// The atlas ships with the `world-atlas` package. `?url` emits it as a hashed static asset, keeping
// this a same-origin fetch (CSP `connect-src 'self'`) instead of inlining 756 KB into a JS chunk.
import atlasUrl from "world-atlas/countries-50m.json?url";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useLocale, useTranslations } from "next-intl";
import { useAppFormatter } from "@/src/components/locale/use-app-formatter";
import { regionName } from "@/src/lib/locale/region-names";

// maplibre-gl v6 resolves its tile worker from `import.meta.url`, which does not survive bundling -
// the worker never starts and the map is empty ocean. `?worker&url` bundles its module graph into
// one chunk and returns the path. Needs `worker.format: "es"` and CSP `worker-src 'self'`.
if (typeof window !== "undefined") {
  setWorkerUrl(maplibreWorkerUrl);
}

const A2N: Record<string, string> = {
  AF: "4",
  AL: "8",
  DZ: "12",
  AD: "20",
  AO: "24",
  AG: "28",
  AR: "32",
  AM: "51",
  AU: "36",
  AT: "40",
  AZ: "31",
  BS: "44",
  BH: "48",
  BD: "50",
  BB: "52",
  BY: "112",
  BE: "56",
  BZ: "84",
  BJ: "204",
  BT: "64",
  BO: "68",
  BA: "70",
  BW: "72",
  BR: "76",
  BN: "96",
  BG: "100",
  BF: "854",
  BI: "108",
  CV: "132",
  KH: "116",
  CM: "120",
  CA: "124",
  CF: "140",
  TD: "148",
  CL: "152",
  CN: "156",
  CO: "170",
  KM: "174",
  CG: "178",
  CD: "180",
  CR: "188",
  CI: "384",
  HR: "191",
  CU: "192",
  CY: "196",
  CZ: "203",
  DK: "208",
  DJ: "262",
  DM: "212",
  DO: "214",
  EC: "218",
  EG: "818",
  SV: "222",
  GQ: "226",
  ER: "232",
  EE: "233",
  SZ: "748",
  ET: "231",
  FJ: "242",
  FI: "246",
  FR: "250",
  GA: "266",
  GM: "270",
  GE: "268",
  DE: "276",
  GH: "288",
  GR: "300",
  GD: "308",
  GT: "320",
  GN: "324",
  GW: "624",
  GY: "328",
  HT: "332",
  HN: "340",
  HU: "348",
  IS: "352",
  IN: "356",
  ID: "360",
  IR: "364",
  IQ: "368",
  IE: "372",
  IL: "376",
  IT: "380",
  JM: "388",
  JP: "392",
  JO: "400",
  KZ: "398",
  KE: "404",
  KI: "296",
  KP: "408",
  KR: "410",
  KW: "414",
  KG: "417",
  LA: "418",
  LV: "428",
  LB: "422",
  LS: "426",
  LR: "430",
  LY: "434",
  LI: "438",
  LT: "440",
  LU: "442",
  MG: "450",
  MW: "454",
  MY: "458",
  MV: "462",
  ML: "466",
  MT: "470",
  MH: "584",
  MR: "478",
  MU: "480",
  MX: "484",
  FM: "583",
  MD: "498",
  MC: "492",
  MN: "496",
  ME: "499",
  MA: "504",
  MZ: "508",
  MM: "104",
  NA: "516",
  NR: "520",
  NP: "524",
  NL: "528",
  NZ: "554",
  NI: "558",
  NE: "562",
  NG: "566",
  NO: "578",
  OM: "512",
  PK: "586",
  PW: "585",
  PA: "591",
  PG: "598",
  PY: "600",
  PE: "604",
  PH: "608",
  PL: "616",
  PT: "620",
  QA: "634",
  RO: "642",
  RU: "643",
  RW: "646",
  KN: "659",
  LC: "662",
  VC: "670",
  WS: "882",
  SM: "674",
  ST: "678",
  SA: "682",
  SN: "686",
  RS: "688",
  SC: "690",
  SL: "694",
  SG: "702",
  SK: "703",
  SI: "705",
  SB: "90",
  SO: "706",
  ZA: "710",
  SS: "728",
  ES: "724",
  LK: "144",
  SD: "729",
  SR: "740",
  SE: "752",
  CH: "756",
  SY: "760",
  TW: "158",
  TJ: "762",
  TZ: "834",
  TH: "764",
  TL: "626",
  TG: "768",
  TO: "776",
  TT: "780",
  TN: "788",
  TR: "792",
  TM: "795",
  TV: "798",
  UG: "800",
  UA: "804",
  AE: "784",
  GB: "826",
  US: "840",
  UY: "858",
  UZ: "860",
  VU: "548",
  VE: "862",
  VN: "704",
  YE: "887",
  ZM: "894",
  ZW: "716",
  PS: "275",
};
const N2A: Record<string, string> = Object.fromEntries(Object.entries(A2N).map(([a, n]) => [n, a]));

function flag(code: string): string {
  if (code?.length !== 2) return "🌐";
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

// Unwrap rings so consecutive vertices never jump over 180 degrees of longitude, or MapLibre draws
// artifacts for countries crossing the antimeridian. Out-of-range values render via world copies.
function cutAntimeridian(fc: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  function unwrapRing(ring: GeoJSON.Position[]): GeoJSON.Position[] {
    if (ring.length === 0) return ring;
    const out: GeoJSON.Position[] = [[ring[0][0], ring[0][1]]];
    for (let i = 1; i < ring.length; i++) {
      let lng = ring[i][0];
      const prev = out[i - 1][0];
      while (lng - prev > 180) lng -= 360;
      while (prev - lng > 180) lng += 360;
      out.push([lng, ring[i][1]]);
    }
    return out;
  }

  function fixGeometry(geom: GeoJSON.Geometry): GeoJSON.Geometry {
    if (geom.type === "Polygon") {
      return { ...geom, coordinates: geom.coordinates.map(unwrapRing) };
    }
    if (geom.type === "MultiPolygon") {
      return { ...geom, coordinates: geom.coordinates.map((p) => p.map(unwrapRing)) };
    }
    return geom;
  }

  return {
    ...fc,
    features: fc.features.map((f) =>
      f.geometry ? { ...f, geometry: fixGeometry(f.geometry) } : f,
    ),
  };
}

export interface CountryStats {
  countryCode: string;
  total: number;
  blocked: number;
  uniqueIps: number;
}

/** Which count the choropleth is coloured by. The popup always shows all three. */
export type MapMetric = "total" | "blocked" | "uniqueIps";

interface HoverInfo {
  longitude: number;
  latitude: number;
  alpha2: string | null;
  total: number;
  blocked: number;
  uniqueIps: number;
}

export default function WorldMapInner({
  data,
  selectedCountry,
  metric = "total",
  onSelectCountry,
}: {
  data: CountryStats[];
  selectedCountry?: string | null;
  metric?: MapMetric;
  /** Called with a country's code when it is clicked, or null for the ocean or an unnamed shape. */
  onSelectCountry?: (alpha2: string | null) => void;
}) {
  const t = useTranslations("analytics");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const format = useAppFormatter();
  const [baseGeojson, setBaseGeojson] = useState<GeoJSON.FeatureCollection | null>(null);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);

  // `tokens` is memoized on theme + mode, so these layer specs stay stable: react-map-gl diffs
  // them against the live style, and a new object per render re-applies paint continuously.
  const { mode, tokens } = useTheme();
  const palette = useMemo(
    () => mapPalette(mode, (name: string) => tokens[name] ?? ""),
    [mode, tokens],
  );
  const mapStyle = useMemo(() => mapStyleFor(palette.ocean), [palette.ocean]);
  const fillLayer = useMemo(() => fillLayerFor(palette), [palette]);
  const selectedLayer = useMemo(() => selectedLayerFor(palette), [palette]);
  const hoverLayer = useMemo(() => hoverLayerFor(palette), [palette]);
  const outlineLayer = useMemo(() => outlineLayerFor(palette), [palette]);

  const statsMap = useMemo(() => new Map(data.map((d) => [d.countryCode, d])), [data]);
  // The ramp is normalised against the metric being shown, so switching to Blocked recolours the
  // map around the country that blocks most rather than leaving everything near the empty stop.
  const max = useMemo(() => data.reduce((m, d) => Math.max(m, d[metric] ?? 0), 0), [data, metric]);

  useEffect(() => {
    let cancelled = false;
    fetch(atlasUrl)
      .then((r) => r.json())
      .then((topo: Topology) => {
        if (cancelled) return;
        const fc = feature(
          topo,
          topo.objects.countries as GeometryCollection,
        ) as GeoJSON.FeatureCollection;
        setBaseGeojson(cutAntimeridian(fc));
      })
      .catch(() => {
        if (!cancelled) setBaseGeojson({ type: "FeatureCollection", features: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const geojson = useMemo<GeoJSON.FeatureCollection | null>(() => {
    if (!baseGeojson) return null;
    const safeMax = Math.max(max, 1);
    return {
      ...baseGeojson,
      features: baseGeojson.features.map((f) => {
        const alpha2 = N2A[String(Number(f.id ?? 0))] ?? null;
        const stats = alpha2 ? statsMap.get(alpha2) : undefined;
        const total = stats?.total ?? 0;
        const blocked = stats?.blocked ?? 0;
        const uniqueIps = stats?.uniqueIps ?? 0;
        const isSelected = alpha2 !== null && alpha2 === selectedCountry;
        return {
          ...f,
          properties: {
            ...f.properties,
            alpha2,
            total,
            blocked,
            uniqueIps,
            norm: (stats?.[metric] ?? 0) / safeMax,
            isSelected,
          },
        };
      }),
    };
  }, [baseGeojson, statsMap, max, metric, selectedCountry]);

  const onHover = useCallback((event: MapLayerMouseEvent) => {
    const f = event.features?.[0];
    if (!f) {
      setHoverInfo(null);
      return;
    }
    const alpha2 = (f.properties?.alpha2 as string | null) ?? null;
    setHoverInfo({
      longitude: event.lngLat.lng,
      latitude: event.lngLat.lat,
      alpha2,
      total: (f.properties?.total as number) ?? 0,
      blocked: (f.properties?.blocked as number) ?? 0,
      uniqueIps: (f.properties?.uniqueIps as number) ?? 0,
    });
  }, []);

  // Like the table's country button; clicking the ocean clears the selection.
  const onClick = useCallback(
    (event: MapLayerMouseEvent) => {
      if (!onSelectCountry) return;
      const alpha2 = (event.features?.[0]?.properties?.alpha2 as string | null) ?? null;
      onSelectCountry(alpha2);
    },
    [onSelectCountry],
  );

  // Hover filter: only tracks mouse position, changes on every mousemove
  const hoverFilter = useMemo<ExpressionSpecification>(() => {
    const a2 = hoverInfo?.alpha2 ?? null;
    return a2 ? ["==", ["get", "alpha2"], a2] : ["boolean", false];
  }, [hoverInfo?.alpha2]);

  // Centroid popup for the table-selected country (shown when not hovering)
  const selectedInfo = useMemo(() => {
    if (!selectedCountry || !geojson) return null;
    const feat = geojson.features.find((f) => f.properties?.alpha2 === selectedCountry);
    if (!feat?.geometry) return null;

    const positions: GeoJSON.Position[] = [];
    const collect = (geom: GeoJSON.Geometry) => {
      if (geom.type === "Polygon") {
        for (const r of geom.coordinates) positions.push(...r);
      } else if (geom.type === "MultiPolygon") {
        for (const p of geom.coordinates) for (const r of p) positions.push(...r);
      }
    };
    collect(feat.geometry);
    if (positions.length === 0) return null;

    const lngs = positions.map((c) => c[0]);
    const lats = positions.map((c) => c[1]);
    const rawLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const longitude = ((((rawLng + 180) % 360) + 360) % 360) - 180;
    const latitude = Math.max(-85, Math.min(85, (Math.min(...lats) + Math.max(...lats)) / 2));

    return {
      longitude,
      latitude,
      alpha2: selectedCountry,
      total: (feat.properties?.total as number) ?? 0,
      blocked: (feat.properties?.blocked as number) ?? 0,
      uniqueIps: (feat.properties?.uniqueIps as number) ?? 0,
    };
  }, [selectedCountry, geojson]);

  if (!geojson) {
    return <Skeleton width="100%" height={400} />;
  }

  return (
    <div className="relative h-full flex flex-col">
      {/* MapLibre's popup lives in its own DOM, so only overriding its classes reaches it. Plain
          CSS variables, not resolved colours, so it follows the theme without a re-render. */}
      <style>{`
        .wm-popup .maplibregl-popup-content {
          background: var(--color-background-popover) !important;
          border: 1px solid var(--color-border) !important;
          border-radius: var(--radius-element) !important;
          padding: 10px 14px !important;
          box-shadow: var(--shadow-high) !important;
          min-width: 152px;
        }
        .wm-popup .maplibregl-popup-tip { display: none !important; }
      `}</style>

      {/* MapGL is sized by `inset: 0`, not `height: 100%`: a percentage of this flex item's
          height collapses to zero, and MapLibre's overflow:hidden then clips the canvas away. */}
      <div className="relative rounded-lg overflow-hidden border border-border flex-1 min-h-[280px] md:min-w-[400px] w-full">
        <MapGL
          mapStyle={mapStyle}
          initialViewState={{
            bounds: [
              [-168, -56],
              [168, 74],
            ],
            fitBoundsOptions: { padding: 4 },
          }}
          minZoom={0.5}
          interactiveLayerIds={["countries-fill"]}
          onMouseMove={onHover}
          onMouseLeave={() => setHoverInfo(null)}
          onClick={onClick}
          // MapGL takes a style object, not a class.
          style={{ position: "absolute", inset: 0 }}
          attributionControl={false}
          dragRotate={false}
          pitchWithRotate={false}
          cursor={hoverInfo ? (onSelectCountry ? "pointer" : "crosshair") : "grab"}
        >
          <Source id="countries" type="geojson" data={geojson}>
            <Layer {...fillLayer} source="countries" />
            {/* Selected: data-driven via isSelected property baked into geojson - reliable on click */}
            <Layer
              {...selectedLayer}
              source="countries"
              filter={["==", ["get", "isSelected"], true]}
            />
            {/* Hover: filter-driven, changes on mousemove */}
            <Layer {...hoverLayer} source="countries" filter={hoverFilter} />
            <Layer {...outlineLayer} source="countries" />
          </Source>

          {/* Hover popup (takes precedence) or selected-country popup */}
          {(hoverInfo ?? selectedInfo) &&
            (() => {
              const info = hoverInfo ?? selectedInfo!;
              return (
                <Popup
                  longitude={info.longitude}
                  latitude={info.latitude}
                  offset={[0, -6] as [number, number]}
                  closeButton={false}
                  closeOnClick={false}
                  anchor="bottom"
                  className="wm-popup"
                >
                  <VStack gap={1}>
                    <HStack gap={2} vAlign="center" paddingBlockEnd={1}>
                      <Text type="body" size="xl">
                        {info.alpha2 ? flag(info.alpha2) : "🌐"}
                      </Text>
                      <Text type="body" weight="semibold">
                        {info.alpha2 ? regionName(info.alpha2, locale) : t("territory")}
                      </Text>
                    </HStack>
                    <HStack justify="between" gap={5}>
                      <Text type="body" size="sm" color="secondary">
                        {tCommon("requests")}
                      </Text>
                      <Text type="body" size="sm" weight="bold" color="accent" hasTabularNumbers>
                        {format.number(info.total)}
                      </Text>
                    </HStack>
                    {info.blocked > 0 && (
                      <HStack justify="between" gap={5}>
                        <Text type="body" size="sm" color="secondary">
                          {t("metricBlocked")}
                        </Text>
                        <Text
                          type="body"
                          size="sm"
                          weight="bold"
                          hasTabularNumbers
                          className="text-error"
                        >
                          {format.number(info.blocked)}
                        </Text>
                      </HStack>
                    )}
                    {info.uniqueIps > 0 && (
                      <HStack justify="between" gap={5}>
                        <Text type="body" size="sm" color="secondary">
                          {t("uniqueIps")}
                        </Text>
                        <Text type="body" size="sm" weight="bold" hasTabularNumbers>
                          {format.number(info.uniqueIps)}
                        </Text>
                      </HStack>
                    )}
                    {info.total === 0 && (
                      <Text type="supporting" size="xsm" color="disabled">
                        {t("noTrafficRecorded")}
                      </Text>
                    )}
                  </VStack>
                </Popup>
              );
            })()}
        </MapGL>
      </div>

      {max > 0 && (
        <HStack gap={2} vAlign="center">
          <Text type="body" size="xsm" color="secondary">
            {t("low")}{" "}
          </Text>
          {/* The map's own stops, so the key stays true after a theme flip inverts the ramp. */}
          <div
            className="h-1 flex-1 rounded-full"
            style={{
              background: `linear-gradient(to right, ${palette.ramp[0]}, ${palette.ramp[1]}, ${palette.ramp[2]})`,
            }}
          />
          <Text type="body" size="xsm" color="secondary">
            {t("high")}{" "}
          </Text>
        </HStack>
      )}
    </div>
  );
}
