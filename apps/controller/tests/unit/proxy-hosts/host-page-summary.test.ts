/**
 * The host page's one line per editor section and the list's protection badges. The fact codes
 * are composed at runtime, so the catalog's coverage of them is checked here.
 */
import { describe, expect, it } from 'bun:test';
import messages from '../../../messages/en.json';
import { SETTINGS_LINKS } from '@/src/lib/attention/providers';
import type { ProxyHost } from '@/src/lib/models/proxy-hosts';
import {
  EDITOR_SECTIONS,
  editorSectionHref,
  isEditorSection,
} from '@/src/lib/proxy-hosts/editor-sections';
import { healthChecksOf } from '@/src/lib/proxy-hosts/detail-types';
import { PROTECTIONS, hostProtections } from '@/src/lib/proxy-hosts/protections';
import { SECTION_FACTS, sectionSummaries } from '@/src/lib/proxy-hosts/section-summary';
import { settingsHref } from '@/src/app/(dashboard)/settings/sections';

function host(overrides: Partial<ProxyHost> = {}): ProxyHost {
  return {
    id: 1,
    name: 'App',
    description: null,
    tags: [],
    domains: ['app.example.com'],
    upstreams: ['http://app:8080'],
    certificateId: null,
    accessListId: null,
    sslForced: false,
    hstsEnabled: false,
    hstsSubdomains: false,
    allowWebsocket: false,
    preserveHostHeader: true,
    skipHttpsHostnameValidation: false,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    customReverseProxyJson: null,
    customPreHandlersJson: null,
    customCaddyfile: null,
    authentik: null,
    loadBalancer: null,
    dnsResolver: null,
    upstreamDnsResolution: null,
    geoblock: null,
    geoblockMode: 'merge',
    waf: null,
    mtls: null,
    cpmForwardAuth: null,
    forwardAuth: null,
    tailscale: null,
    redirects: [],
    rewrite: null,
    locationRules: [],
    pathAllows: [],
    pathBlocks: [],
    pathRewrites: [],
    errorPages: [],
    cache: null,
    compression: 'inherit',
    discourageIndexing: false,
    maintenance: null,
    upstreamTimeouts: null,
    rateLimit: null,
    crowdsec: true,
    anubis: null,
    ...overrides,
  };
}

type Lookups = Parameters<typeof sectionSummaries>[1];

const LOOKUPS: Lookups = {
  certificateName: null,
  accessListName: null,
  agentNames: [],
  crowdsecActive: false,
};

const codes = (h: ProxyHost, lookups: Lookups = LOOKUPS) =>
  Object.fromEntries(
    sectionSummaries(h, lookups).map((s) => [s.section, s.facts.map((f) => f.code)]),
  );

describe('sectionSummaries', () => {
  it('gives every section a line, in the editor order, even for a bare host', () => {
    const summaries = sectionSummaries(host(), LOOKUPS);
    expect(summaries.map((s) => s.section)).toEqual([...EDITOR_SECTIONS]);
    expect(codes(host())).toEqual({
      general: ['domains'],
      upstreams: ['upstreams', 'noHealthChecks'],
      tls: ['certificateManaged'],
      access: ['openAccess'],
      protection: ['noProtection'],
      routing: ['defaultRouting'],
      advanced: ['everyAgent'],
    });
  });

  it('names what a configured host has', () => {
    const configured = host({
      tags: ['prod'],
      sslForced: true,
      hstsEnabled: true,
      waf: { enabled: true },
      cpmForwardAuth: { enabled: true } as ProxyHost['cpmForwardAuth'],
      rateLimit: { enabled: true, zones: [] },
      redirects: [{ from: '/a', to: '/b', status: 301 }] as ProxyHost['redirects'],
      maintenance: { enabled: true, retryAfter: null, bypassCidrs: [], body: null },
      accessListId: 4,
    });
    const found = codes(configured, {
      certificateName: null,
      accessListName: 'Office',
      agentNames: ['edge-1'],
      crowdsecActive: true,
    });
    expect(found.general).toEqual(['domains', 'tags']);
    expect(found.upstreams).toEqual(['upstreams', 'httpsForced', 'hstsOn', 'noHealthChecks']);
    expect(found.tls).toEqual(['certificateManaged']);
    expect(found.access).toEqual(['accessList', 'signInCpm']);
    expect(found.protection).toEqual(['waf', 'crowdsec', 'rateLimit']);
    expect(found.routing).toEqual(['redirects']);
    expect(found.advanced).toEqual(['pinnedAgents', 'maintenanceOn']);
  });

  it('has catalog text for every fact and section', () => {
    const facts = messages.proxyHosts.detail.facts as Record<string, string>;
    expect(SECTION_FACTS.filter((code) => typeof facts[code] !== 'string')).toEqual([]);
    expect(Object.keys(facts).sort()).toEqual([...SECTION_FACTS].sort());
    const sections = messages.proxyHosts.detail.sections as Record<string, string>;
    expect(Object.keys(sections).sort()).toEqual([...EDITOR_SECTIONS].sort());
  });
});

describe('hostProtections', () => {
  it('counts CrowdSec only once it is set up, and names the sign-in kind', () => {
    const h = host({
      authentik: { enabled: true } as ProxyHost['authentik'],
      anubis: { enabled: true, upstream: null, exemptPaths: [] },
    });
    expect(hostProtections(h, false)).toEqual({
      active: ['signIn', 'botChallenge'],
      signIn: 'authentik',
    });
    expect(hostProtections(h, true).active).toEqual(['signIn', 'crowdsec', 'botChallenge']);
  });

  it('has a badge label for every protection and sign-in kind', () => {
    const labels = messages.proxyHosts.insights.protection as Record<string, string>;
    const keys = PROTECTIONS.flatMap((p) =>
      p === 'signIn' ? ['signInCpm', 'signInAuthentik', 'signInForwardAuth'] : [p],
    );
    expect(keys.filter((k) => typeof labels[k] !== 'string')).toEqual([]);
  });
});

describe('editor sections', () => {
  it('links to the list page editor, scrolled by the hash', () => {
    expect(editorSectionHref(5)).toBe('/proxy-hosts?edit=5');
    expect(editorSectionHref(5, 'tls')).toBe('/proxy-hosts?edit=5#tls');
    expect(isEditorSection('routing')).toBe(true);
    expect(isEditorSection('nope')).toBe(false);
  });
});

describe('healthChecksOf', () => {
  it('reads the checks only while load balancing is on', () => {
    const lb = {
      enabled: true,
      activeHealthCheck: { enabled: true, uri: '/health', interval: '10s', timeout: null },
      passiveHealthCheck: { enabled: false, maxFails: 3, failDuration: '30s' },
    } as unknown as ProxyHost['loadBalancer'];
    expect(healthChecksOf({ loadBalancer: lb })).toEqual({
      active: { uri: '/health', interval: '10s', timeout: null },
      passive: null,
    });
    expect(healthChecksOf({ loadBalancer: { ...lb!, enabled: false } })).toEqual({
      active: null,
      passive: null,
    });
  });
});

describe('attention settings links', () => {
  it('match where the settings page puts those sections', () => {
    expect(settingsHref('geoip')).toBe(SETTINGS_LINKS.geoip);
    expect(settingsHref('ldap')).toBe(SETTINGS_LINKS.ldap);
  });
});
