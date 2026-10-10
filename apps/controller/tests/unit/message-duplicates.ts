/**
 * Catalog values that repeat on purpose, so a translation can word each one for its place.
 * `message-catalog.test.ts` fails on any other repeat: merge it into one key (`common` holds
 * what many screens share), or list it here with the reason it stays apart.
 */

export const DUPLICATE_REASONS = {
  composed:
    "Read through a key built at runtime (a family of outcomes, fields, blocks, sources, roles...); the family stays whole even where one of its words repeats another key's.",
  agrees:
    'A state or option word: other languages inflect it for the noun it describes, and each key describes a different one.',
  role: 'One English word in different roles - a button and a dialog title, a heading and a status, a label and a placeholder - that other languages word differently.',
  sense: 'The same English word for different things.',
  family: 'An option in a set read through one typed map; the set keeps its own words.',
  channel:
    "An email or notification, written for a recipient and a context of its own, beside the screen's copy.",
  code: "A domain error code, rendered by code from the model, beside a screen's own copy.",
  casing: 'Capitalised differently by position: one starts a line, the other sits mid-sentence.',
  short: 'A deliberately separate short form, for a narrow column or badge.',
} as const;

/** Every key sharing one value, compared case- and whitespace-insensitively. */
export const SEPARATE_DUPLICATES: readonly {
  reason: keyof typeof DUPLICATE_REASONS;
  keys: readonly string[];
}[] = [
  {
    reason: 'casing',
    keys: ['errors.hostReferenceCertificate', 'hostHistory.references.certificate'],
  },
  {
    reason: 'casing',
    keys: ['errors.hostReferenceAccessList', 'hostHistory.references.accessList'],
  },
  {
    reason: 'casing',
    keys: ['errors.hostReferenceAgent', 'hostHistory.references.agent'],
  },
  {
    reason: 'casing',
    keys: ['errors.hostReferenceCaCertificate', 'hostHistory.references.caCertificate'],
  },
  {
    reason: 'casing',
    keys: ['errors.hostReferenceClientCertificate', 'hostHistory.references.clientCertificate'],
  },
  {
    reason: 'casing',
    keys: ['errors.hostReferenceMtlsRole', 'hostHistory.references.mtlsRole'],
  },
  {
    reason: 'sense',
    keys: ['hostHistory.overviewTab', 'nav.overview', 'roles.resources.overview.label'],
  },
  {
    reason: 'composed',
    keys: [
      'attention.items.caddyApplyFailed.detail',
      'attention.items.l4PortsFailed.detail',
      'attention.items.geoipFailing.detail',
    ],
  },
  {
    reason: 'composed',
    keys: ['attention.items.agentOffline.title', 'email.notifications.kinds.agentOffline.title'],
  },
  {
    reason: 'composed',
    keys: ['attention.items.mitigationSpike.detail', 'attention.items.mitigationSpikeFleet.detail'],
  },
  {
    reason: 'composed',
    keys: [
      'accessLists.ruleKinds.country',
      'analytics.country',
      'analytics.filterFields.country',
      'analytics.topColumn.countries',
      'security.kinds.country',
    ],
  },
  { reason: 'composed', keys: ['accessLists.ruleKinds.continent', 'security.kinds.continent'] },
  { reason: 'composed', keys: ['accessLists.continents.af', 'proxyHosts.continentNames.africa'] },
  {
    reason: 'composed',
    keys: ['accessLists.continents.an', 'proxyHosts.continentNames.antarctica'],
  },
  { reason: 'composed', keys: ['accessLists.continents.as', 'proxyHosts.continentNames.asia'] },
  { reason: 'composed', keys: ['accessLists.continents.eu', 'proxyHosts.continentNames.europe'] },
  { reason: 'composed', keys: ['accessLists.continents.oc', 'proxyHosts.continentNames.oceania'] },
  {
    reason: 'composed',
    keys: ['accessLists.ruleExpiry.oneHour', 'security.expiryPresets.oneHour'],
  },
  { reason: 'composed', keys: ['accessLists.ruleExpiry.oneDay', 'security.expiryPresets.oneDay'] },
  {
    reason: 'composed',
    keys: ['accessLists.ruleExpiry.sevenDays', 'security.expiryPresets.sevenDays'],
  },
  {
    reason: 'composed',
    keys: [
      'accessLists.ruleExpiry.thirtyDays',
      'profile.apiTokenExpiry.days30',
      'security.expiryPresets.thirtyDays',
    ],
  },
  { reason: 'composed', keys: ['accessLists.relative.daysAgo', 'certificates.addedDaysAgo'] },
  { reason: 'composed', keys: ['accessLists.relative.monthsAgo', 'certificates.addedMonthsAgo'] },
  { reason: 'composed', keys: ['accessLists.relative.yearsAgo', 'certificates.addedYearsAgo'] },
  {
    reason: 'composed',
    keys: [
      'accessLists.seedUsernamePlaceholder',
      'common.username',
      'settings.dnsProviders.namecheap.fields.user.label',
      'settings.dnsProviders.acmedns.fields.username.label',
      'settings.dnsProviders.inwx.fields.username.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'accessLists.seedPasswordPlaceholder',
      'common.password',
      'passwordPolicy.subject.password',
      'settings.dnsProviders.acmedns.fields.password.label',
      'settings.dnsProviders.inwx.fields.password.label',
      'users.setupMethod',
      'users.lastSignInMethods.password',
    ],
  },
  { reason: 'composed', keys: ['agents.assignedToAll', 'proxyHosts.detail.facts.everyAgent'] },
  {
    reason: 'composed',
    keys: [
      'analytics.breakdownResponses',
      'settings.units.responses',
      'settings.sections.responses.name',
    ],
  },
  { reason: 'composed', keys: ['analytics.uniqueIps', 'analytics.kpi.uniqueIps'] },
  {
    reason: 'composed',
    keys: ['analytics.csv.requests', 'analytics.kpi.requests', 'common.requests'],
  },
  { reason: 'composed', keys: ['analytics.csv.serverErrors', 'overview.metricServerErrors'] },
  {
    reason: 'composed',
    keys: ['analytics.filterFields.ip', 'analytics.topColumn.clientIps', 'common.clientIp'],
  },
  {
    reason: 'composed',
    keys: ['analytics.filterFields.method', 'analytics.topColumn.methods', 'common.method'],
  },
  {
    reason: 'composed',
    keys: ['analytics.filterFields.path', 'analytics.topColumn.paths', 'proxyHosts.path'],
  },
  { reason: 'composed', keys: ['analytics.kpi.bytes', 'proxyHosts.detail.tileBandwidth'] },
  { reason: 'composed', keys: ['analytics.kpi.mitigatedShare', 'common.shareOfRequests'] },
  {
    reason: 'composed',
    keys: [
      'analytics.outcomes.access',
      'hostReview.fields.accessListId',
      'hostReview.protections.accessList',
      'proxyHosts.accessList',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'analytics.outcomes.auth',
      'hostReview.protections.signIn',
      'proxyHosts.insights.protection.signInCpm',
      'settings.blocks.signIn.name',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'analytics.outcomes.crowdsec',
      'caddyModules.modules.caddyCrowdsec.name',
      'hostReview.fields.crowdsec',
      'hostReview.protections.crowdsec',
      'l4ProxyHosts.crowdsec',
      'proxyHosts.insights.protection.crowdsec',
      'proxyHosts.detail.facts.crowdsec',
      'proxyHosts.crowdsec',
      'settings.sections.crowdsec.name',
      'settings.blocks.crowdsec.name',
      'settings.stagedLabels.crowdsec',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'analytics.outcomes.rateLimit',
      'caddyModules.modules.caddyRatelimit.name',
      'proxyHosts.insights.protection.rateLimit',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'analytics.outcomes.waf',
      'hostReview.fields.waf',
      'hostReview.protections.waf',
      'nav.waf',
      'proxyHosts.insights.protection.waf',
      'proxyHosts.detail.facts.waf',
      'proxyHosts.features.waf',
      'settings.stagedLabels.waf',
      'settings.search.pages.wafTuning.context',
      'settings.search.pages.wafHostModes.context',
      'settings.search.pages.wafExclusions.context',
      'logs.sources.waf',
      'waf.waf',
    ],
  },
  { reason: 'composed', keys: ['analytics.top.countries', 'proxyHosts.countries'] },
  { reason: 'composed', keys: ['analytics.top.hosts', 'nav.hosts'] },
  {
    reason: 'composed',
    keys: [
      'analytics.top.httpVersions',
      'settings.blocks.httpProtocols.name',
      'settings.stagedLabels.httpProtocols',
    ],
  },
  { reason: 'composed', keys: ['analytics.top.methods', 'proxyHosts.rateLimitMethods'] },
  { reason: 'composed', keys: ['analytics.top.paths', 'proxyHosts.rateLimitPaths'] },
  { reason: 'composed', keys: ['analytics.top.statusCodes', 'proxyHosts.statusCodes'] },
  { reason: 'composed', keys: ['analytics.topColumn.httpVersions', 'common.version'] },
  {
    reason: 'composed',
    keys: [
      'auth.passwordChange.policyTitle',
      'settings.blocks.passwordPolicy.name',
      'settings.stagedLabels.passwordPolicy',
    ],
  },
  {
    reason: 'composed',
    keys: ['caCertificates.exportPassword', 'passwordPolicy.subject.exportPassword'],
  },
  {
    reason: 'composed',
    keys: [
      'caddyModules.modules.caddyTailscale.name',
      'hostReview.fields.tailscale',
      'proxyHosts.tailscale',
      'settings.blocks.tailscale.name',
      'settings.stagedLabels.tailscale',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'caddyModules.modules.cacheHandler.name',
      'settings.blocks.httpCache.name',
      'settings.stagedLabels.httpCache',
    ],
  },
  { reason: 'composed', keys: ['common.create', 'settings.configTransfer.actions.create'] },
  { reason: 'composed', keys: ['common.skip', 'settings.configTransfer.actions.skip'] },
  { reason: 'composed', keys: ['common.name', 'hostReview.fields.name'] },
  { reason: 'composed', keys: ['common.domains', 'hostReview.fields.domains'] },
  { reason: 'composed', keys: ['common.newPassword', 'passwordPolicy.subject.newPassword'] },
  {
    reason: 'composed',
    keys: [
      'hostReview.sections.http.general',
      'hostReview.sections.l4.general',
      'proxyHosts.detail.sections.general',
      'settings.sections.general.name',
      'settings.blocks.general.name',
      'settings.stagedLabels.general',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.sections.http.upstreams',
      'hostReview.sections.l4.upstreams',
      'hostReview.fields.upstreams',
      'proxyHosts.detail.sections.upstreams',
      'proxyHosts.upstreams',
    ],
  },
  {
    reason: 'composed',
    keys: ['hostReview.sections.http.tls', 'proxyHosts.detail.sections.tls', 'proxyHosts.tls'],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.sections.http.protection',
      'hostReview.sections.l4.protection',
      'proxyHosts.detail.sections.protection',
    ],
  },
  {
    reason: 'composed',
    keys: ['hostReview.sections.http.routing', 'proxyHosts.detail.sections.routing'],
  },
  {
    reason: 'composed',
    keys: ['hostReview.sections.http.advanced', 'proxyHosts.detail.sections.advanced'],
  },
  { reason: 'composed', keys: ['hostReview.fields.description', 'proxyHosts.notes'] },
  { reason: 'composed', keys: ['hostReview.fields.sslForced', 'proxyHosts.forceHttps'] },
  {
    reason: 'composed',
    keys: ['hostReview.fields.hstsEnabled', 'proxyHosts.detail.facts.hstsOn', 'proxyHosts.hsts'],
  },
  {
    reason: 'composed',
    keys: ['hostReview.fields.allowWebsocket', 'proxyHosts.detail.facts.websocketsOn'],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.compression',
      'proxyHosts.compression',
      'settings.blocks.compression.name',
      'settings.stagedLabels.compression',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.dnsResolver',
      'proxyHosts.dnsResolvers',
      'settings.blocks.dnsResolvers.name',
      'settings.stagedLabels.dnsResolvers',
    ],
  },
  {
    reason: 'composed',
    keys: ['hostReview.fields.upstreamTimeouts', 'proxyHosts.upstreamTimeouts'],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.upstreamDnsResolution',
      'proxyHosts.upstreamDnsPinning',
      'settings.blocks.upstreamDns.name',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.certificateId',
      'proxyHosts.insights.certificate',
      'proxyHosts.certificate',
    ],
  },
  { reason: 'composed', keys: ['hostReview.fields.mtls', 'hostReview.protections.mtls'] },
  {
    reason: 'composed',
    keys: ['hostReview.fields.authentik', 'proxyHosts.detail.facts.signInAuthentik'],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.forwardAuth',
      'hostReview.signInKinds.forwardAuth',
      'proxyHosts.insights.protection.signInForwardAuth',
      'proxyHosts.forwardAuth',
      'proxyHosts.features.forwardAuth',
      'settings.sections.forwardAuth.name',
      'settings.stagedLabels.forwardAuth',
    ],
  },
  { reason: 'composed', keys: ['hostReview.fields.cpmForwardAuth', 'hostReview.signInKinds.cpm'] },
  {
    reason: 'composed',
    keys: [
      'settings.sections.hostDefaults.name',
      'settings.stagedLabels.hostDefaults',
      'settings.stagedLabels.l4HostDefaults',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.rateLimit',
      'hostReview.protections.rateLimit',
      'proxyHosts.rateLimit',
      'settings.sections.rateLimit.name',
      'settings.blocks.rateLimit.name',
      'settings.stagedLabels.rateLimit',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.geoblock',
      'hostReview.protections.geo',
      'proxyHosts.detail.facts.geo',
      'proxyHosts.geoBlocking',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.anubis',
      'hostReview.protections.botChallenge',
      'proxyHosts.insights.protection.botChallenge',
      'proxyHosts.detail.facts.botChallenge',
    ],
  },
  { reason: 'composed', keys: ['hostReview.fields.redirects', 'proxyHosts.redirects'] },
  { reason: 'composed', keys: ['hostReview.fields.locationRules', 'proxyHosts.locationRules'] },
  { reason: 'composed', keys: ['hostReview.fields.rewrite', 'proxyHosts.pathPrefixRewrite'] },
  { reason: 'composed', keys: ['hostReview.fields.pathRewrites', 'proxyHosts.pathRewrites'] },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.errorPages',
      'proxyHosts.errorPages',
      'settings.blocks.errorPages.name',
      'settings.stagedLabels.errorPages',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.fields.agentIds',
      'nav.agents',
      'profile.apiTokenAreas.agents',
      'setup.migrationGroups.agents.label',
      'roles.resources.agents.label',
    ],
  },
  { reason: 'composed', keys: ['hostReview.fields.maintenance', 'proxyHosts.maintenance'] },
  { reason: 'composed', keys: ['hostReview.fields.customCaddyfile', 'proxyHosts.customCaddyfile'] },
  { reason: 'composed', keys: ['hostReview.fields.protocol', 'proxyHosts.protocol'] },
  { reason: 'composed', keys: ['hostReview.fields.listenAddress', 'l4ProxyHosts.listenAddress'] },
  { reason: 'composed', keys: ['hostReview.fields.matcherType', 'l4ProxyHosts.matcher'] },
  { reason: 'composed', keys: ['hostReview.fields.tlsTermination', 'l4ProxyHosts.tlsTermination'] },
  {
    reason: 'composed',
    keys: ['hostReview.fields.proxyProtocolReceive', 'l4ProxyHosts.acceptInboundProxyProtocol'],
  },
  {
    reason: 'composed',
    keys: [
      'hostReview.signInKinds.authentik',
      'proxyHosts.insights.protection.signInAuthentik',
      'proxyHosts.features.authentik',
      'settings.stagedLabels.authentik',
    ],
  },
  {
    reason: 'composed',
    keys: ['hostReview.rateLimitModes.inherit', 'proxyHosts.rateLimitModes.inherit'],
  },
  {
    reason: 'composed',
    keys: [
      'nav.accessLists',
      'profile.apiTokenAreas.accessLists',
      'settings.backup.tables.accessLists',
      'setup.migrationGroups.accessLists.label',
      'roles.resources.accessLists.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'nav.analytics',
      'profile.apiTokenAreas.analytics',
      'settings.groups.analytics',
      'settings.blocks.analytics.name',
      'roles.resources.analytics.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'nav.auditLog',
      'profile.apiTokenAreas.audit',
      'setup.migrationGroups.auditLog.label',
      'roles.resources.audit.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'nav.certificates',
      'overview.checklist.steps.certificate.action',
      'settings.backup.tables.certificates',
      'setup.migrationGroups.certificates.label',
      'logs.sources.acme',
      'roles.resources.certificates.label',
    ],
  },
  { reason: 'composed', keys: ['nav.l4ProxyHosts', 'settings.backup.tables.l4ProxyHosts'] },
  {
    reason: 'composed',
    keys: [
      'nav.proxyHosts',
      'settings.backup.tables.proxyHosts',
      'setup.migrationGroups.proxyHosts.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'nav.railGroupObservability',
      'settings.navGroups.observability',
      'settings.sections.observability.name',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'nav.settings',
      'settings.search.pages.backup.context',
      'settings.search.pages.auditStreaming.context',
      'settings.search.pages.settingsHistory.context',
      'setup.steps.settings',
      'setup.migrationGroups.settings.label',
      'roles.resources.settings.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'nav.users',
      'overview.checklist.steps.secondUser.action',
      'settings.backup.tables.users',
      'settings.search.pages.signInOverview.context',
      'roles.resources.users.label',
    ],
  },
  {
    reason: 'composed',
    keys: ['overview.adminNameFallback', 'users.roles.admin', 'signInOverview.roles.admin'],
  },
  { reason: 'composed', keys: ['profile.passkeys.title', 'signInOverview.methods.passkey'] },
  {
    reason: 'composed',
    keys: ['profile.passkeys.unnamed', 'users.lastSignInMethods.passkey', 'users.mfa.passkey'],
  },
  {
    reason: 'composed',
    keys: [
      'proxyHosts.insights.protection.mtls',
      'proxyHosts.detail.facts.mtls',
      'proxyHosts.features.mtls',
    ],
  },
  { reason: 'composed', keys: ['proxyHosts.insights.protection.geo', 'proxyHosts.features.geo'] },
  {
    reason: 'composed',
    keys: ['proxyHosts.detail.facts.activeHealthChecks', 'proxyHosts.activeHealthChecks'],
  },
  {
    reason: 'composed',
    keys: ['proxyHosts.detail.facts.passiveHealthChecks', 'proxyHosts.passiveHealthChecks'],
  },
  { reason: 'composed', keys: ['proxyHosts.detail.facts.rewrite', 'proxyHosts.features.rewrite'] },
  {
    reason: 'composed',
    keys: [
      'proxyHosts.trustedProxies',
      'settings.blocks.trustedProxies.name',
      'settings.stagedLabels.trustedProxies',
    ],
  },
  { reason: 'composed', keys: ['settings.groups.geoip', 'settings.health.geoip.name'] },
  { reason: 'composed', keys: ['settings.registry.smtp_host.label', 'settings.blocks.email.name'] },
  {
    reason: 'composed',
    keys: [
      'settings.registry.notify_account_disabled.label',
      'email.notifications.kinds.accountDisabled.title',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'settings.registry.notify_admin_locked.label',
      'email.notifications.kinds.adminLocked.title',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'settings.sections.caddyBuild.name',
      'settings.blocks.caddyBuild.name',
      'settings.stagedLabels.caddyBuild',
    ],
  },
  { reason: 'composed', keys: ['settings.blocks.acme.name', 'settings.stagedLabels.acme'] },
  { reason: 'composed', keys: ['settings.blocks.updates.name', 'settings.stagedLabels.updates'] },
  { reason: 'composed', keys: ['settings.blocks.branding.name', 'settings.stagedLabels.branding'] },
  { reason: 'composed', keys: ['settings.blocks.avatars.name', 'settings.stagedLabels.avatars'] },
  {
    reason: 'composed',
    keys: ['settings.blocks.defaultResponse.name', 'settings.stagedLabels.defaultResponse'],
  },
  {
    reason: 'composed',
    keys: ['settings.blocks.globalCaddyConfig.name', 'settings.stagedLabels.globalCaddyConfig'],
  },
  {
    reason: 'composed',
    keys: ['settings.blocks.dnsProviders.name', 'settings.stagedLabels.dnsProviders'],
  },
  {
    reason: 'composed',
    keys: [
      'settings.dnsProviders.cloudflare.fields.apiToken.label',
      'settings.dnsProviders.digitalocean.fields.apiToken.label',
      'settings.dnsProviders.hetzner.fields.apiToken.label',
      'settings.dnsProviders.ionos.fields.authApiToken.label',
      'settings.dnsProviders.linode.fields.apiToken.label',
      'settings.dnsProviders.njalla.fields.apiToken.label',
      'settings.dnsProviders.desec.fields.token.label',
      'settings.dnsProviders.dynu.fields.apiToken.label',
      'settings.dnsProviders.infomaniak.fields.apiToken.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'settings.dnsProviders.vultr.fields.apiToken.label',
      'settings.dnsProviders.porkbun.fields.apiKey.label',
      'settings.dnsProviders.namecheap.fields.apiKey.label',
      'settings.dnsProviders.spaceship.fields.apiKey.label',
      'settings.dnsProviders.netcup.fields.apiKey.label',
      'settings.httpCache.cdnApiKey',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'settings.dnsProviders.netcup.fields.apiPassword.label',
      'settings.dnsProviders.cloudns.fields.authPassword.label',
    ],
  },
  {
    reason: 'composed',
    keys: ['settings.health.updates.valueUnchecked', 'signInOverview.notes.unchecked'],
  },
  {
    reason: 'composed',
    keys: ['settings.health.twoFactor.valueRequired', 'signInOverview.mfaModes.admins'],
  },
  {
    reason: 'composed',
    keys: ['settings.health.twoFactor.valueAll', 'signInOverview.mfaModes.all'],
  },
  { reason: 'composed', keys: ['settings.health.geoblock.name', 'settings.stagedLabels.geoblock'] },
  {
    reason: 'composed',
    keys: ['settings.blocks.ssoEnforcement.name', 'settings.stagedLabels.ssoEnforcement'],
  },
  { reason: 'sense', keys: ['settings.ldap.emailAttribute', 'settings.saml.emailAttribute'] },
  { reason: 'sense', keys: ['settings.ldap.nameAttribute', 'settings.saml.nameAttribute'] },
  { reason: 'composed', keys: ['settings.health.metrics.name', 'settings.stagedLabels.metrics'] },
  {
    reason: 'composed',
    keys: ['users.viewAs.roles.operator', 'users.roles.operator', 'signInOverview.roles.operator'],
  },
  {
    reason: 'composed',
    keys: ['users.viewAs.roles.viewer', 'users.roles.viewer', 'signInOverview.roles.viewer'],
  },
  { reason: 'composed', keys: ['users.signInLocal', 'signInOverview.methods.password'] },
  { reason: 'composed', keys: ['users.accountSource.oidc', 'users.lastSignInMethods.oidc'] },
  { reason: 'composed', keys: ['users.accountSource.ldap', 'signInOverview.kinds.ldap'] },
  { reason: 'composed', keys: ['users.mfa.secondFactor', 'signInOverview.mfaTitle'] },
  { reason: 'composed', keys: ['signInOverview.kinds.password', 'signInOverview.kinds.passkey'] },
  { reason: 'agrees', keys: ['attention.severity.critical', 'waf.statCritical'] },
  {
    reason: 'agrees',
    keys: ['attention.severity.warning', 'ui.codeEditor.warningLabel', 'ui.statusChip.warning'],
  },
  {
    reason: 'agrees',
    keys: [
      'accessLists.ruleExpiry.never',
      'accessLists.relative.never',
      'common.never',
      'profile.apiTokenExpiry.never',
      'settings.agentNeverReported',
      'security.expiryPresets.never',
      'security.neverExpires',
    ],
  },
  { reason: 'agrees', keys: ['accessLists.created', 'users.created'] },
  {
    reason: 'agrees',
    keys: [
      'accessLists.hostActive',
      'caCertificates.active',
      'certificates.active',
      'ui.statusChip.active',
      'users.filterActive',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'accessLists.hostDisabled',
      'certificates.disabled',
      'l4ProxyHosts.optDnsDisabled',
      'l4ProxyHosts.disabled',
      'proxyHosts.insights.state.disabled',
      'proxyHosts.filterDisabled',
      'proxyHosts.optDnsDisabled',
      'settings.disabled',
      'settings.ldap.badgeDisabled',
      'users.disabledBadge',
      'users.filterDisabled',
      'waf.disabled',
      'waf.pluginDisabled',
    ],
  },
  { reason: 'agrees', keys: ['accessLists.noMembersBadge', 'accessLists.strength.empty'] },
  { reason: 'agrees', keys: ['accessLists.saved', 'settings.accentColorSaved'] },
  { reason: 'agrees', keys: ['accessLists.columnAdded', 'certificates.added'] },
  {
    reason: 'agrees',
    keys: [
      'analytics.intervalCustom',
      'proxyHosts.forwardAuthProviderCustom',
      'settings.forwardAuthProviderCustom',
      'waf.rangeCustom',
      'security.rangeCustom',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'analytics.metricBlocked',
      'overview.logBlocked',
      'waf.blocked',
      'security.alreadyBlocked',
    ],
  },
  { reason: 'agrees', keys: ['analytics.selected', 'waf.selected'] },
  {
    reason: 'agrees',
    keys: ['analytics.metricMitigated', 'analytics.csv.mitigated', 'analytics.kpi.mitigated'],
  },
  {
    reason: 'agrees',
    keys: [
      'analytics.unknownValue',
      'proxyHosts.upstreamHealth.state.unknown',
      'settings.history.unknownUser',
      'ui.countryFlag.unknown',
    ],
  },
  { reason: 'agrees', keys: ['analytics.outcomes.served', 'proxyHosts.detail.chartServed'] },
  {
    reason: 'agrees',
    keys: [
      'certificates.expiry.expired',
      'certificates.expired',
      'profile.expired',
      'proxyHosts.insights.certificateExpired',
    ],
  },
  { reason: 'agrees', keys: ['certificates.imported', 'email.certificateAlert.sourceImported'] },
  {
    reason: 'agrees',
    keys: [
      'certificates.none',
      'groups.noneGranted',
      'hostReview.noAccessList',
      'l4ProxyHosts.accessListNone',
      'l4ProxyHosts.optProxyProtocolNone',
      'profile.apiTokenAccess.none',
      'proxyHosts.none',
      'settings.health.globalCaddyConfig.valueNone',
      'settings.httpCache.cdnProviders.none',
      'settings.ldap.test.none',
      'users.mfa.none',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'certificates.healthy',
      'proxyHosts.insights.state.healthy',
      'proxyHosts.upstreamHealth.state.healthy',
      'settings.homeStatusHealthy',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'hostReview.notSet',
      'profile.notSet',
      'settings.health.notSet',
      'settings.health.defaultResponse.valueUnset',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'hostReview.on',
      'profile.twoFactor.statusOn',
      'proxyHosts.on',
      'proxyHosts.compressionOn',
      'settings.health.on',
      'users.twoFactorOn',
      'signInOverview.status.on',
      'alerts.rules.state.on',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'hostReview.off',
      'profile.twoFactor.statusOff',
      'proxyHosts.off',
      'proxyHosts.compressionOff',
      'settings.health.off',
      'settings.captcha.providers.none',
      'users.twoFactorOff',
      'waf.modeOff',
      'signInOverview.status.off',
      'alerts.rules.state.off',
      'alerts.channels.state.off',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'hostReview.fields.enabled',
      'l4ProxyHosts.optDnsEnabled',
      'proxyHosts.filterEnabled',
      'proxyHosts.optDnsEnabled',
      'settings.backupSchedules.enabled',
      'settings.enabled',
      'settings.ldap.enabled',
      'waf.enabled',
    ],
  },
  // A backup destination's S3 fields beside the DNS provider family's, read by provider name.
  {
    reason: 'composed',
    keys: ['settings.backupSchedules.endpoint', 'settings.dnsProviders.ovh.fields.endpoint.label'],
  },
  {
    reason: 'composed',
    keys: [
      'settings.backupSchedules.accessKeyId',
      'settings.dnsProviders.route53.fields.accessKeyId.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'settings.backupSchedules.secretAccessKey',
      'settings.dnsProviders.route53.fields.secretAccessKey.label',
    ],
  },
  {
    reason: 'composed',
    keys: [
      'settings.backupSchedules.status.failed',
      'settings.history.failed',
      'alerts.history.statuses.failed',
      'alerts.digests.runStatus.failed',
      'changeApprovals.statuses.failed',
    ],
  },
  {
    reason: 'agrees',
    keys: [
      'l4ProxyHosts.filterAll',
      'proxyHosts.filterAll',
      'users.filterAll',
      'changeApprovals.filters.all',
    ],
  },
  { reason: 'agrees', keys: ['mtlsRoles.optional', 'settings.health.twoFactor.valueOptional'] },
  {
    reason: 'agrees',
    keys: [
      'proxyHosts.compressionInherit',
      'settings.default',
      'settings.dnsDelegation.providerDefault',
      'waf.bodyLimitActionDefault',
    ],
  },
  { reason: 'agrees', keys: ['setup.tristateNotRequired', 'signInOverview.mfaModes.off'] },
  {
    reason: 'role',
    keys: ['attention.title', 'settings.homeStatusAttention', 'alerts.rules.sources.attention'],
  },
  {
    reason: 'role',
    keys: [
      'accessLists.ruleExpiryLabel',
      'certificates.expires',
      'profile.apiTokenExpiry.label',
      'security.expiry',
    ],
  },
  {
    reason: 'role',
    keys: [
      'analytics.host',
      'analytics.groupHost',
      'analytics.filterFields.host',
      'analytics.topColumn.hosts',
      'waf.host',
    ],
  },
  { reason: 'role', keys: ['auditLog.verifyFailed', 'certificates.reachability.failed'] },
  { reason: 'role', keys: ['auth.login.metaTitle', 'auth.login.submit', 'setup.steps.verify'] },
  {
    reason: 'role',
    keys: [
      'caddyModules.categorySecurity',
      'nav.security',
      'settings.navGroups.security',
      'settings.search.pages.blockedSources.context',
    ],
  },
  { reason: 'role', keys: ['common.done', 'overview.checklist.detected'] },
  {
    reason: 'role',
    keys: ['common.email', 'settings.groups.email', 'settings.sections.email.name'],
  },
  { reason: 'role', keys: ['common.rangeFrom', 'settings.history.compareFrom'] },
  { reason: 'role', keys: ['common.rangeTo', 'settings.history.compareTo'] },
  {
    reason: 'role',
    keys: [
      'common.twoFactorSignIn',
      'settings.blocks.twoFactor.name',
      'settings.stagedLabels.twoFactor',
    ],
  },
  { reason: 'role', keys: ['common.review', 'security.review'] },
  { reason: 'role', keys: ['common.check', 'settings.dnsDelegation.columnStatus'] },
  { reason: 'role', keys: ['nav.updateBadge', 'settings.configTransfer.actions.update'] },
  {
    reason: 'role',
    keys: ['overview.checklist.steps.analytics.action', 'security.openAnalyticsSettings'],
  },
  { reason: 'role', keys: ['profile.passkeys.add', 'profile.passkeys.addTitle'] },
  { reason: 'role', keys: ['profile.apiTokens', 'profile.apiTokenAreas.tokens'] },
  {
    reason: 'role',
    keys: ['proxyHosts.errorPageBodyPlaceholder', 'proxyHosts.errorPageDefaultBody'],
  },
  { reason: 'role', keys: ['proxyHosts.proxyHostEnabled', 'proxyHosts.proxyHostEnabledTitle'] },
  {
    reason: 'role',
    keys: [
      'settings.backup.title',
      'settings.search.pages.backup.title',
      'settings.search.pages.portableConfig.context',
    ],
  },
  {
    reason: 'role',
    keys: ['settings.configTransfer.heading', 'settings.search.pages.portableConfig.title'],
  },
  {
    reason: 'role',
    keys: ['settings.auditStreaming.navLabel', 'settings.search.pages.auditStreaming.title'],
  },
  {
    reason: 'role',
    keys: [
      'settings.checkForUpdates',
      'settings.registry.update_check_enabled.label',
      'waf.pluginsCheckUpdates',
    ],
  },
  {
    reason: 'role',
    keys: [
      'settings.dashboardHostTitle',
      'settings.sections.dashboard.name',
      'settings.blocks.dashboard.name',
      'settings.stagedLabels.dashboard',
    ],
  },
  { reason: 'role', keys: ['settings.notAnswering', 'signInOverview.status.unreachable'] },
  { reason: 'role', keys: ['settings.health.updates.detailError', 'settings.email.alertsFailed'] },
  { reason: 'role', keys: ['settings.health.ldap.valueNone', 'settings.ldap.emptyTitle'] },
  { reason: 'role', keys: ['settings.ldap.edit', 'settings.ldap.editTitle'] },
  { reason: 'role', keys: ['settings.ldap.delete', 'settings.ldap.deleteTitle'] },
  {
    reason: 'role',
    keys: ['settings.search.pages.blockedSources.title', 'security.blockedSources'],
  },
  { reason: 'role', keys: ['settings.search.pages.signInOverview.title', 'signInOverview.title'] },
  { reason: 'role', keys: ['setup.account.localCardTitle', 'setup.account.methodLocal'] },
  { reason: 'role', keys: ['setup.account.methodOauth', 'setup.account.oauthCardTitle'] },
  { reason: 'role', keys: ['ui.searchPlaceholder', 'commandPalette.searchButton'] },
  { reason: 'role', keys: ['waf.reviewedIntended', 'waf.workingAsIntended'] },
  { reason: 'role', keys: ['waf.reviewedFalsePositive', 'waf.falsePositive'] },
  { reason: 'role', keys: ['setup.migrate.submit', 'setup.steps.migrate'] },
  { reason: 'role', keys: ['ui.bulk.addTag', 'ui.hostTags.bulkLabel'] },
  {
    reason: 'sense',
    keys: [
      'accessLists.network',
      'analytics.topColumn.asns',
      'settings.sections.network.name',
      'security.kinds.cidr',
    ],
  },
  { reason: 'sense', keys: ['accessLists.ipAction', 'auditLog.action', 'waf.action'] },
  { reason: 'sense', keys: ['accessLists.ruleTarget', 'analytics.csv.key', 'proxyHosts.value'] },
  {
    reason: 'sense',
    keys: [
      'accessLists.denyStatus',
      'analytics.status',
      'analytics.filterFields.status',
      'analytics.topColumn.statusCodes',
      'common.status',
      'overview.logStatus',
      'proxyHosts.detail.status',
    ],
  },
  { reason: 'sense', keys: ['accessLists.denyBody', 'proxyHosts.body', 'waf.body'] },
  { reason: 'sense', keys: ['analytics.uri', 'proxyHosts.uri', 'waf.uri'] },
  {
    reason: 'sense',
    keys: ['analytics.rule', 'analytics.topColumn.wafRules', 'alerts.history.rule'],
  },
  {
    reason: 'sense',
    keys: [
      'auditLog.user',
      'nav.avatarAlt',
      'overview.userNameFallback',
      'users.viewAs.roles.user',
      'users.roles.user',
      'signInOverview.roles.user',
    ],
  },
  { reason: 'sense', keys: ['auth.apiErrors.forbidden', 'proxyHosts.forbidden'] },
  { reason: 'sense', keys: ['common.change', 'proxyHosts.detail.auditChange'] },
  {
    reason: 'sense',
    keys: [
      'certificates.sourceLabel',
      'setup.migrate.confirmSource',
      'security.source',
      'security.sourceValue',
    ],
  },
  {
    reason: 'sense',
    keys: [
      'common.agent',
      'settings.sections.agent.name',
      'settings.blocks.agent.name',
      'setup.account.roleAgent',
    ],
  },
  {
    reason: 'composed',
    keys: ['settings.sections.outbound.name', 'settings.blocks.outbound.name'],
  },
  {
    reason: 'sense',
    keys: [
      'groups.access',
      'hostReview.sections.http.access',
      'nav.railGroupAccess',
      'proxyHosts.detail.sections.access',
      'logs.sources.access',
      'roles.access',
    ],
  },
  { reason: 'sense', keys: ['common.restore', 'settings.backup.restore'] },
  {
    reason: 'sense',
    keys: ['hostReview.fields.tags', 'settings.tags', 'ui.hostTags.label', 'waf.tags'],
  },
  { reason: 'sense', keys: ['l4ProxyHosts.mode', 'waf.hostMode', 'waf.globalMode'] },
  {
    reason: 'sense',
    keys: ['nav.groups', 'settings.ldap.groupSource', 'roles.resources.groups.label'],
  },
  { reason: 'sense', keys: ['nav.more.groupReference', 'waf.reference'] },
  {
    reason: 'sense',
    keys: ['profile.notifications.title', 'settings.blocks.certificateAlerts.name'],
  },
  { reason: 'sense', keys: ['profile.deviceBrowser', 'proxyHosts.cacheModeBrowser'] },
  {
    reason: 'sense',
    keys: ['profile.apiTokenAccess.read', 'proxyHosts.upstreamTimeoutFields.readTimeout.label'],
  },
  { reason: 'sense', keys: ['proxyHosts.upstreamHealth.caddy', 'logs.sources.caddy'] },
  { reason: 'sense', keys: ['proxyHosts.redirectUrl', 'settings.redirectUrl'] },
  { reason: 'sense', keys: ['proxyHosts.features.tailnet', 'settings.tailnet'] },
  {
    reason: 'sense',
    keys: [
      'proxyHosts.upstreamTimeoutFields.responseHeaderTimeout.label',
      'settings.responseHeaders',
    ],
  },
  {
    reason: 'sense',
    keys: [
      'settings.type',
      'waf.pluginType',
      'security.sourceKind',
      'alerts.history.type',
      'overview.logSearchType',
    ],
  },
  { reason: 'sense', keys: ['ui.codeEditor.plaintextLabel', 'waf.filterText'] },
  { reason: 'family', keys: ['analytics.total', 'analytics.groupNone'] },
  {
    reason: 'family',
    keys: ['analytics.groupOutcome', 'analytics.outcome', 'analytics.filterFields.outcome'],
  },
  { reason: 'family', keys: ['hostReview.everyAgent', 'proxyHosts.servedByEveryAgent'] },
  { reason: 'family', keys: ['l4ProxyHosts.optDnsFamilyIpv4', 'proxyHosts.optDnsFamilyIpv4'] },
  { reason: 'family', keys: ['l4ProxyHosts.optDnsFamilyIpv6', 'proxyHosts.optDnsFamilyIpv6'] },
  { reason: 'family', keys: ['proxyHosts.detectionOnly', 'waf.modeDetectionOnly'] },
  { reason: 'channel', keys: ['auth.passwordReset.heading', 'email.passwordReset.action'] },
  { reason: 'channel', keys: ['auth.passwordReset.inviteHeading', 'email.invite.action'] },
  { reason: 'code', keys: ['auth.apiErrors.usernameTooLong', 'auth.errors.usernameTooLong'] },
  { reason: 'code', keys: ['auth.apiErrors.userNotFound', 'errors.userNotFound'] },
  { reason: 'code', keys: ['errors.viewAsStartFailed', 'users.viewAs.errorTitle'] },
  { reason: 'code', keys: ['errors.hostTooManyTags', 'ui.hostTags.tooMany'] },
  {
    reason: 'code',
    keys: ['errors.settingsFieldNotDuration', 'settings.results.dnsProviderFieldDuration'],
  },
  {
    reason: 'casing',
    keys: [
      'auditLog.systemActor',
      'nav.railGroupSystem',
      'overview.actorSystem',
      'settings.navGroups.system',
    ],
  },
  { reason: 'casing', keys: ['common.expiresOn', 'common.expiresOnInline'] },
  { reason: 'casing', keys: ['settings.homeEnvBadge', 'settings.providerSourceEnv'] },
  { reason: 'short', keys: ['certificates.manage', 'groups.capabilityManageShort'] },
  { reason: 'short', keys: ['groups.capabilityView', 'groups.capabilityViewShort'] },
  // Alerts: families read by a runtime key, and words another screen uses for its own thing.
  { reason: 'composed', keys: ['common.events', 'alerts.rules.sources.event'] },
  { reason: 'composed', keys: ['waf.exclusionAllHosts', 'alerts.rules.scopes.all'] },
  {
    reason: 'composed',
    keys: ['proxyHosts.insights.problem.certificateExpired', 'alerts.codes.certificateExpired'],
  },
  {
    reason: 'composed',
    keys: ['proxyHosts.upstreamHealth.state.failing', 'alerts.channels.state.failing'],
  },
  {
    reason: 'composed',
    keys: ['settings.backupSchedules.status.running', 'alerts.digests.runStatus.running'],
  },
  { reason: 'composed', keys: ['alerts.history.statuses.sent', 'alerts.digests.runStatus.sent'] },
  { reason: 'sense', keys: ['profile.apiTokenScope.label', 'alerts.rules.scope'] },
  { reason: 'sense', keys: ['settings.configTransfer.preview', 'alerts.digests.preview'] },
  { reason: 'sense', keys: ['settings.history.navLabel', 'alerts.tabs.history'] },
  { reason: 'sense', keys: ['waf.severity', 'alerts.rules.severity'] },
  { reason: 'sense', keys: ['waf.thresholdMark', 'alerts.rules.threshold'] },
  {
    reason: 'sense',
    keys: ['certificates.roles', 'roles.title', 'roles.resources.roles.label'],
  },
  {
    reason: 'composed',
    keys: ['nav.logs', 'roles.resources.logs.label'],
  },
  {
    reason: 'composed',
    keys: ['nav.alerts', 'roles.resources.alerts.label'],
  },
  {
    reason: 'composed',
    keys: ['profile.apiTokenAreas.hosts', 'roles.resources.hosts.label'],
  },
  {
    reason: 'agrees',
    keys: ['alerts.builtin', 'roles.builtIn'],
  },
  { reason: 'sense', keys: ['accessLists.ipNote', 'accessReviews.note'] },
  { reason: 'sense', keys: ['settings.configTransfer.export', 'accessReviews.export'] },
  { reason: 'sense', keys: ['setup.migrate.confirmStart', 'accessReviews.start'] },
  {
    reason: 'role',
    keys: [
      'settings.registry.notify_access_reviews.label',
      'settings.blocks.accessReviews.name',
      'accessReviews.title',
    ],
  },
  { reason: 'sense', keys: ['proxyHosts.reject', 'changeApprovals.reject'] },
  {
    reason: 'agrees',
    keys: ['alerts.history.statuses.withdrawn', 'changeApprovals.statuses.withdrawn'],
  },
  {
    reason: 'agrees',
    keys: ['accessReviews.statuses.applying', 'changeApprovals.statuses.applying'],
  },
  {
    reason: 'agrees',
    keys: ['accessReviews.outcomes.applied', 'changeApprovals.statuses.applied'],
  },
  { reason: 'sense', keys: ['accessReviews.csv.decision', 'changeApprovals.filters.decided'] },
  { reason: 'role', keys: ['changeApprovals.filters.pending', 'changeApprovals.statuses.pending'] },
];
