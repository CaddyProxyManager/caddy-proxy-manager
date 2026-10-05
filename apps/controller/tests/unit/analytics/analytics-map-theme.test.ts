import { describe, expect, it } from 'bun:test';
import { Color } from '@maplibre/maplibre-gl-style-spec';
import { resolveThemeTokens } from '@astryxdesign/core/theme/tokens';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import {
  fillLayerFor,
  hoverLayerFor,
  mapPalette,
  mapStyleFor,
  outlineLayerFor,
  selectedLayerFor,
  type MapPalette,
} from '../../../src/app/(dashboard)/analytics/map-theme';

/** The real Astryx theme, not a stub, which would hide a token renamed or dropped upstream. */
function paletteFor(mode: 'light' | 'dark'): MapPalette {
  const tokens = resolveThemeTokens(neutralTheme, { mode });
  return mapPalette(mode, (name) => tokens[name] ?? '');
}

function paintColors(p: MapPalette): string[] {
  return [p.ocean, p.empty, ...p.ramp, p.highlight, p.outline];
}

const MODES = ['light', 'dark'] as const;

describe('analytics map palette', () => {
  it.each([...MODES])('resolves every token to a concrete colour in %s mode', (mode) => {
    for (const color of paintColors(paletteFor(mode))) {
      expect(color).not.toBe('');
      // WebGL cannot resolve CSS tokens or light-dark(); it would silently paint nothing.
      expect(color).not.toContain('light-dark');
      expect(color).not.toContain('var(');
    }
  });

  it.each([...MODES])('produces colours MapLibre can parse in %s mode', (mode) => {
    for (const color of paintColors(paletteFor(mode))) {
      // Color.parse returns undefined rather than throwing.
      expect(Color.parse(color), `unparseable: ${color}`).toBeDefined();
    }
  });

  it('inverts the choropleth ramp between modes', () => {
    const light = paletteFor('light');
    const dark = paletteFor('dark');

    // More traffic reads darker on a light ocean and lighter on a dark one.
    expect([...dark.ramp]).toEqual([...light.ramp].reverse());
    expect(new Set(light.ramp).size).toBe(3);
  });

  it('keeps empty land distinct from the ocean in both modes', () => {
    for (const mode of MODES) {
      const p = paletteFor(mode);
      // A country with no traffic must not disappear into the sea.
      expect(p.empty).not.toBe(p.ocean);
    }
  });

  it('gives light and dark genuinely different chrome', () => {
    const light = paletteFor('light');
    const dark = paletteFor('dark');

    expect(light.ocean).not.toBe(dark.ocean);
    expect(light.empty).not.toBe(dark.empty);
    expect(light.highlight).not.toBe(dark.highlight);
  });

  it('builds layer specs carrying the palette through', () => {
    const p = paletteFor('dark');

    expect(mapStyleFor(p.ocean).layers[0].paint['background-color']).toBe(p.ocean);
    expect(selectedLayerFor(p).paint?.['fill-color']).toBe(p.highlight);
    expect(hoverLayerFor(p).paint?.['fill-color']).toBe(p.highlight);
    expect(outlineLayerFor(p).paint?.['line-color']).toBe(p.outline);

    // Stops in ramp order after the "no traffic" colour.
    const fill = fillLayerFor(p).paint?.['fill-color'] as unknown[];
    expect(fill.slice(0, 3)).toEqual(['interpolate', ['linear'], ['coalesce', ['get', 'norm'], 0]]);
    expect(fill.slice(3)).toEqual([0, p.empty, 0.001, p.ramp[0], 0.4, p.ramp[1], 1, p.ramp[2]]);
  });

  it('keeps ids stable - the map queries and filters layers by name', () => {
    const p = paletteFor('light');
    expect(fillLayerFor(p).id).toBe('countries-fill');
    expect(selectedLayerFor(p).id).toBe('countries-selected');
    expect(hoverLayerFor(p).id).toBe('countries-hover');
    expect(outlineLayerFor(p).id).toBe('countries-outline');
  });
});
