/** Links into the HTTP and L4 host editors, retired section names included. */
import { describe, expect, it } from 'bun:test';
import {
  EDITOR_SECTIONS,
  editorSectionAnchor,
  editorSectionFromLink,
  editorSectionHref,
  isEditorSection,
  proxyHostAnalyticsHref,
  proxyHostDetailHref,
  proxyHostHistoryHref,
  proxyHostLogsHref,
} from '@/src/lib/proxy-hosts/editor-sections';
import {
  L4_EDITOR_SECTIONS,
  isL4EditorSection,
  l4EditorSectionAnchor,
  l4EditorSectionFromLink,
  l4EditorSectionHref,
  l4ProxyHostDetailHref,
  l4ProxyHostHistoryHref,
} from '@/src/lib/l4/editor-sections';

describe('proxy host editor sections', () => {
  it('accepts its own sections only', () => {
    for (const section of EDITOR_SECTIONS) expect(isEditorSection(section)).toBe(true);
    expect(isEditorSection('tls')).toBe(false);
    expect(isEditorSection(3)).toBe(false);
  });

  it('sends a retired section to where its fields went', () => {
    expect(editorSectionFromLink('access')).toBe('access');
    expect(editorSectionFromLink('tls')).toBe('general');
    expect(editorSectionFromLink('nope')).toBeNull();
    expect(editorSectionFromLink(undefined)).toBeNull();
  });

  it('builds its anchors and addresses', () => {
    expect(editorSectionAnchor('routing')).toBe('host-section-routing');
    expect(editorSectionHref('abc')).toBe('/proxy-hosts/abc/edit/general');
    expect(editorSectionHref(7, 'advanced')).toBe('/proxy-hosts/7/edit/advanced');
    expect(proxyHostDetailHref('abc')).toBe('/proxy-hosts/abc');
    expect(proxyHostAnalyticsHref('abc')).toBe('/proxy-hosts/abc/analytics');
    expect(proxyHostLogsHref('abc')).toBe('/proxy-hosts/abc/logs');
    expect(proxyHostHistoryHref('abc')).toBe('/proxy-hosts/abc/history');
    expect(proxyHostHistoryHref('abc', 12)).toBe('/proxy-hosts/abc/history?to=12');
  });
});

describe('L4 host editor sections', () => {
  it('accepts its own sections only', () => {
    for (const section of L4_EDITOR_SECTIONS) expect(isL4EditorSection(section)).toBe(true);
    expect(isL4EditorSection('listener')).toBe(false);
    expect(isL4EditorSection(null)).toBe(false);
  });

  it('sends a retired section to where its fields went', () => {
    expect(l4EditorSectionFromLink('upstreams')).toBe('upstreams');
    expect(l4EditorSectionFromLink('listener')).toBe('general');
    expect(l4EditorSectionFromLink('access')).toBeNull();
    expect(l4EditorSectionFromLink(1)).toBeNull();
  });

  it('builds its anchors and addresses', () => {
    expect(l4EditorSectionAnchor('protection')).toBe('l4-section-protection');
    expect(l4EditorSectionHref('abc')).toBe('/l4-proxy-hosts/abc/edit/general');
    expect(l4EditorSectionHref(7, 'upstreams')).toBe('/l4-proxy-hosts/7/edit/upstreams');
    expect(l4ProxyHostDetailHref('abc')).toBe('/l4-proxy-hosts/abc');
    expect(l4ProxyHostHistoryHref('abc')).toBe('/l4-proxy-hosts/abc/history');
    expect(l4ProxyHostHistoryHref('abc', 3)).toBe('/l4-proxy-hosts/abc/history?to=3');
  });
});
