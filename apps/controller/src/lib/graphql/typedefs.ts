/**
 * Stable, queryable shapes are fields; shapes the model layer owns and validates are `JSON`, so
 * the schema cannot drift from the validator. Mutations take REST's JSON body into the same model
 * function, which is what the parity tests assert.
 */

export const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar DateTime

  """
  A reverse proxy host. Configuration the model layer validates travels in \`config\`.
  """
  type ProxyHost {
    id: Int!
    name: String!
    description: String
    """Lowercase and sorted. Labels for finding hosts; they never reach the Caddy config."""
    tags: [String!]!
    domains: [String!]!
    upstreams: [String!]!
    enabled: Boolean!
    certificateId: Int
    accessListId: Int
    sslForced: Boolean!
    hstsEnabled: Boolean!
    hstsSubdomains: Boolean!
    allowWebsocket: Boolean!
    preserveHostHeader: Boolean!
    skipHttpsHostnameValidation: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """
    Everything else the host carries: load balancing, health checks, WAF and geoblock overrides,
    location rules, redirects, rewrites, mTLS, Tailscale and forward auth.
    """
    config: JSON
  }

  """A layer 4 (TCP/UDP) stream host."""
  type L4ProxyHost {
    id: Int!
    name: String!
    description: String
    """As on ProxyHost."""
    tags: [String!]!
    protocol: String!
    listenAddress: String!
    upstreams: [String!]!
    matcherType: String!
    matcherValue: [String!]!
    tlsTermination: Boolean!
    proxyProtocolVersion: String
    proxyProtocolReceive: Boolean!
    """An access list whose IP rules apply; its passwords do not at layer 4."""
    accessListId: Int
    enabled: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """Load balancing, DNS resolution, geoblocking and anything else the model validates."""
    config: JSON
  }

  """
  A certificate. The PEM bodies and the private key are deliberately absent: they are write-only
  over the REST API too, and a field that returns a private key is a field somebody will select.
  """
  type Certificate {
    id: Int!
    name: String!
    type: String!
    domainNames: [String!]!
    autoRenew: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
    """upload, or agent-file: read from files on one agent's host."""
    source: String!
    sourceAgentId: Int
    sourceCertPath: String
    sourceKeyPath: String
    sourceReadAt: DateTime
    """Why the last read failed, as a code; the last good certificate keeps serving."""
    sourceError: String
  }

  type CaCertificate {
    id: Int!
    name: String!
    createdAt: DateTime!
  }

  type ClientCertificate {
    id: Int!
    name: String!
    caCertificateId: Int!
    revokedAt: DateTime
    createdAt: DateTime!
  }

  type MtlsRole {
    id: Int!
    name: String!
    description: String
    createdAt: DateTime!
  }

  type AccessList {
    id: Int!
    name: String!
    description: String
    entries: [AccessListEntry!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """An account in an access list. The password hash is never exposed."""
  type AccessListEntry {
    username: String!
  }

  """
  A user. The password hash and the OAuth subject are absent by construction - the resolver
  projects the fields below rather than returning the model row, so a field cannot be added here
  by accident and start leaking one.
  """
  type User {
    id: Int!
    email: String!
    name: String
    role: String!
    status: String!
    provider: String
    avatarUrl: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type Group {
    id: Int!
    name: String!
    description: String
    """"ui" for a group someone made here, "oidc" for one an IdP sync created."""
    source: String!
    members: [GroupMember!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type GroupMember {
    userId: Int!
    email: String!
    name: String
  }

  type ApiToken {
    id: Int!
    name: String!
    createdBy: Int!
    createdAt: DateTime!
    lastUsedAt: DateTime
    expiresAt: DateTime
  }

  """A token is only readable once, when it is created."""
  type CreatedApiToken {
    token: ApiToken!
    secret: String!
  }

  type AuditEvent {
    id: Int!
    userId: Int
    action: String!
    entityType: String!
    entityId: Int
    summary: String
    createdAt: DateTime!
  }

  type Agent {
    id: Int!
    name: String!
    connected: Boolean!
    lastSeenAt: DateTime
    createdAt: DateTime!
  }

  type OAuthProvider {
    id: Int!
    name: String!
    enabled: Boolean!
    issuer: String
  }

  type DnsProvider {
    id: String!
    name: String!
    configured: Boolean!
  }

  """
  healthy, failing (recent passive-check failures), unchecked (the host configures no health
  checks), unreported (Caddy does not list the address) or unknown (no agent answered).
  """
  enum UpstreamHealthState {
    healthy
    failing
    unchecked
    unreported
    unknown
  }

  """One agent's Caddy on one upstream. An agent that is offline or silent is unknown."""
  type UpstreamAgentHealth {
    """The agent's id, or null for a Caddy run without an agent."""
    agentId: Int
    name: String
    state: UpstreamHealthState!
    fails: Int!
    requests: Int!
  }

  type UpstreamHealth {
    """As the host lists it."""
    upstream: String!
    """The addresses Caddy dials for it."""
    dials: [String!]!
    """Across the agents: failing if any agent reports failures."""
    state: UpstreamHealthState!
    fails: Int!
    """At or past the passive check's max fails on some agent, so Caddy skips it there."""
    outOfRotation: Boolean!
    requests: Int!
    agents: [UpstreamAgentHealth!]!
  }

  type HostUpstreamAgent {
    agentId: Int
    name: String
    reachable: Boolean!
  }

  """Read live from Caddy on every agent serving the host; nothing is stored."""
  type HostUpstreamHealth {
    hostId: Int!
    healthChecks: Boolean!
    maxFails: Int!
    checkedAt: DateTime!
    agents: [HostUpstreamAgent!]!
    upstreams: [UpstreamHealth!]!
  }

  """Why a request ended: served, or the gate that answered it. blocked is the global deny list."""
  enum TrafficOutcome {
    served
    waf
    geo
    access
    auth
    rate_limit
    crowdsec
    blocked
  }

  """What a top list ranks. ua is the user-agent family; rule a WAF rule, from WAF events."""
  enum AnalyticsDimension {
    host
    path
    country
    asn
    status
    ip
    ua
    method
    proto
    rule
  }

  """
  One filter. op is is or not. field is a dimension or outcome; status takes 404 or 5xx, country
  XX for unplaced addresses. WAF-rule lists ignore the fields WAF events do not carry.
  """
  input AnalyticsFilterInput {
    field: String!
    op: String!
    value: String!
  }

  """
  The analytics page's state, as its URL query holds it. Sanitised as a hand-edited link is: an
  invalid filter is dropped, a custom range is cut to 92 days.
  """
  input AnalyticsQueryInput {
    """1h, 24h (the default), 7d or 30d. Ignored when from and to are both given."""
    range: String
    """Epoch seconds, for a custom range."""
    from: Int
    to: Int
    """Also the same length of time immediately before. On unless false."""
    compare: Boolean
    """none, outcome, status or host."""
    group: String
    filters: [AnalyticsFilterInput!]
    """Limit the latest-requests log to mitigated requests."""
    mitigatedOnly: Boolean
  }

  type AnalyticsWindow {
    from: Int!
    to: Int!
  }

  type AnalyticsTotals {
    requests: Float!
    bytes: Float!
    uniqueIps: Float!
    """Requests a gate answered: every outcome but served."""
    mitigated: Float!
    serverErrors: Float!
    """Null when no request in the window carried a duration (an older agent)."""
    avgDurationMs: Int
  }

  type AnalyticsBucket {
    ts: Int!
    requests: Float!
    bytes: Float!
    uniqueIps: Float!
    mitigated: Float!
    serverErrors: Float!
  }

  """Requests per bucket for one group; __other__ gathers the hosts past the busiest."""
  type AnalyticsSeries {
    key: String!
    counts: [Float!]!
  }

  type AnalyticsTopRow {
    """The value a filter on this row uses."""
    key: String!
    """An ASN's network name, or a WAF rule's message."""
    label: String
    requests: Float!
    mitigated: Float!
    serverErrors: Float!
    bytes: Float!
    uniqueIps: Float!
  }

  type AnalyticsTopList {
    dimension: AnalyticsDimension!
    rows: [AnalyticsTopRow!]!
  }

  type AnalyticsRequest {
    ts: Int!
    clientIp: String!
    countryCode: String
    asn: Float
    asnOrg: String
    host: String!
    method: String!
    uri: String!
    status: Int!
    proto: String!
    bytesSent: Float!
    durationMs: Float
    outcome: TrafficOutcome!
    userAgent: String!
  }

  type AnalyticsReport {
    analyticsDisabled: Boolean!
    loggingDisabled: Boolean!
    window: AnalyticsWindow!
    previousWindow: AnalyticsWindow
    bucketSeconds: Int!
    totals: AnalyticsTotals!
    previousTotals: AnalyticsTotals
    timeline: [AnalyticsBucket!]!
    """Index-aligned with timeline: bucket i of the period before."""
    previousTimeline: [AnalyticsBucket!]
    groups: [AnalyticsSeries!]!
    """Ten rows each."""
    topLists: [AnalyticsTopList!]!
    """Every country, for a map; the country top list is its first ten."""
    countries: [AnalyticsTopRow!]!
    """The latest 50."""
    requests: [AnalyticsRequest!]!
  }

  enum TrafficSignalKind {
    serverErrorBurst
    mitigationSpike
    blockedConcentration
  }

  """
  One finding. Which fields are set follows kind: a burst has from, to, errors, requests, share
  and ongoing; a spike mitigated, baseline and ratio (host null for every host together); a
  concentration path, outcome and requests.
  """
  type TrafficSignal {
    kind: TrafficSignalKind!
    """critical, warning or info."""
    severity: String!
    host: String
    from: Int
    to: Int
    errors: Float
    requests: Float
    share: Float
    ongoing: Boolean
    mitigated: Float
    baseline: Float
    ratio: Float
    path: String
    outcome: TrafficOutcome
  }

  type TrafficSignals {
    """False with analytics off: no signals then means unknown, not all clear."""
    available: Boolean!
    window: AnalyticsWindow!
    signals: [TrafficSignal!]!
    """Detectors that ran out of time or failed; their findings are missing."""
    skipped: [TrafficSignalKind!]!
  }

  """A named analytics page state. Shared ones are listed to every administrator."""
  type AnalyticsView {
    id: Int!
    name: String!
    """The page's URL query, without the question mark."""
    query: String!
    shared: Boolean!
    ownerId: Int!
    ownerName: String
    """Whether the caller owns it, and so may change it."""
    own: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """critical, warning or info."""
  enum AttentionSeverity {
    critical
    warning
    info
  }

  """
  Something worth an administrator's look. title and detail are English; code and values render
  it in another language from the catalog's attention.items entries.
  """
  type AttentionItem {
    """Stable across loads."""
    id: String!
    """Which provider found it, e.g. certificates, agents or traffic."""
    provider: String!
    code: String!
    severity: AttentionSeverity!
    title: String!
    detail: String!
    values: JSON!
    """A dashboard path where it is dealt with."""
    href: String
    at: DateTime
  }

  type AttentionList {
    """Worst first, at most 50."""
    items: [AttentionItem!]!
    """Providers that ran past their 4-second budget or failed: their items are missing."""
    skipped: [String!]!
    """Items past the 50."""
    truncated: Int!
  }

  """One first step, detected from the instance or marked done by an administrator."""
  type SetupChecklistStep {
    """certificate, proxyHost, analytics, secondUser or sso."""
    step: String!
    detected: Boolean!
    markedDone: Boolean!
  }

  type SetupChecklist {
    hidden: Boolean!
    steps: [SetupChecklistStep!]!
  }

  """What an administrator has set: the steps marked done and whether the list is hidden."""
  type SetupChecklistState {
    hidden: Boolean!
    done: [String!]!
  }

  type HostTrafficTotals {
    requests: Float!
    serverErrors: Float!
    uniqueIps: Float!
    bytes: Float!
    mitigated: Float!
  }

  """Half an hour."""
  type HostTrafficBucket {
    ts: Int!
    requests: Float!
    """Requests that passed every gate and did not answer 5xx."""
    served: Float!
    serverErrors: Float!
  }

  type HostTrafficPath {
    path: String!
    requests: Float!
    serverErrors: Float!
  }

  type HostTrafficStatus {
    status: Int!
    requests: Float!
  }

  """The last 24 hours of one proxy host, across every name it serves."""
  type HostTraffic {
    window: AnalyticsWindow!
    totals: HostTrafficTotals!
    timeline: [HostTrafficBucket!]!
    paths: [HostTrafficPath!]!
    statuses: [HostTrafficStatus!]!
  }

  """A page of results, with the total so a client can size its pager."""
  type AuditEventPage {
    items: [AuditEvent!]!
    total: Int!
  }

  type Query {
    proxyHosts: [ProxyHost!]!
    proxyHost(id: Int!): ProxyHost
    """Live health of a proxy host's upstreams, from Caddy on each agent that serves it."""
    proxyHostUpstreamHealth(id: Int!): HostUpstreamHealth!
    l4ProxyHosts: [L4ProxyHost!]!
    l4ProxyHost(id: Int!): L4ProxyHost
    certificates: [Certificate!]!
    certificate(id: Int!): Certificate
    caCertificates: [CaCertificate!]!
    clientCertificates: [ClientCertificate!]!
    mtlsRoles: [MtlsRole!]!
    accessLists: [AccessList!]!
    accessList(id: Int!): AccessList
    users: [User!]!
    user(id: Int!): User
    groups: [Group!]!
    group(id: Int!): Group
    apiTokens: [ApiToken!]!
    agents: [Agent!]!
    oauthProviders: [OAuthProvider!]!
    dnsProviders: [DnsProvider!]!
    """At most 200 events per page, as over REST."""
    auditLog(limit: Int, offset: Int, search: String): AuditEventPage!
    """
    One settings group as /api/v1/settings/{group} serves it, e.g. "general" or "dns-provider".
    Shape belongs to the group; credentials are redacted.
    """
    settings(group: String!): JSON
    """The Caddy modules compiled into the running binary."""
    caddyModules: JSON
    """Tiles, chart, top lists and latest requests for one analytics page state."""
    analyticsReport(query: AnalyticsQueryInput): AnalyticsReport!
    """One top list under the same filters, up to 100 rows."""
    analyticsTopList(
      query: AnalyticsQueryInput
      dimension: AnalyticsDimension!
      limit: Int
    ): [AnalyticsTopRow!]!
    """
    5xx bursts, mitigation spikes and blocked-traffic concentrations. The last 24 hours unless
    from and to say otherwise; detectors still running after budgetMs (default 4000) are skipped.
    """
    trafficSignals(from: Int, to: Int, budgetMs: Int): TrafficSignals!
    """The caller's saved analytics views and everyone's shared ones."""
    analyticsViews: [AnalyticsView!]!
    """
    Needs attention, as the overview shows it; with proxyHostId, only items about that host.
    Each provider has a 4-second budget.
    """
    attention(proxyHostId: Int): AttentionList!
    """The overview's first-steps checklist."""
    setupChecklist: SetupChecklist!
    """A proxy host's last 24 hours; null with analytics off."""
    proxyHostTraffic(id: Int!): HostTraffic
  }

  type Mutation {
    createProxyHost(input: JSON!): ProxyHost!
    updateProxyHost(id: Int!, input: JSON!): ProxyHost!
    deleteProxyHost(id: Int!): Boolean!
    """
    As POST /api/v1/proxy-hosts/bulk: { action, ids, certificateId?, accessListId?, tag? }, all
    or nothing. Returns how many hosts changed.
    """
    bulkProxyHosts(input: JSON!): Int!

    createL4ProxyHost(input: JSON!): L4ProxyHost!
    updateL4ProxyHost(id: Int!, input: JSON!): L4ProxyHost!
    deleteL4ProxyHost(id: Int!): Boolean!
    """As POST /api/v1/l4-proxy-hosts/bulk: { action, ids, tag? }, all or nothing."""
    bulkL4ProxyHosts(input: JSON!): Int!

    createAccessList(input: JSON!): AccessList!
    updateAccessList(id: Int!, input: JSON!): AccessList!
    deleteAccessList(id: Int!): Boolean!

    createGroup(input: JSON!): Group!
    updateGroup(id: Int!, input: JSON!): Group!
    deleteGroup(id: Int!): Boolean!
    addGroupMember(groupId: Int!, userId: Int!): Boolean!
    removeGroupMember(groupId: Int!, userId: Int!): Boolean!

    updateUser(id: Int!, input: JSON!): User!
    deleteUser(id: Int!): Boolean!

    createApiToken(input: JSON!): CreatedApiToken!
    deleteApiToken(id: Int!): Boolean!

    saveSettings(group: String!, input: JSON!): JSON!

    """At most 100 per user. query is the page's URL query; it is stored sanitised."""
    createAnalyticsView(name: String!, query: String!, shared: Boolean): AnalyticsView!
    """The caller's own views only. Changes whichever of the arguments are given."""
    updateAnalyticsView(id: Int!, name: String, query: String, shared: Boolean): AnalyticsView!
    deleteAnalyticsView(id: Int!): Boolean!

    """Mark a setup checklist step done, or not, by hand. Detected steps stay ticked either way."""
    setSetupStepDone(step: String!, done: Boolean!): SetupChecklistState!
    """Hide the setup checklist for every administrator, or show it again."""
    setSetupChecklistHidden(hidden: Boolean!): SetupChecklistState!

    """Rebuild and push the Caddy configuration to every agent. All of them, or none."""
    applyCaddyConfig: Boolean!

    """
    What this agent currently has applied. Requires a signed agent, not a user token.
    Refused when the agent has no open subscription: a status from an unreachable host would
    make the dashboard claim it is reachable.
    """
    agentStatus(status: JSON!): Boolean!

    """Results for the Caddy admin calls the controller is blocked on. Signed agents only."""
    agentCommandResults(results: [JSON!]!): Boolean!

    """
    Parsed Caddy log rows for the controller to write to ClickHouse. Signed agents only. Malformed
    rows are dropped and counted: the answer is { accepted, rejected }.
    """
    agentAnalytics(kind: String!, rows: [JSON!]!): JSON!

    """
    What this agent read from the certificate files it was asked to watch. Signed agents only, and
    only for certificates whose source is this agent. Answers { resend }: the ids sent without PEM
    whose fingerprint the controller does not hold.
    """
    agentCertificateFiles(results: [JSON!]!): JSON!
  }

  """
  The controller's half of the agent conversation.

  One long-lived subscription per agent, carrying desired state, commands, an opening hello and a
  periodic ping. Delivered over SSE, which is what the agent already spoke - the difference is
  that the framing now belongs to the GraphQL server rather than to the registry.
  """
  type Subscription {
    agentEvents: JSON!
  }
`;
