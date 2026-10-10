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
  One changed field of a host, as the editor's review step lists it. Secret-looking values read
  "[masked]". A nested field lists its changed settings in leaves, with before and after null.
  """
  type HostFieldChange {
    field: String!
    """The editor section the field sits in."""
    section: String!
    before: JSON
    after: JSON
    """[{ path, before, after }], one per changed setting inside a nested field."""
    leaves: JSON
    masked: Boolean!
    """False for what a new host cannot be saved without."""
    revertible: Boolean!
  }

  type HostImpactAgent {
    id: Int!
    name: String!
    connected: Boolean!
  }

  """What saving would set off. Warnings are codes with values, e.g. domainInUse { domain, host }."""
  type HostChangeImpact {
    """False when nothing that reaches Caddy changed."""
    reload: Boolean!
    """The agents sent a new config: those serving the host before or after."""
    agents: [HostImpactAgent!]!
    everyAgent: Boolean!
    pinned: Boolean!
    pinChanged: Boolean!
    """[{ domain, wildcard }]: names Caddy will request a certificate for."""
    certificates: JSON!
    """[{ code, severity, values }]"""
    warnings: JSON!
  }

  type HostChangePreview {
    """http or l4."""
    kind: String!
    hostId: Int
    changes: [HostFieldChange!]!
    impact: HostChangeImpact!
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

  """A CA that issues client certificates. Its private key, when stored, is never answered."""
  type CaCertificate {
    id: Int!
    name: String!
    hasPrivateKey: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A client certificate a CA issued. The PEM is absent, as on Certificate."""
  type ClientCertificate {
    id: Int!
    caCertificateId: Int!
    commonName: String!
    serialNumber: String!
    fingerprintSha256: String!
    validFrom: DateTime!
    validTo: DateTime!
    revokedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type MtlsRole {
    id: Int!
    name: String!
    description: String
    certificateCount: Int!
    """The client certificates holding the role."""
    certificateIds: [Int!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  Who may reach a path on a proxy host with mTLS on: certificates holding one of the roles or named
  outright, or nobody with denyAll. Checked by priority, highest first.
  """
  type MtlsAccessRule {
    id: Int!
    proxyHostId: Int!
    pathPattern: String!
    allowedRoleIds: [Int!]!
    allowedCertIds: [Int!]!
    denyAll: Boolean!
    priority: Int!
    description: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type AccessList {
    id: Int!
    name: String!
    description: String
    entries: [AccessListEntry!]!
    """In the order they are checked: the first that matches the client decides."""
    rules: [AccessListRule!]!
    """allow or deny: what a client no rule matches gets."""
    ipDefault: String!
    """all (rules and a password) or any (either)."""
    satisfy: String!
    passAuth: Boolean!
    """Null is the plain 403."""
    denyResponse: AccessListDenyResponse
    """Refuse a request whose client cannot be told apart from a trusted proxy."""
    failClosed: Boolean!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  One target per rule: an address or range, a hostname, a country (ISO 3166 alpha-2), a continent
  (AF AN AS EU NA OC SA) or an ASN.
  """
  type AccessListRule {
    action: String!
    cidr: String
    hostname: String
    country: String
    continent: String
    """Up to 4294967295, past Int's range."""
    asn: Float
    note: String
    """Past it the rule no longer applies, and is deleted within a minute."""
    expiresAt: DateTime
  }

  """A status (400-599) and body, or a 302 to redirectUrl."""
  type AccessListDenyResponse {
    status: Int!
    body: String
    redirectUrl: String
  }

  """Traffic is null with analytics off or unreachable; it covers the last 24 hours."""
  type AccessListStats {
    hosts: Int!
    stopped: Int
    failedSignIns: Int
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
    """The last completed sign-in; null before the first one this release recorded."""
    lastSignInAt: DateTime
    """password, passkey, oidc or ldap."""
    lastSignInMethod: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """A dashboard sign-in. The token is not here; a forward-auth session is a ForwardAuthSession."""
  type Session {
    id: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    expiresAt: DateTime!
    ipAddress: String
    userAgent: String
    """The session making this request; false for a token."""
    current: Boolean!
  }

  """A sign-in through the portal to one protected host, kept apart from dashboard sessions."""
  type ForwardAuthSession {
    id: Int!
    userId: Int!
    proxyHostId: Int!
    """Scheme, host and non-default port, exactly as visited."""
    audienceOrigin: String!
    expiresAt: DateTime!
    createdAt: DateTime!
  }

  """One grant to sign in through the portal to a host: a user or a group, never both."""
  type ForwardAuthAccessEntry {
    id: Int!
    proxyHostId: Int!
    userId: Int
    groupId: Int
    createdAt: DateTime!
  }

  type Group {
    id: Int!
    name: String!
    description: String
    """"ui" for a group someone made here, "oidc" for one an IdP sync created."""
    source: String!
    """A role key every member holds besides their own; never admin."""
    role: String
    members: [GroupMember!]!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  """
  What its holders may do. The four built-in roles have no name (a client names them) and cannot
  change; the rest an administrator made.
  """
  type Role {
    key: String!
    name: String
    description: String
    builtIn: Boolean!
    """As resource:read and resource:write; a write always brings its read."""
    capabilities: [String!]!
    """Hosts and agents only as far as the holder's groups are granted them, as an operator."""
    scoped: Boolean!
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
    """full (the owner's role), read (no mutation) or custom (the permissions below)."""
    scope: String!
    """area:read or area:write, for a custom scope; empty otherwise."""
    permissions: [String!]!
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
    """Field-level before and after, secrets masked; null when the event recorded none."""
    changes: [AuditChange!]
    """For a proxy or L4 host write, the hostRevision it made."""
    revisionId: Int
  }

  type AuditChange {
    field: String!
    """The host editor section, for host fields."""
    section: String
    """A scalar, a list of scalars, or null; null for a nested field, which lists leaves."""
    before: JSON
    after: JSON
    leaves: [AuditLeafChange!]
    masked: Boolean!
  }

  type AuditLeafChange {
    path: String!
    before: JSON
    after: JSON
  }

  """
  The first place the audit log's hash chain does not hold. reason: missing, link, content, head
  (the newest events were removed or rewritten), unchained (an event added outside the chain) or
  legacy (events from before the chain were removed).
  """
  type AuditChainBreak {
    reason: String!
    seq: Int
    eventId: Int
  }

  type AuditChainVerification {
    ok: Boolean!
    checked: Int!
    """Events written before the chain existed, each sealed with a mark rather than linked."""
    legacy: Int!
    firstBroken: AuditChainBreak
    verifiedAt: DateTime!
  }

  """One row a config import would create, update or skip. reason and values explain a skip."""
  type ConfigImportItem {
    table: String!
    label: String!
    action: String!
    reason: String
    values: JSON!
    fields: [String!]!
    """Before and after per field, secrets masked, as the audit log shows them."""
    changes: JSON!
    """Columns the file would have changed but an import never does, such as a revocation."""
    kept: [String!]!
  }

  type ConfigImportPreview {
    appVersion: String!
    exportedAt: String!
    sections: [String!]!
    items: [ConfigImportItem!]!
    """{ create, update, skip }"""
    counts: JSON!
    """{ code, values }: rows dropped because what they named is not on this instance."""
    warnings: [JSON!]!
  }

  type Agent {
    id: Int!
    name: String!
    connected: Boolean!
    lastSeenAt: DateTime
    createdAt: DateTime!
    """The last configuration this agent's Caddy refused, until one loads again."""
    lastApplyFailure: AgentApplyFailure
  }

  type AgentApplyFailure {
    at: DateTime!
    """Caddy's refusal as the controller worded it."""
    error: String!
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

  """A WAF rule switched off globally or on one host, optionally under a path or for one variable."""
  type WafExclusion {
    id: Int!
    ruleId: Int!
    """Null applies to every host."""
    proxyHostId: Int
    hostName: String
    """Decoded and normalised; a trailing * covers everything below it."""
    path: String
    """A variable the rule then skips, such as ARGS:content."""
    target: String
    reason: String!
    createdBy: String
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input WafExclusionInput {
    ruleId: Int!
    proxyHostId: Int
    path: String
    target: String
    reason: String
  }

  """An entry of the global deny list, checked before every other handler on HTTP hosts."""
  type BlockedSource {
    id: Int!
    """ip, cidr, country, continent or asn."""
    kind: String!
    value: String!
    reason: String!
    """Null never expires."""
    expiresAt: DateTime
    createdBy: String
    createdAt: DateTime!
  }

  input BlockedSourceInput {
    kind: String!
    value: String!
    reason: String
    """Must be in the future; null never expires."""
    expiresAt: DateTime
  }

  type WafMatchedRule {
    ruleId: Int
    message: String!
    severity: String
    """What the rule added to the anomaly score."""
    points: Int!
    """The variable it matched, e.g. ARGS:id."""
    variable: String
    data: String
    paranoiaLevel: Int
    tags: [String!]!
  }

  type WafEventExplanation {
    rules: [WafMatchedRule!]!
    totalScore: Int!
    """Whether the score is the one the rule set reported, rather than summed here."""
    scoreReported: Boolean!
    threshold: Int!
    decidingRuleId: Int
  }

  type WafEventReview {
    """intended or false_positive."""
    verdict: String!
    reviewedBy: String
    reviewedAt: DateTime!
  }

  type SuggestedWafExclusion {
    ruleId: Int!
    proxyHostId: Int
    hostName: String
    path: String
    target: String
  }

  type WafEventSummary {
    """Stable across pages; names the event to wafEvent and reviewWafEvent."""
    key: String!
    ts: Int!
    host: String!
    clientIp: String!
    countryCode: String
    method: String!
    uri: String!
    ruleId: Int
    ruleMessage: String
    severity: String
    blocked: Boolean!
  }

  type WafEventRelay {
    agentId: String!
    name: String
  }

  """A WAF event in full. Credentials in the record are redacted."""
  type WafEventDetail {
    event: WafEventSummary!
    """The agent that relayed the event; its name is null once it is no longer paired."""
    relayedBy: WafEventRelay
    explanation: WafEventExplanation!
    suggestedExclusion: SuggestedWafExclusion
    """The request as a curl command, credentials redacted."""
    curl: String!
    """The redacted audit record, as JSON."""
    rawRecord: String
    review: WafEventReview
  }

  """
  The security events page for one state. source is traffic (access-log outcomes), waf (WAF events
  alone, when outcomes are not recorded) or none (analytics are off). Shaped as the page uses it.
  """
  type SecurityReport {
    source: String!
    window: AnalyticsWindow!
    previousWindow: AnalyticsWindow!
    bucketSeconds: Int!
    ruleSet: JSON!
    totals: JSON!
    buckets: [Int!]!
    series: JSON!
    peak: JSON
    topRules: JSON!
    topSources: JSON!
    events: JSON!
  }

  """An S3-compatible bucket (kind s3) or a folder under the data volume's backups/ (kind local)."""
  type BackupDestination {
    id: Int!
    name: String!
    kind: String!
    endpoint: String!
    region: String!
    bucket: String!
    prefix: String!
    accessKeyId: String!
    """Whether a secret access key is stored. The key itself is never answered."""
    hasSecret: Boolean!
    virtualHostedStyle: Boolean!
    path: String!
    createdAt: String!
    updatedAt: String!
  }

  """secretAccessKey left empty keeps the stored one, unless the endpoint, bucket or key ID changed."""
  input BackupDestinationInput {
    name: String!
    kind: String!
    endpoint: String
    region: String
    bucket: String
    prefix: String
    accessKeyId: String
    secretAccessKey: String
    virtualHostedStyle: Boolean
    path: String
  }

  """
  Where alerts go. email and push are built in and set up under Settings and Profile; the rest is
  a webhook, Discord, Slack, Teams or ntfy. No URL, token or signing secret is ever answered.
  """
  type AlertChannel {
    id: Int!
    name: String!
    """email, push, webhook, discord, slack, teams or ntfy."""
    kind: String!
    """email or push for the built-in two."""
    builtin: String
    enabled: Boolean!
    """Where it posts, with any path or query that may hold a token left out."""
    target: String!
    server: String
    topic: String
    headerNames: [String!]!
    hasSigningSecret: Boolean!
    hasToken: Boolean!
    """Failed sends in a row."""
    failures: Int!
    retryAt: String
    lastSentAt: String
    lastError: String
    lastErrorAt: String
    lastErrorCode: String
    """Only in the answer to the save that generated it: a new webhook's signing secret."""
    signingSecret: String
    createdAt: String!
    updatedAt: String!
  }

  """A blank value keeps that header's stored value."""
  input AlertChannelHeaderInput {
    name: String!
    value: String
  }

  """
  url for webhook, discord, slack and teams; server, topic and token for ntfy. Blank secrets keep
  the stored ones; a webhook saved with no signingSecret gets one, answered once.
  """
  input AlertChannelInput {
    name: String!
    kind: String!
    enabled: Boolean
    url: String
    signingSecret: String
    headers: [AlertChannelHeaderInput!]
    server: String
    topic: String
    token: String
    clearToken: Boolean
  }

  """delivered, or accepted where the service only says it will post (Teams, push)."""
  type AlertChannelTestResult {
    outcome: String!
    recipients: [String!]
  }

  """
  What is worth telling, and where. builtin names the notification category a built-in rule
  stands for: its on switch (on) is that category's Settings toggle.
  """
  type AlertRule {
    id: Int!
    name: String!
    builtin: String
    """event, attention, signal or metric."""
    source: String!
    """By source: kinds, codes, signals, or metric, comparison, threshold and minutes."""
    config: JSON!
    """all, hosts or tags."""
    scope: String!
    hostIds: [Int!]!
    tags: [String!]!
    """critical, warning or info."""
    severity: String!
    channelIds: [Int!]!
    quietMinutes: Int!
    enabled: Boolean!
    on: Boolean!
    silencedUntil: String
    settingKey: String
    createdAt: String!
    updatedAt: String!
  }

  """Left out of an update, a field keeps its stored value."""
  input AlertRuleInput {
    name: String
    source: String
    kinds: [String!]
    codes: [String!]
    signals: [String!]
    """serverErrorShare (percent), requests, serverErrors or mitigated."""
    metric: String
    """above or below."""
    comparison: String
    threshold: Float
    minutes: Int
    scope: String
    hostIds: [Int!]
    tags: [String!]
    severity: String
    channelIds: [Int!]
    quietMinutes: Int
    enabled: Boolean
    silencedUntil: String
  }

  type AlertDelivery {
    id: Int!
    channelId: Int!
    channelName: String!
    channelKind: String!
    """pending, sent, failed, dropped or withdrawn."""
    status: String!
    attempts: Int!
    lastError: String
    sentAt: String
    updatedAt: String!
  }

  """One alert as one rule raised it, with each channel's delivery."""
  type AlertEvent {
    id: Int!
    key: String!
    ruleId: Int
    ruleName: String
    ruleBuiltin: String
    kind: String!
    category: String
    severity: String!
    """notice, problem or recovery."""
    type: String!
    event: JSON!
    at: String!
    resolvedAt: String
    deliveries: [AlertDelivery!]!
  }

  type AlertDigestResult {
    channelId: Int!
    name: String!
    ok: Boolean!
    error: String
  }

  """One send of a digest. slot is the occurrence it was for, or a send-now's own start."""
  type AlertDigestRun {
    id: Int!
    digestId: Int!
    slot: String!
    """schedule, catch-up or manual."""
    trigger: String!
    """running, sent, partial or failed."""
    status: String!
    results: [AlertDigestResult!]!
    error: String
    startedAt: String!
    finishedAt: String
  }

  """A daily report at time (HH:MM) in timeZone, to its channels (email and any added channel)."""
  type AlertDigest {
    id: Int!
    name: String!
    time: String!
    timeZone: String!
    channelIds: [Int!]!
    enabled: Boolean!
    nextRunAt: String
    lastRun: AlertDigestRun
    createdAt: String!
    updatedAt: String!
  }

  input AlertDigestInput {
    name: String!
    time: String!
    timeZone: String
    channelIds: [Int!]!
    enabled: Boolean
  }

  """The plain-text form of what a digest would say now, in the caller's time zone."""
  type AlertDigestPreview {
    subject: String!
    text: String!
  }

  """
  An identity provider's SCIM provisioning connection (PostgreSQL only). Its bearer token is
  answered once, when the connection is made or its token rotated; it is no API token.
  """
  type ScimConnection {
    id: Int!
    name: String!
    enabled: Boolean!
    """The token's last four characters."""
    tokenHint: String!
    """Whether an account that already has the provisioned email is linked rather than refused."""
    linkExisting: Boolean!
    """Role key to the provisioned group names that give a group that role."""
    roleGroups: JSON!
    users: Int!
    groups: Int!
    createdAt: DateTime!
    updatedAt: DateTime!
    lastUsedAt: DateTime
    tokenRotatedAt: DateTime
  }

  """
  A campaign asking reviewers whether each piece of access in its scope should stay. scope is
  allUsers, role, group, grants, tokens or scim; scopeRef names the role key or group id. status
  is open, applying, confirming (revocations wait for an administrator) or closed.
  """
  type AccessReview {
    id: Int!
    name: String!
    scope: String!
    scopeRef: String
    """YYYY-MM-DD; due at the end of that day, UTC."""
    dueOn: String!
    status: String!
    createdBy: Int
    createdAt: DateTime!
    closedAt: DateTime
    appliedAt: DateTime
    reviewers: [AccessReviewReviewer!]!
    counts: AccessReviewCounts!
  }

  type AccessReviewReviewer {
    id: Int!
    label: String!
  }

  type AccessReviewCounts {
    total: Int!
    decided: Int!
    keep: Int!
    revoke: Int!
    change: Int!
    applied: Int!
    failed: Int!
  }

  """
  One piece of access under review, with the names it had when the campaign opened. kind is role,
  membership, grant, token or scimConnection; hints are noRecentSignIn, tokenUnused,
  connectionUnused and groupEmpty.
  """
  type AccessReviewItem {
    id: Int!
    campaignId: Int!
    kind: String!
    userId: Int
    groupId: Int
    tokenId: Int
    connectionId: Int
    objectKind: String
    objectId: Int
    subjectLabel: String!
    targetLabel: String
    """The role key, a grant's view or manage, or a connection's enabled or disabled."""
    current: String
    hints: [String!]!
    """Provisioned by SCIM, which would undo a revocation: revoke is refused."""
    scimManaged: Boolean!
    reviewerId: Int
    reviewerLabel: String
    """keep, revoke or change; null until decided."""
    decision: String
    changeTo: String
    note: String
    decidedAt: DateTime
    """applied, failed or gone; null until applied."""
    outcome: String
    outcomeCode: String
  }

  type AccessReviewDetail {
    campaign: AccessReview!
    """Every item for whoever may read users; otherwise only the caller's own."""
    items: [AccessReviewItem!]!
  }

  """
  A write held for approval. kind names it (proxyHostUpdate, accessListRules, settingsApply...);
  area is hosts, accessLists, waf or settings. status is pending, applying, applied, failed,
  rejected, withdrawn or invalidated (what it edits changed after it was submitted). preview is
  what approvers are shown, secrets masked: { type: "host", host } for a host editor's own
  review, { type: "fields", changes } otherwise, and { type: "settings", keys, changes, config }
  for settings.
  """
  type ChangeRequest {
    id: Int!
    kind: String!
    area: String!
    targetType: String
    targetId: Int
    targetName: String
    tags: [String!]!
    status: String!
    requiredApprovals: Int!
    approvals: Int!
    requestedBy: Int
    requestedByName: String
    """Submitted with an API token."""
    viaToken: Boolean!
    bypassedByName: String
    bypassReason: String
    """Why it failed or was invalidated: an error code, and the English message."""
    resultCode: String
    error: String
    createdAt: DateTime!
    decidedAt: DateTime
    appliedAt: DateTime
    decisions: [ChangeDecision!]!
    preview: JSON!
    """For the caller: may approve or reject it, withdraw it, or bypass its approvals."""
    mayDecide: Boolean!
    mayWithdraw: Boolean!
    mayBypass: Boolean!
  }

  type ChangeDecision {
    userId: Int
    userName: String
    """approve or reject."""
    decision: String!
    note: String
    createdAt: DateTime!
  }

  """
  Which writes wait for approval. scope is everything, areas (hosts, accessLists, waf, settings)
  or tags (host changes where the host carries one of tags, before or after). applyToTokens off
  lets API token writes apply at once, audited as having skipped approval.
  """
  type ApprovalPolicy {
    enabled: Boolean!
    scope: String!
    areas: [String!]!
    tags: [String!]!
    approverRoles: [String!]!
    approverGroupIds: [Int!]!
    requiredApprovals: Int!
    applyToTokens: Boolean!
  }

  type ScimConnectionWithToken {
    connection: ScimConnection!
    """Shown this once; CPM keeps only its hash."""
    token: String!
  }

  """
  Where the audit log is streamed: syslog over UDP, TCP or TLS, an HTTP receiver, or a JSON lines
  file on the data volume. An HTTP sink's URL and auth header value are never answered.
  """
  type AuditSink {
    id: Int!
    name: String!
    """syslog-udp, syslog-tcp, syslog-tls, http or file."""
    kind: String!
    enabled: Boolean!
    """WAF events and other mitigated requests, as records of kind security outside the chain."""
    includeSecurity: Boolean!
    """Where it sends: host:port, the HTTP origin (path and query left out), or the file name."""
    target: String!
    host: String
    port: Int
    """syslog-udp: the largest datagram, in bytes."""
    maxBytes: Int
    """A PEM CA trusted for this sink besides the system's."""
    ca: String
    """http: identity, gzip or zstd."""
    encoding: String
    """http: set after the receiver answered 415, until the sink is saved again."""
    encodingFallback: Boolean!
    headerName: String
    hasHeaderValue: Boolean!
    fileName: String
    """The last audit seq delivered."""
    auditCursor: Int!
    """The last security record delivered."""
    securityCursor: Int!
    """Audit events not yet delivered."""
    auditLag: Int!
    """Security records not yet delivered; null while they are not included."""
    securityLag: Int
    """Failed passes in a row."""
    failures: Int!
    retryAt: String
    lastDeliveredAt: String
    lastError: String
    lastErrorAt: String
    """The latest records pruned before this sink received them: audit or security, and seqs."""
    gapStream: String
    gapFrom: Int
    gapTo: Int
    gapAt: String
    """Records lost to gaps, in total."""
    missed: Int!
    createdAt: String!
    updatedAt: String!
  }

  """
  host and port for syslog (port defaults to 514, or 6514 for TLS), maxBytes for UDP, url,
  encoding and the auth header for http, fileName for file. A blank url or headerValue keeps the
  stored one; the header value must be given again when the URL's origin changes.
  """
  input AuditSinkInput {
    name: String!
    kind: String!
    enabled: Boolean
    includeSecurity: Boolean
    host: String
    port: Int
    maxBytes: Int
    ca: String
    url: String
    encoding: String
    headerName: String
    headerValue: String
    clearHeaderValue: Boolean
    fileName: String
  }

  """encodingRefused: the receiver answered 415, so the test went uncompressed."""
  type AuditSinkTestResult {
    encodingRefused: Boolean!
  }

  """One run of a schedule. slot is the cron occurrence it ran for, or a manual run's start."""
  type BackupRun {
    id: Int!
    scheduleId: Int!
    scheduleName: String
    slot: String!
    """schedule, catch-up or manual."""
    trigger: String!
    """running, succeeded or failed."""
    status: String!
    objectKey: String
    bytes: Float
    durationMs: Int
    error: String
    startedAt: String!
    finishedAt: String
  }

  type BackupSchedule {
    id: Int!
    name: String!
    destinationId: Int!
    destinationName: String!
    """Five fields, read in timeZone."""
    cron: String!
    timeZone: String!
    prefix: String!
    includeAuditLog: Boolean!
    includeSettingsHistory: Boolean!
    keepLast: Int
    keepDays: Int
    enabled: Boolean!
    nextRunAt: String
    lastRun: BackupRun
    createdAt: String!
    updatedAt: String!
  }

  """
  passphrase seals every backup the schedule makes; at least 12 characters, and left empty on an
  update to keep the stored one. It is stored encrypted so runs need nobody present.
  """
  input BackupScheduleInput {
    name: String!
    destinationId: Int!
    cron: String!
    timeZone: String
    prefix: String
    includeAuditLog: Boolean
    includeSettingsHistory: Boolean
    keepLast: Int
    keepDays: Int
    passphrase: String
    enabled: Boolean
  }

  """
  One stored state of a proxy (kind "http") or L4 (kind "l4") host, taken after every write.
  operation: create, update, maintenance, delete, bulk, import, rollback or restore. A delete
  revision holds the host as it was just before, which is what restoring it brings back.
  """
  type HostRevision {
    id: Int!
    kind: String!
    hostId: Int!
    operation: String!
    """The bulk action ({ action, tag? }), or the revision a rollback or restore came from."""
    detail: JSON
    userId: Int
    userName: String
    createdAt: DateTime!
    """The host's name in this revision."""
    name: String!
    """The host as stored, shaped as the proxyHost or l4ProxyHost query answers it."""
    host: JSON!
    agentIds: [Int!]!
    """What the revision names that has since been deleted; rollbackHost refuses while any remain."""
    missingReferences: [HostReference!]!
  }

  """kind: certificate, accessList, agent, caCertificate, clientCertificate or mtlsRole."""
  type HostReference {
    kind: String!
    id: Int!
  }

  type HostRevisionComparison {
    from: Int!
    to: Int!
    """Field changes as the audit log records them, secrets masked."""
    changes: JSON!
    """
    The rendered Caddy config, this host swapped in from each side: { lines, added, removed,
    unchanged }, secrets masked. Null unless asked for, or when it could not be rendered.
    """
    config: JSON
  }

  type DeletedHost {
    hostId: Int!
    name: String!
    """The deletion's revision; restoreHost takes it."""
    revisionId: Int!
    deletedAt: DateTime!
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
    """The mTLS roles a client certificate holds, by name."""
    clientCertificateRoles(id: Int!): [MtlsRole!]!
    mtlsRoles: [MtlsRole!]!
    """A proxy host's mTLS access rules, as GET /api/v1/proxy-hosts/{id}/mtls-access-rules."""
    mtlsAccessRules(proxyHostId: Int!): [MtlsAccessRule!]!
    accessLists: [AccessList!]!
    accessList(id: Int!): AccessList
    accessListStats(id: Int!): AccessListStats!
    users: [User!]!
    user(id: Int!): User
    """The caller's live dashboard sessions, newest first; another user's with users:read."""
    sessions(userId: Int): [Session!]!
    """Every live forward-auth session, or one user's."""
    forwardAuthSessions(userId: Int): [ForwardAuthSession!]!
    """Who may sign in through the portal to a host, as GET /api/v1/proxy-hosts/{id}/forward-auth-access."""
    forwardAuthAccess(proxyHostId: Int!): [ForwardAuthAccessEntry!]!
    groups: [Group!]!
    group(id: Int!): Group
    """Built-in first, then the ones made here, oldest first."""
    roles: [Role!]!
    role(key: String!): Role
    """Every capability a role can hold."""
    capabilities: [String!]!
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
    """
    Every sign-in method and whether it is on, linked-account counts, directory health,
    group-to-role mappings and the two-factor policy, as Users > Sign-in overview shows them.
    """
    signInOverview: JSON!
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
    """Every WAF exclusion."""
    wafExclusions: [WafExclusion!]!
    """One WAF event by its key: what matched, the score, and the narrowest exclusion for it."""
    wafEvent(key: String!): WafEventDetail!
    """The security events page. page is the WAF event list's, 50 to a page."""
    securityReport(query: AnalyticsQueryInput, page: Int): SecurityReport!
    """The global deny list, expired entries included until the expiry pass removes them."""
    blockedSources: [BlockedSource!]!
    backupDestinations: [BackupDestination!]!
    backupSchedules: [BackupSchedule!]!
    """Newest first; limit defaults to 50, at most 500."""
    backupRuns(scheduleId: Int, limit: Int): [BackupRun!]!
    alertChannels: [AlertChannel!]!
    alertDigests: [AlertDigest!]!
    """Newest first; limit defaults to 20, at most 100."""
    alertDigestRuns(digestId: Int!, limit: Int): [AlertDigestRun!]!
    """timeZone defaults to the digest's own."""
    previewAlertDigest(id: Int!, timeZone: String): AlertDigestPreview!
    alertRules: [AlertRule!]!
    auditSinks: [AuditSink!]!
    scimConnections: [ScimConnection!]!
    """Every campaign for whoever may read users; otherwise the ones the caller reviews."""
    accessReviews: [AccessReview!]!
    accessReview(id: Int!): AccessReviewDetail
    """
    Pending first, then newest. An approver, or anyone who reads the audit log, sees every request;
    anyone else their own. status is pending or decided; both when omitted.
    """
    changeRequests(status: String, limit: Int): [ChangeRequest!]!
    changeRequest(id: Int!): ChangeRequest
    approvalPolicy: ApprovalPolicy!
    """Newest first; page with before (the last id seen). limit defaults to 50, at most 200."""
    alertHistory(
      ruleId: Int
      channelId: Int
      severity: String
      type: String
      status: String
      from: String
      to: String
      before: Int
      limit: Int
    ): [AlertEvent!]!
    """A host's revisions, newest first. kind is "http" or "l4"; limit defaults to 20, at most 200."""
    hostRevisions(kind: String!, hostId: Int!, limit: Int, offset: Int): [HostRevision!]!
    hostRevision(id: Int!): HostRevision
    """from may be 0, before the host existed. config also renders the Caddy config diff."""
    compareHostRevisions(
      kind: String!
      hostId: Int!
      from: Int!
      to: Int!
      config: Boolean
    ): HostRevisionComparison
    """Hosts whose last revision is their deletion, newest first."""
    deletedHosts(kind: String!): [DeletedHost!]!
  }

  type Mutation {
    createProxyHost(input: JSON!): ProxyHost!
    updateProxyHost(id: Int!, input: JSON!): ProxyHost!
    deleteProxyHost(id: Int!): Boolean!
    """
    Validates input as createProxyHost (no id) or updateProxyHost would, and returns the field diff
    and impact without storing anything. revert names fields to leave as stored.
    """
    previewProxyHost(id: Int, input: JSON!, revert: [String!]): HostChangePreview!
    """
    As POST /api/v1/proxy-hosts/bulk: { action, ids, certificateId?, accessListId?, tag? }, all
    or nothing. Returns how many hosts changed.
    """
    bulkProxyHosts(input: JSON!): Int!

    createL4ProxyHost(input: JSON!): L4ProxyHost!
    updateL4ProxyHost(id: Int!, input: JSON!): L4ProxyHost!
    deleteL4ProxyHost(id: Int!): Boolean!
    """As previewProxyHost, for a layer 4 host."""
    previewL4ProxyHost(id: Int, input: JSON!, revert: [String!]): HostChangePreview!
    """As POST /api/v1/l4-proxy-hosts/bulk: { action, ids, tag? }, all or nothing."""
    bulkL4ProxyHosts(input: JSON!): Int!
    """
    Puts a live host back as the revision stored it, as a new revision. Refused while the revision
    names anything since deleted; the dashboard instead loads it into the editor to choose others.
    """
    rollbackHost(revisionId: Int!): HostRevision!
    """
    Brings a deleted host back from one of its revisions, under its old id. Refused when one of
    its domains (or, at layer 4, its listener) is now taken, or when it names anything since
    deleted unless dropMissingReferences is true.
    """
    restoreHost(revisionId: Int!, dropMissingReferences: Boolean): HostRevision!

    """Recomputes the audit log's hash chain and reports the first broken link."""
    verifyAuditChain: AuditChainVerification!
    """
    The portable config, sealed under passphrase, as base64 of the JSON file. sections: hosts,
    accessLists, certificates, groups, security, settings; all when omitted.
    """
    exportConfig(passphrase: String!, sections: [String!]): String!
    """What importing file (base64) would create, update or skip. Writes nothing."""
    previewConfigImport(file: String!, passphrase: String!): ConfigImportPreview!
    """Imports file (base64), planned afresh against the current state. A domain in use is skipped."""
    applyConfigImport(file: String!, passphrase: String!): ConfigImportPreview!

    createAccessList(input: JSON!): AccessList!
    updateAccessList(id: Int!, input: JSON!): AccessList!
    deleteAccessList(id: Int!): Boolean!
    """As PUT /api/v1/access-lists/{id}/ip-rules: the whole ordered set, replacing what was there."""
    setAccessListRules(id: Int!, rules: JSON!): AccessList!

    """
    As POST /api/v1/certificates: { name, type, domainNames, autoRenew?, providerOptions?,
    certificatePem?, privateKeyPem? }, or { source: "agent-file", name, sourceAgentId,
    sourceCertPath, sourceKeyPath } to read the pair from files on an agent's host.
    """
    createCertificate(input: JSON!): Certificate!
    updateCertificate(id: Int!, input: JSON!): Certificate!
    """Refused while a host still uses it."""
    deleteCertificate(id: Int!): Boolean!
    """Reads an agent-file certificate from its files again now; a failure is stored on the row."""
    rereadCertificate(id: Int!): Certificate!

    """input: { name, certificatePem, privateKeyPem? }. With the key, the CA can issue client certificates."""
    createCaCertificate(input: JSON!): CaCertificate!
    """Deletes the certificates it issued too. Refused while a host trusts any of them."""
    deleteCaCertificate(id: Int!): Boolean!

    """
    Records a client certificate already issued under a CA, as POST /api/v1/client-certificates:
    { caCertificateId, commonName, serialNumber, fingerprintSha256, certificatePem, validFrom, validTo }.
    """
    issueClientCertificate(input: JSON!): ClientCertificate!
    """Hosts stop accepting it on the next apply. Refused once already revoked."""
    revokeClientCertificate(id: Int!): ClientCertificate!

    """input: { name, description? }."""
    createMtlsRole(input: JSON!): MtlsRole!
    updateMtlsRole(id: Int!, input: JSON!): MtlsRole!
    deleteMtlsRole(id: Int!): Boolean!
    """Gives a client certificate the role."""
    addMtlsRoleCertificate(roleId: Int!, certificateId: Int!): MtlsRole!
    removeMtlsRoleCertificate(roleId: Int!, certificateId: Int!): Boolean!

    """input: { pathPattern, allowedRoleIds?, allowedCertIds?, denyAll?, priority?, description? }."""
    createMtlsAccessRule(proxyHostId: Int!, input: JSON!): MtlsAccessRule!
    updateMtlsAccessRule(id: Int!, input: JSON!): MtlsAccessRule!
    deleteMtlsAccessRule(id: Int!): Boolean!

    createGroup(input: JSON!): Group!
    updateGroup(id: Int!, input: JSON!): Group!
    deleteGroup(id: Int!): Boolean!
    addGroupMember(groupId: Int!, userId: Int!): Boolean!
    removeGroupMember(groupId: Int!, userId: Int!): Boolean!
    """Null takes the role away. Only a role the caller holds all of, and never admin."""
    setGroupRole(groupId: Int!, role: String): Group!

    """input: { name, description, capabilities, scoped }. Only what the caller holds."""
    createRole(input: JSON!): Role!
    updateRole(key: String!, input: JSON!): Role!
    """Refused while a user, group, mapping or provider default still names it."""
    deleteRole(key: String!): Boolean!

    """
    As POST /api/v1/users: input { email, password, name?, role?, username? }. A local account with
    a password; refused while sign-in is left to the identity provider. Only a role the caller holds all of.
    """
    createUser(input: JSON!): User!
    updateUser(id: Int!, input: JSON!): User!
    deleteUser(id: Int!): Boolean!
    """One of the caller's own sessions; anyone else's is not found."""
    revokeSession(id: Int!): Boolean!
    """Signs that portal session out of its host."""
    revokeForwardAuthSession(id: Int!): Boolean!
    """
    As PUT /api/v1/proxy-hosts/{id}/forward-auth-access: input { userIds, groupIds }, the whole set,
    replacing what was there.
    """
    setForwardAuthAccess(proxyHostId: Int!, input: JSON!): [ForwardAuthAccessEntry!]!

    """
    input: name, expiresAt, scope (full, read or custom) and permissions (area:read or
    area:write). A scope narrows the owner's role and never widens it.
    """
    createApiToken(input: JSON!): CreatedApiToken!
    deleteApiToken(id: Int!): Boolean!

    saveSettings(group: String!, input: JSON!): JSON!
    """
    Stores one provider's credentials, keyed as its fields are named; a blank field keeps the stored
    value. The first provider saved becomes the default. Answers the dns-provider group, redacted.
    """
    saveDnsProviderCredentials(provider: String!, credentials: JSON!): JSON!
    """Forgets a provider's credentials. Refused while a delegation names it."""
    removeDnsProvider(provider: String!): JSON!
    """A configured provider for DNS-01 challenges, or null for none."""
    setDefaultDnsProvider(provider: String): JSON!

    """At most 100 per user. query is the page's URL query; it is stored sanitised."""
    createAnalyticsView(name: String!, query: String!, shared: Boolean): AnalyticsView!
    """The caller's own views only. Changes whichever of the arguments are given."""
    updateAnalyticsView(id: Int!, name: String, query: String, shared: Boolean): AnalyticsView!
    deleteAnalyticsView(id: Int!): Boolean!

    """Mark a setup checklist step done, or not, by hand. Detected steps stay ticked either way."""
    setSetupStepDone(step: String!, done: Boolean!): SetupChecklistState!
    """Hide the setup checklist for every administrator, or show it again."""
    setSetupChecklistHidden(hidden: Boolean!): SetupChecklistState!

    """
    Compiled by Coraza on an agent first; refused, or undone when Caddy refuses the config.
    Rules 949110, 949111, 959100 and 959101 cannot be excluded.
    """
    createWafExclusion(input: WafExclusionInput!): WafExclusion!
    updateWafExclusion(id: Int!, input: WafExclusionInput!): WafExclusion!
    deleteWafExclusion(id: Int!): Boolean!
    """Review a WAF event as intended or false_positive; null clears the review."""
    reviewWafEvent(key: String!, verdict: String): WafEventReview
    """Adds to the deny list, or updates the reason and expiry of an entry already on it."""
    createBlockedSource(input: BlockedSourceInput!): BlockedSource!
    deleteBlockedSource(id: Int!): Boolean!

    """Rebuild and push the Caddy configuration to every agent. All of them, or none."""
    applyCaddyConfig: Boolean!

    createBackupDestination(input: BackupDestinationInput!): BackupDestination!
    updateBackupDestination(id: Int!, input: BackupDestinationInput!): BackupDestination!
    """Refused while a schedule writes to it."""
    deleteBackupDestination(id: Int!): Boolean!
    """
    Writes, reads back and deletes a probe object: the saved destination id, or input unsaved
    (with id, a blank secret means the stored one). Errors say what failed.
    """
    testBackupDestination(id: Int, input: BackupDestinationInput): Boolean!
    createBackupSchedule(input: BackupScheduleInput!): BackupSchedule!
    updateBackupSchedule(id: Int!, input: BackupScheduleInput!): BackupSchedule!
    deleteBackupSchedule(id: Int!): Boolean!
    """Runs the schedule now, outside its timing, and answers once the run has finished."""
    runBackupNow(scheduleId: Int!): BackupRun
    createAlertChannel(input: AlertChannelInput!): AlertChannel!
    updateAlertChannel(id: Int!, input: AlertChannelInput!): AlertChannel!
    """Also takes it out of every rule and digest."""
    deleteAlertChannel(id: Int!): Boolean!
    """Straight to the channel: a saved one by id, or the input as typed (blank secrets from id)."""
    testAlertChannel(id: Int, input: AlertChannelInput): AlertChannelTestResult!
    createAlertRule(input: AlertRuleInput!): AlertRule!
    updateAlertRule(id: Int!, input: AlertRuleInput!): AlertRule!
    """Built-in rules cannot be deleted."""
    deleteAlertRule(id: Int!): Boolean!
    """Nothing is raised until until; null lifts the silence."""
    silenceAlertRule(id: Int!, until: String): AlertRule!
    """Queues a test alert through the rule's channels; the event id, or 0 with none enabled."""
    testAlertRule(id: Int!): Int!
    createAlertDigest(input: AlertDigestInput!): AlertDigest!
    updateAlertDigest(id: Int!, input: AlertDigestInput!): AlertDigest!
    deleteAlertDigest(id: Int!): Boolean!
    """Sends the digest now, outside its timing, and answers once it has gone."""
    sendAlertDigestNow(id: Int!): AlertDigestRun
    createAuditSink(input: AuditSinkInput!): AuditSink!
    updateAuditSink(id: Int!, input: AuditSinkInput!): AuditSink!
    deleteAuditSink(id: Int!): Boolean!

    """
    input: { name, enabled, linkExisting, roleGroups }. Needs users and groups write, and every
    mapped role is one the caller could give. Refused under SQLite.
    """
    createScimConnection(input: JSON!): ScimConnectionWithToken!
    """roleGroups left out keeps the mapping as it is."""
    updateScimConnection(id: Int!, input: JSON!): ScimConnection!
    """The old token stops working at once."""
    rotateScimConnectionToken(id: Int!): ScimConnectionWithToken!
    """Its groups move to the Groups page; its accounts are signed out and otherwise kept."""
    deleteScimConnection(id: Int!): Boolean!
    """
    input: { name, scope, scopeRef, dueOn, reviewerIds }. Takes a snapshot of the scope; items are
    shared among the reviewers, never one about the reviewer's own access.
    """
    createAccessReview(input: JSON!): AccessReview!
    """input: { name, dueOn }, while open."""
    updateAccessReview(id: Int!, input: JSON!): AccessReview!
    reassignAccessReviewItems(id: Int!, itemIds: [Int!]!, reviewerId: Int!): AccessReview!
    """
    The caller's own item only. decision is keep, revoke or change; changeTo is a role key or a
    grant's view or manage.
    """
    decideAccessReviewItem(itemId: Int!, decision: String!, changeTo: String, note: String): AccessReviewItem!
    """Applies the revocations as the caller, or leaves them for confirmation when Settings says so."""
    closeAccessReview(id: Int!): AccessReview!
    """Applies what a closed campaign revoked, or tries the failures again."""
    confirmAccessReview(id: Int!): AccessReview!
    deleteAccessReview(id: Int!): Boolean!
    """
    An approver's yes. The approval the request still needs applies it, as its requester; nobody
    approves their own. Answers the request as it stands after.
    """
    approveChangeRequest(id: Int!, note: String): ChangeRequest!
    """One rejection ends a request."""
    rejectChangeRequest(id: Int!, note: String): ChangeRequest!
    """Whoever submitted a pending request may take it back."""
    withdrawChangeRequest(id: Int!): ChangeRequest!
    """
    Administrators only: applies a pending request without its approvals. Audited and alerted;
    reason is required.
    """
    bypassChangeRequest(id: Int!, reason: String!): ChangeRequest!
    """
    input as ApprovalPolicy. A settings change, so it waits for approval itself while the policy
    covers settings.
    """
    setApprovalPolicy(input: JSON!): ApprovalPolicy!
    """One test record, straight to the sink: a saved one by id, or the input as typed."""
    testAuditSink(id: Int, input: AuditSinkInput): AuditSinkTestResult!

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
