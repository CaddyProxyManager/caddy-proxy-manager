# Caddy Proxy Manager

Web interface for managing [Caddy Server](https://caddyserver.com/) reverse proxies and certificates. This fork is for redoing the original UI in a way that I like and trying to make the application as lightweight as possible.

> **Moved to the CaddyProxyManager org.** Images are now `ghcr.io/caddyproxymanager/{web,caddy,agent}`
> and deployments come from the [deploy repository](https://github.com/CaddyProxyManager/deploy).
> An install older than 3.6.1 is not told about new releases:
> [move it over](https://caddyproxy.com/start/install/#from-ghcriosilentspud).

> **3.0 changes how this is configured.** Most settings now live in the database and are entered
> through a first-run setup flow in the browser, not in `.env`. PostgreSQL is the default database
> (SQLite remains available), and an existing pre-3.0 installation is migrated in-app rather than by
> hand. See [First run](#first-run)
> and [The database](#the-database). It is a large change and the 3.0 line is still in beta, so
> take a backup before upgrading.

## Overview

Caddy Proxy Manager is a web UI for Caddy Server, so you do not have to edit JSON configurations or Caddyfiles by hand. It manages reverse proxies, access lists and certificates through an Astryx interface. Built with Vinext version whatever, React 19, Astryx, Tailwind CSS, Drizzle ORM, and TypeScript. Analytics data (traffic events, WAF events) is stored in ClickHouse, which aggregates it quickly and drops old rows by TTL (after 30 days by default, configurable).

---

## Installation

Clone the [deploy repository](https://github.com/CaddyProxyManager/deploy) into a directory named
`caddy-proxy-manager` - Compose names the volumes after it, so the name is what keeps your data. It
holds `docker-compose.yml`, `.env.example` and the files they mount, one commit per release, with the
images pinned to that release. Without git, the same files are in
`caddy-proxy-manager-<version>-deploy.tar.gz` on each [release](https://github.com/CaddyProxyManager/caddy-proxy-manager/releases/latest).

It includes the [managed CrowdSec](#crowdsec) container, behind its Compose profile: it does not
run until **Settings → CrowdSec** turns managed mode on.

A host with no route to the internet installs from the release's air-gap bundle: CPM's images as
files, the deployment files with a load script, and a signed manifest naming the third-party
images by digest, which you bring in through a mirror, your own registry or `docker load`. Turn on
offline mode (`OFFLINE_MODE=true`, or **Settings → Outbound connections**) so the controller opens
no connections to the internet on its own. See
[installing without internet access](https://caddyproxy.com/start/offline/).

```bash
git clone https://github.com/CaddyProxyManager/deploy.git caddy-proxy-manager
cd caddy-proxy-manager

# The only two values a fresh install has to have. That is the whole .env --
# everything else is entered in the browser on first run. See .env.example for
# the variables that exist, when you need one setup does not cover.
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" >> .env
chmod 600 .env

docker compose up -d
```

To upgrade: `git pull && docker compose pull && docker compose up -d`. Keep your own changes in
`docker-compose.override.yml`, which git ignores, so a pull never conflicts; the
[install guide](https://caddyproxy.com/start/install/#upgrading) covers moving an archive install to
git.

That also starts the bundled `postgres` service the app keeps its data in, so there is no database
server to run yourself. Then open `http://localhost:3000` and follow [First run](#first-run) - every URL redirects there
until setup is finished. There is no administrator to sign in as until you create one.

Data persists in Docker volumes: `postgres-data` (the database), `caddy-manager-data` (which also
holds the GeoIP databases), `agent-data`, `caddy-data`, `caddy-config`, `caddy-logs`, `acme-ca`,
`clickhouse-data` when analytics are on, and `crowdsec-data` and `crowdsec-config` when CrowdSec is
managed.

Requires **Docker Engine 26 or later**: Caddy mounts a subdirectory of the agent's volume, and
volume subpaths arrived in 26.0.

### Upgrading to relayed analytics

Agents no longer write to ClickHouse: they send the events they parse to the controller, which checks
them and writes them itself. Upgrade every agent along with the controller - an older agent is sent
no ClickHouse credentials and records nothing until it is upgraded. Then:

- **Nothing on an agent's host needs to reach ClickHouse.** If you published ClickHouse's port or
  joined a remote agent to the `analytics` network for that, undo it.
- **Only the agent in the controller's stack runs ClickHouse.** Agents elsewhere were asked to start
  a `clickhouse` container of their own, which nothing read. They stop it now; delete its volume on
  those hosts with `docker volume rm <project>_clickhouse-data`. A deployment whose bundled agent
  paired before the controller recorded which agent that is keeps asking every agent, until the
  bundled agent next pairs itself.

### Upgrading from the geoipupdate container

The controller now downloads the GeoLite2 databases itself, so the `geoipupdate` container and the
`geoip-data` volume are gone from `docker-compose.yml`. There is nothing to reconfigure: it uses the
account ID and licence key already saved under **Settings → Geo-blocking → GeoIP databases** (or still in `.env`), downloads
fresh databases onto `caddy-manager-data` on its first start, and every agent picks them up from
there. After pulling the new `docker-compose.yml`, on the controller host and on every agent host:

```bash
docker compose up -d --remove-orphans
docker volume rm <project>_geoip-data
```

`--remove-orphans` removes the old `geoipupdate-<HOSTNAME>` container, which nothing starts or stops
any more. The volume only exists on hosts that ran it. Delete `HOSTNAME` from `.env`, and
`geoipupdate` from `COMPOSE_PROFILES` if you listed it there.

### Upgrading to the non-root agent

The agent used to run as root and keep its database on `caddy-manager-data`. It now runs as its own
user (`10002`) with an `agent-data` volume of its own. Pull the new `docker-compose.yml` and
`docker compose up -d` as usual: on its first start the agent copies its database and generated
compose files across, so it keeps its identity and pairing and does not re-ingest old logs. The
copies left on `caddy-manager-data` (`agent.db*`, `docker-compose.caddy-build.yml`,
`docker-compose.l4-ports.yml`) are no longer read and can be deleted.

Caddy switches to the agent's copy of the GeoIP databases the next time the agent recreates it. If
the Agents page then reports a log permission problem - an existing `waf-audit.log` is usually
`0644`, which the agent can read but not truncate - it shows the one command that fixes it.

### Upgrading to the isolated Caddy admin API

Caddy's admin API no longer listens on `caddy-network`, where your upstream containers could reach
it, but on an internal `caddy-admin` network only web and the agent share. PostgreSQL and ClickHouse
move to internal networks of their own, and the agent no longer reads `.env`. After pulling the new
`docker-compose.yml`, on the controller host and on every agent host that runs it:

```bash
docker compose up -d
docker rm -f caddy-proxy-manager-caddy
docker compose restart agent
```

The old Caddy container is not on the new network, so the agent cannot reach its admin API until
it is replaced. Removing it keeps its volumes, and the restarted agent starts a new one with its own
port and module overrides. Then check:

- **`CADDY_API_URL` in `.env`.** Delete it, or set `http://caddy-admin:2019`: `caddy` can resolve to
  Caddy's `caddy-network` address, where the admin API no longer answers.
- **A `docker-compose.override.yml` that interpolates variables** into `caddy` or `clickhouse`.
  The agent's Compose sees only the agent's environment now, so forward each one
  under `agent.environment` in the override, as `MY_VAR: ${MY_VAR:-}`.
- **`.env` stays `0600`.** If you loosened it so the agent could read it, tighten it again.
- **Analytics already on.** The ClickHouse container keeps the old network until recreated; switch
  analytics off and on again under Settings so the agent recreates it with the stored credentials.
- **An `acme-ca` volume from an earlier release** keeps its old `0777` mode. Tighten it with
  `docker run --rm -v <project>_acme-ca:/acme-ca alpine sh -c 'chown 10001:10001 /acme-ca && chmod 0755 /acme-ca'`,
  using web's `PUID`/`PGID` if you changed them.

### Upgrading to WAF-checked WebSockets

A WebSocket upgrade used to skip the WAF, so adding two headers to an ordinary request took an
attack past it too. Upgrades now go through the WAF like any other request: the handshake is
inspected, the messages after it are not. A handshake the CRS flags is now refused with 403; if
that is a false positive, suppress the rule for that host from the event drawer.

A host's **WebSocket support** switch used to matter only with the WAF on. Off now refuses upgrades
with 403 on every host. Hosts keep the value they had, which is on unless someone turned it off.

---

## First run

A fresh install has no accounts and nothing configured. The first request lands on `/setup`, and
the app serves nothing else until the flow finishes.

1. **Controller or agent.** Agents are set up from their own host and paired later - choosing it
   here just says so. See [The agent](#the-agent).
2. **Create the first administrator**, or configure an OAuth provider instead of a local account.
3. **Sign in.** Deliberately before anything else is entered: a mistyped password or a wrong OAuth
   client secret is otherwise only discovered after the whole configuration has been filled in, and
   the only way out is deleting the database.
4. **Settings.** Everything that used to live in `.env` - public URL, analytics, GeoIP credentials,
   authentication policy - pre-filled with whatever the environment already provides, each field
   showing where its value came from. **Save** writes them to the database and opens the dashboard.
   Nothing is stored before Save.

The stage is derived from what exists, not tracked as a counter, so a half-finished setup resumes
where it left off and the back button cannot desynchronise it. Setup is one-way: once complete,
`/setup` redirects away.

Two things skip the flow entirely:

- **An existing pre-3.0 installation.** A SQLite database found on the host is offered for
  migration *before* account creation - you want its accounts, not a new one alongside them. You
  choose which parts to bring; leaving the users out continues to account creation rather than the
  login page. See [Upgrading from a pre-3.0 install](#upgrading-from-a-pre-30-install-which-used-sqlite).
- **A deployment that predates the flow.** If `ADMIN_USERNAME`/`ADMIN_PASSWORD` or `OAUTH_ENABLED`
  configure a way in and someone can already sign in, setup is marked complete at startup and never
  shown. Upgrading an existing install changes nothing about how it starts.

### Proxying the dashboard itself

Setup finishes by pointing CPM at the one upstream every deployment already has: this dashboard.
It becomes a proxy host CPM maintains for you, so a new install is serving something by name
before you have created anything.

The domain comes from `DASHBOARD_DOMAIN` if you set it, and otherwise from the hostname in
`BASE_URL` - the address you are already reaching CPM at. A localhost address says nothing about
how the instance will be reached, so that leaves the host switched off with the field ready.

It comes up on **HTTP**. Forcing HTTPS before the domain reaches you would mean a fresh install's
first act is a certificate order failing on a name nobody has pointed at it yet.

HTTPS is turned on by a check you run from **Settings → Dashboard host**, once the host is live.
The check sends a request to the domain and looks for a signature only this instance can produce:

| What the check finds | What happens |
| -------------------- | ------------ |
| The request came back here, signed | HTTPS on. DNS, the network in between and Caddy's route all work, so a certificate order will too |
| The domain resolves but the request arrived elsewhere | HTTPS off, with the address it currently points at |
| Nothing answers for the name | HTTPS off. Create the record, then check again |

The check asks no third party: no IP-echo service, no external resolver. Because the request is
made from this deployment, there are two situations it cannot see through: a resolver
inside your network that points the name here while public DNS does not (passes, and ACME still
fails), and a network that will not let a request leave and come back by its own public address
(fails, though the outside world reaches you fine). The toggle is a default you can override in
both.

**This host is managed, not stored.** It is generated from those settings every time the
configuration is applied, so it is not in Proxy hosts and nothing can delete it by accident.
It is also placed ahead of every other route, so a host somebody creates for the same domain
cannot shadow the one the dashboard is reached through.

**You cannot lock yourself out with it.** The controller publishes its own port, so
`http://<host>:3000` reaches this dashboard whatever the route is doing - including when you turn
the host off, which the settings page warns about first if you are reading it through that very
domain.

### Runtime

[Bun](https://bun.sh) is the only supported runtime. The app reaches PostgreSQL through
`Bun.SQL` and SQLite through `bun:sqlite`, Bun built-ins with no Node.js equivalent, so it refuses
to start under Node.js and tells you what to run instead.

For local work:

```bash
bun install
bun run dev
```

The web image does not need Bun installed, and does not contain the Bun CLI. What it
runs is `cpm-server`, a single executable produced by `bun build --compile`, holding
the Bun runtime and the production server. The application bundle itself stays on disk
beside the binary, in `dist/` - vinext loads it with a runtime `import()`, which Bun's
embedded-asset filesystem cannot serve, so it cannot be compiled in.

There is one runtime image, and the end-to-end suite runs that same image rather than a
variant with extra tooling, so what the tests exercise is what ships. Since the image
has no interpreter to execute a script with, the suite seeds its fixtures through the
`db-seed` container in `apps/controller/tests/docker-compose.test.yml` - a throwaway `oven/bun:1-slim`
that mounts the same data volume. See `apps/controller/tests/helpers/seed.ts`.

The container health check is `cpm-server --healthcheck`, which probes `/api/health`
from inside the image - the runtime has no shell HTTP client to call instead.

`cpm-server --reset-2fa <username>` turns off a user's two-factor sign-in and removes their passkeys
on the running server - the way back in for an administrator who has lost both their authenticator
and their backup codes.
Run it inside the container: `docker compose exec web /app/cpm-server --reset-2fa admin`.

`cpm-server --enable-user <username>` enables a user disabled after repeated failed sign-ins, and
starts their count over - the way back in when that user is the only administrator:
`docker compose exec web /app/cpm-server --enable-user admin`.

`cpm-server --lift-mfa-policy` turns the two-factor policy off on the running server - the way back
in when it locks out everyone who could change it:
`docker compose exec web /app/cpm-server --lift-mfa-policy`.

`cpm-server --lift-sso-enforcement` stops requiring single sign-on on the running server, so
passwords and passkeys work again - the way back in when the identity provider is down and no
break-glass account was named: `docker compose exec web /app/cpm-server --lift-sso-enforcement`.

`cpm-server --copy-to-postgres` copies a SQLite database into an empty PostgreSQL one and exits; see
[Moving from SQLite to PostgreSQL](#moving-from-sqlite-to-postgresql).

---

## Features

- **Proxy hosts** - Reverse proxies with custom headers, multiple upstreams, load balancing (12 policies, including weighted and query/header/cookie hashing), active/passive health checks, retries, Force HTTPS, HSTS, WebSocket, Preserve Host header and Discourage search engines switches, zstd/gzip compression (global, with a per-host override), maintenance mode (a 503 with bypass addresses, toggled from the host list), upstream connect, read, write and stream timeouts, rate limiting (a 429 with Retry-After and the host's 429 page, with the opt-in Rate Limit module) per client IP, IP and path, request header or signed-in forward-auth user, optionally per method, with global zones a host inherits, merges with or overrides and a never-limited address list, live upstream health from every serving agent, free-text notes, tags with a tag filter, duplicate (domains and secrets left out), a review before saving (Ctrl/Cmd+S: each changed field before and after with secrets hidden and an undo, the agents that reload, the certificates requested and warnings such as a domain already in use or a protection removed; also a GraphQL and REST preview), an unsaved-change count and a prompt before leaving with unsaved edits, editor sections you can link to, enable/disable toggle, and bulk actions on ticked hosts (enable, disable, delete, maintenance, certificate, access list, add tag - all or nothing, one reload). With analytics on, the list shows each host's requests against the busiest one, its 5xx count, a status worked out from 5xx bursts and shares, unusual blocking and certificate trouble, its protections and its certificate's days left, busiest first. Each host has a page of its own: what needs attention, its last day of traffic in a chart, top paths and status codes, its upstreams' live health, a line per editor section linking into the editor, and its recent changes
- **L4 proxy hosts** - TCP/UDP stream proxying on a port or a port range (each connection optionally sent to the port it arrived on), with TLS SNI matching, proxy protocol (v1/v2), load balancing (7 policies), health checks, per-host geo blocking, an access list's rules (addresses, countries, continents and ASNs), notes, tags, duplicate, the same review before saving as proxy hosts, and bulk enable/disable/delete/add tag. Automatic Docker Compose port management via agent
- **Location rules** - Path-based routing to different upstreams per proxy host (e.g. `/api/*` to one backend, `/ws/*` to another), each with its own access list or the host's
- **Redirect and rewrite** - Per-host redirect rules (301/302/307/308), optionally keeping the request's path and query (whole, or after the rule's prefix), and path prefix rewriting
- **Cache assets** - Per-host asset caching: browser Cache-Control defaults, or a shared Caddy cache with the opt-in HTTP Cache module, kept in memory, on disk, in Redis or in etcd, with Cloudflare or Fastly purging
- **Forward auth portal** - Built-in identity provider for protecting proxy hosts without an external IdP. Credential and OAuth login portal, user groups with membership management, per-host access control by user or group, and excluded paths that bypass authentication
- **WAF** - Web application firewall built on Coraza, with the optional OWASP Core Rule Set (SQLi, XSS, LFI, RCE). Off, detection-only or blocking, globally and per host; paranoia level and anomaly thresholds; rule exclusions scoped to a host, a path or one variable, checked by Coraza and rolled back if Caddy refuses them; a "why was this blocked" view of each event with its rules, points and score; named rule presets, plugins from the CRS plugin registry, custom SecLang directives checked by the editor and by a real Caddy before they are saved, WebSocket handshakes inspected like any other request, and a searchable event log with severity and blocked/detected classification, credentials redacted
- **Needs attention** - The overview opens with what is wrong right now, worst first: certificates expiring or failing to renew, a configuration Caddy refused, agents offline or failing an operation, 5xx bursts, blocking spikes and blocked traffic piling up on one path, an LDAP directory that cannot be reached, accounts locked or disabled after failed sign-ins, L4 ports waiting to be applied, CRS plugins switched off and GeoIP updates failing. Each check has a 4-second budget and a slow one is skipped and said so. Operators see what touches the hosts and agents granted to them. Administrators also get a setup checklist (a certificate, a first host, analytics, a second user, single sign-on) that ticks itself, can be marked done by hand, or hidden
- **Security events** - One page for everything that stopped a request: the rule set, mitigated requests by outcome against the previous period, the busiest moment explained, top rules and sources with one-click exclusions and blocks, and the WAF events. Admin only
- **Blocked sources** - A global deny list of addresses, networks, countries, continents and ASNs, checked before anything else on every HTTP host, with optional expiry. Admin only
- **Analytics** - Requests, bandwidth, unique IPs, mitigated requests and 5xx rate against the previous period; why each request ended (served, or the WAF, geo block, access list, sign-in, rate limit or CrowdSec that stopped it) and how long it took; is / is-not filters on every dimension; ten top lists, a country map and a latest-requests log; CSV export; and saved views you can share
- **Geo blocking** - Block or allow traffic by country, continent, ASN, CIDR range, or exact IP per proxy host. Allow rules override block rules. Fail-closed mode, custom response codes/bodies, and trusted proxy support
- **Bot challenge** - A proof-of-work challenge from your own [Anubis](https://anubis.techaro.lol/) instance, in its subrequest mode, per proxy host: checked after the WAF and before any sign-in, so it combines with forward auth, with exempt paths for API clients and webhooks. Never on the dashboard host
- **CrowdSec** - Caddy as a CrowdSec bouncer, against a CrowdSec container the bundled agent runs and feeds Caddy's access log, or your own Local API: every proxy host and L4 host refuses banned addresses (403, or 429 with Retry-After for a throttle), with a per-host opt-out, optional AppSec inspection and a Test connection button. Sharing signals with CrowdSec's online API is off unless you turn it on. The bouncer key is encrypted at rest and never returned. Needs the opt-in CrowdSec module
- **Access lists** - Multi-account HTTP basic auth (bcrypt-hashed) and ordered allow/deny rules on the client (IPv4, IPv6, hostnames such as dynamic-DNS names, which the controller re-resolves as their TTLs expire, countries, continents and ASNs), each with a note and an optional expiry, combined as "all" or "any", assignable per proxy host or per location rule, and by their rules alone to L4 hosts. Each list sets its deny response (a status and body, or a redirect), can fail closed when the client cannot be placed, and shows the requests it stopped and failed sign-ins over the last day with analytics on. A list something uses cannot be deleted. The upstream only sees the credentials when "Pass auth to host" is on - off for new lists, on for lists made before the switch existed
- **Certificates** - Automatic HTTPS for every proxy host via Caddy ACME (Let's Encrypt / ZeroSSL) with expiry read from each agent's storage, on-demand renewal, a reachability test (with an opt-in Let's Debug check) and certificate and key downloads, manual SSL/TLS import with expiry monitoring (a certificate a host uses cannot be deleted; unused imports go in one click), certificates read from files an agent's host keeps renewing (`CERT_FILES_HOST_DIR`), and a built-in CA for issuing and revoking internal client certificates (mTLS)
- **mTLS** - Mutual TLS per proxy host using built-in CA certificates. Issue, track, and revoke client certificates. Fail-closed revocation (all certs revoked = all connections rejected)
- **mTLS RBAC** - Role-based access control for mTLS client certificates. Define roles, assign certs to roles, and create path-based access rules per proxy host (e.g. `/admin/*` requires the "ops" role)
- **User roles** - Four built-in roles (Viewer, User, Operator, Admin) and custom roles made from per-area permissions, controlling dashboard access, API permissions and feature visibility. A group can give a role to its members, and identity-provider groups can map to any role
- **User management** - Admin page for managing users: edit roles, status, profiles; invite by email or email a reset link; disable or delete accounts; reset two-factor sign-in; search and filter. The last active admin cannot be demoted, disabled or deleted
- **View as** - Preview the dashboard as an operator, user or viewer, or as an operator in chosen groups, from Users or a group. It only narrows your own session, ends after an hour, and is audited under your name
- **Groups** - Organize users into groups for forward auth access control. Assign groups to proxy hosts to grant access to all members at once
- **Authentik integration** - Forward-auth SSO per proxy host with configurable header forwarding and protected paths
- **Forward auth (external)** - Point a host at any forward-auth server (Authelia preset, or custom). Optionally answer non-browser callers with 401 instead of the login redirect, and let a header such as `X-Api-Key` bypass auth so the upstream checks it itself. **Settings → Forward auth → Forward auth defaults** sets what new hosts inherit
- **Tailscale** - Serve a proxy host privately on your tailnet, gate it on the caller's Tailscale identity, or reach a backend that only exists on the tailnet. A Tailscale node runs inside the Caddy container - no `tailscaled` on the host, no TUN device, no published ports - and `*.ts.net` certificates come from Tailscale rather than ACME
- **DNS controls** - Custom DNS resolvers per host, upstream DNS pinning with IPv4/IPv6/both address family selection
- **GraphQL API** - Every resource under `/api/graphql`, with Bearer token authentication. One endpoint, one schema, introspectable by any GraphQL client. The agent protocol lives in the same schema as a subscription, separated by which credential a field requires
- **REST API (deprecated)** - `/api/v1/` still works exactly as it did, with Bearer token authentication and interactive OpenAPI 3.1.0 docs at `/api-docs`. It is no longer the documented path and will be removed in a later release; new integrations should use GraphQL
- **API tokens** - Up to ten per account, from Profile, each expiring in 30 days, 90 days, a year, on a chosen date or never, and scoped to the owner's role, read only, or chosen read or write permissions per area; a token never does more than its owner's role allows
- **Default response** - Replace Caddy's native behavior for unknown hosts or direct-IP requests with a custom status/body/headers, redirect, or connection abort
- **OAuth / SSO** - OAuth2/OIDC authentication with any compliant provider (Authentik, Keycloak, Auth0, etc.), and SAML 2.0 with signed assertions required. Account linking from the Profile page. Optional group-based role mapping (e.g. members of `CPM_Admin` become admins), OIDC-only mode, which disables local accounts entirely, and enforced single sign-on with named break-glass accounts
- **SCIM provisioning** - An identity provider creates, updates and disables accounts and groups through SCIM 2.0, each on its own connection token; deprovisioning ends sessions and revokes API tokens, and provisioned groups carry mapped roles (PostgreSQL only)
- **DNS providers** - DNS-01 challenges for ACME certificates through Cloudflare, Route 53, DigitalOcean, Duck DNS, Hetzner, Vultr, Porkbun, GoDaddy, Namecheap, OVH, IONOS, Linode, Njalla, netcup, Spaceship, deSEC, Dynu, acme-dns, Infomaniak, INWX, ClouDNS, and RFC2136 (BIND/TSIG). Credentials are encrypted at rest, and a certificate can override the provider. DNS propagation delay and timeout are configurable per provider (netcup ships with slow-propagation defaults). Challenge delegation: CNAME `_acme-challenge` to a zone a provider can write, per domain, with a live CNAME check; acme-dns accounts per domain, registered from the UI
- **Caddy build** - Choose which Caddy plugins the image is compiled with. Toggle any supported module (Layer 4, Tailscale, Request Blocker, Coraza WAF, and each DNS provider), add your own Go modules, and rebuild from the UI - or build the image yourself and have the agent only load it. Rate Limit, CrowdSec, HTTP Cache and its storages are opt-in and not in the default image. Settings that depend on a disabled module are greyed out and say which module to turn back on
- **Settings** - ACME email, default response, DNS provider configuration, upstream DNS pinning defaults, Authentik outpost, Prometheus metrics, logging format, HTTP/2 and HTTP/3 switches, response compression - plus everything that used to be in `.env`, stored in the database and editable without a restart. Edits are staged and reviewed against the Caddy config they would produce before one apply sends them all; every apply is a revision that can be diffed against any other and restored. A search finds any setting by name or by what it is for, such as `smtp`, `prometheus` or `redis`
- **Email** - Password reset links from the sign-in page, invitations that let a new user choose their own password, a certificate expiry digest for the administrators, and admin notifications, sent through any SMTP server set under **Settings → Email** with a test message to check it. Links are single-use, carried in the URL fragment so they never reach an access log, and a reset signs every other session out
- **Notifications** - Tells the administrators by email and browser push, a minute's worth at a time, when an agent stays offline, a proxy host keeps answering 502/503/504 (counted from the access log, no ClickHouse needed), Caddy refuses a configuration, an agent's Caddy build, optional service, L4 port change or log files fail, the GeoIP update keeps failing, a CRS plugin is switched off, a release is out, an account is disabled after failed sign-ins, the lock engages on an administrator, or a new administrator appears - and again when each problem is over. A switch per event under **Settings → Email → Notifications** turns it off for everyone; each administrator picks their own events and channels under **Profile → Notifications**
- **Alerts** - Rules on those events, Needs attention items, traffic signals or a per-host ClickHouse threshold (5xx share, requests, mitigated), scoped to hosts or tags, with a quiet period and a silence, sent to email, push, Discord, Slack, Teams (Workflows), ntfy or a webhook signed per the Standard Webhooks scheme. Each channel batches, retries with backoff and honours rate limits, and one that keeps failing is reported through the others; the **Alerts** page keeps every delivery for 90 days. A daily digest - traffic and mitigations, the most attacked hosts, paths and rules, new countries and networks, expiring certificates, configuration changes, backups and open items - goes out at a time and zone of your choice, in each reader's own zone
- **Two-factor sign-in** - TOTP from any authenticator app, with single-use backup codes, for the dashboard and the forward-auth portal alike. A policy can require a second factor (an authenticator app or a passkey) of administrators or of every password account, after a grace period with a banner, with a console command to lift it; resettable by an admin or from the container console
- **Passkeys** - Passwordless sign-in with a fingerprint, face or device PIN on the dashboard and the forward-auth portal, including browser autofill. User verification is required, so a passkey stands in for both factors. Bound to the Public URL's hostname and needs HTTPS (or `localhost`)
- **LDAP / Active Directory** - Directory users sign in on the normal form and the forward-auth portal with their directory password, over LDAPS or StartTLS with the certificate verified. Accounts are created on first sign-in, and directory groups map to roles and CPM groups as OAuth claims do. Configured and tested from Settings
- **Host history** - A revision after every change to a proxy or L4 host, whatever made it. Compare any two, optionally with the rendered Caddy config; roll back through the editor's review, or restore a deleted host. The audit log links each host change to its revision
- **Change approvals** - Hold changes to hosts, access lists, the WAF and settings - all of them, chosen areas, or hosts with chosen tags - until one or two approvers named by role or group agree. Approvers see the change's diff and impact; the last approval applies it as its requester, nobody approves their own, and a change whose target has moved on since it was submitted is marked out of date rather than overwriting it. API tokens wait too (202 with a request id) unless the policy says otherwise. An administrator can bypass approval by giving a reason; the bypass is audited and raises an alert
- **Backup and restore** - The whole configuration in one passphrase-encrypted file, from Settings → Backup or `POST /api/v1/backup`, or on a cron schedule to an S3-compatible bucket or a local folder with retention. Restores onto a new machine with a different `SESSION_SECRET`, from a file or a destination, and saves what it replaces first
- **Portable configuration** - Export hosts, access lists, certificates, groups, WAF rules and settings to a readable JSON file with each secret sealed under a passphrase, and import it into another instance after a dry run that lists what it would create, update or skip. Rows match by name, users by email; a domain another host already serves is reported, never overwritten
- **Global Caddyfile** - Raw Caddyfile, global options and site blocks on their own ports, added to every agent's config. Adapted by each agent's Caddy and checked with `caddy validate` on save; anything that would replace CPM's own config (admin API, storage, certificate automation, ports 80/443) is refused by name
- **Log viewer** - Tail access, WAF, Caddy and certificate logs from any agent, following new lines, with a Logs action on each proxy host. Admin only
- **First-run setup** - Browser flow that creates the first administrator (or configures OAuth), proves the credentials work, and collects the rest of the configuration. No admin password in `.env`
- **In-app migration** - A pre-3.0 SQLite installation is detected, verified against the expected schema, and imported - accounts, hosts, certificates and settings. Secrets encrypted with the old installation's `SESSION_SECRET` are re-encrypted under this deployment's own, so the old key is entered once and never needed again. Ends with a backup of the old file and a paste-ready command to clear the migrated variables out of `.env`
- **SQLite to PostgreSQL** - `cpm-server --copy-to-postgres` copies a SQLite install into an empty PostgreSQL database in one transaction, ids, secrets and the audit chain intact, with a dry run and a row count of every table on both sides
- **Agent fleet** - Any number of Caddy hosts, paired by one-time code, all serving one configuration. An apply that any host refuses fails and names it
- **Update check** - Settings reports when a newer release has been published to the registry this deployment pulls from. It can be switched off; the only other requests the app makes to the internet on its own are the CRS plugin registry check and the GeoIP downloads, each with a switch of its own
- **Audit log** - Searchable configuration change history with user attribution, field-level before and after for each change (secrets masked, unified or side by side), and a keyed HMAC-SHA256 hash chain an administrator can verify to find the first altered, removed or inserted event
- **Audit streaming** - Send the audit log as it is written to syslog over UDP, TCP or TLS, an HTTP receiver (NDJSON, gzip or zstd) or a JSON lines file, in order and at least once, with each event's chain fields so the receiver can check nothing is missing; optionally WAF and other mitigated requests too, redacted and marked as outside the chain
- **Search and pagination** - Server-side search and pagination on all data tables
- **Dark mode** - Dark and light themes, with the system preference detected
- **Internationalization** - Every string in the interface comes from a message catalog rather than the code, so translating the app is adding one JSON file. The language follows the browser's `Accept-Language` (refined by `navigator.languages`) unless one is picked explicitly, and the choice is remembered in a cookie - no `/en/` in front of every URL. English ships today; a language picker appears in the sidebar as soon as a second catalog is present
- **Users and sign-in** - The users list shows each account's source (local, single sign-on or directory), its second factor and its last sign-in time and method, and flags administrators without a second factor. A sign-in overview shows every method and whether it is on, linked accounts, directory health, group-to-role mappings and a preview of the login page. Profile keeps a time zone and number format that follow the account to every browser, and shows each session's approximate place from GeoIP
- **Mobile UI** - Responsive layout for iPhone and other narrow viewports

---

## Configuration

Most configuration lives in the database and is edited on the **Settings** page. `.env` holds what
has to be read before the database can be, plus what Docker Compose itself needs.

### How a setting is resolved

**Stored value → environment variable → default.** Three layers, in that order.

The environment layer is what makes upgrading safe: until a deployment has been through setup or
migration nothing is stored, every setting resolves from the variable it always did, and behaviour
is unchanged. Once a value is stored it wins, and the variable can be deleted from your `.env`.
Each field on the Settings page shows which layer its current value came from.

A stored value that no longer validates - because a range was tightened, say - is ignored with a
warning and falls through to the environment and the default, rather than taking the app down.

### Staging, review and history

Saving a settings form does not reach Caddy. It stages the change, and the header of every settings
screen shows how many changes are pending and in which sections, because one change set spans
them all: DNS edited on one page and geo blocking on another is one apply, not two. The staged set
is yours - another administrator's pending edits are neither shown nor applied with yours.

**Review** lists the staged changes and the diff of the Caddy config they would produce,
rendered from the staged values, with credentials masked. Applying writes them to the database and
reloads Caddy once. Settings that do not touch the Caddy config say so instead of showing a diff.
**Discard** drops the set, or one change at a time from the review sheet. A few forms save straight
away instead, because their real work is not a settings write - a Caddy rebuild, starting
ClickHouse, the favicon, and the instance, sign-in and agent fields that never reach the Caddy
config.

Every apply is a **revision**, recording each committed key's value before and after and who
applied it, whether it succeeded or Caddy refused the config. **Settings → History** lists them
newest first; pick any two to see which settings differ and the Caddy config diff between them,
rendered against today's hosts so only the settings differ between the two sides. **Restore**
stages the values a revision had, on top of anything already pending, and goes through the same
review - history only ever grows. Revisions applied before values were recorded are listed but can
be neither compared nor restored.

#### Getting back in: `SETTINGS_ENV_OVERRIDE`

Two settings can lock you out of the instance that holds them. **OIDC-only mode**
(`AUTH_DISABLE_LOCAL_USERS`) saved on before OAuth works leaves nobody able to sign in, and a
**Public URL** (`BASE_URL`) that no longer matches the registered redirect URI breaks the OAuth
round trip that would let you back in. Neither can be corrected from a Settings page nobody can
reach, and a stored value normally wins - so there would be nothing to do short of editing the
database.

`SETTINGS_ENV_OVERRIDE` names the variables that override a stored value instead of only filling
in for a missing one:

```bash
SETTINGS_ENV_OVERRIDE=AUTH_DISABLE_LOCAL_USERS
AUTH_DISABLE_LOCAL_USERS=false
```

Restart, and the instance resolves that setting from the variable whatever is saved. It takes a
space or comma separated list, so `SETTINGS_ENV_OVERRIDE=BASE_URL,AUTH_DISABLE_LOCAL_USERS`
covers both, and it works for any variable in the table below.

Naming a variable here rather than having those two always prefer the environment is deliberate:
`docker-compose.yml` passes `BASE_URL` and `AUTH_DISABLE_LOCAL_USERS` on every deployment,
defaults included, so "the variable always wins" would mean neither setting could ever be changed
from Settings at all.

While a variable is listed, Settings draws that field greyed out and says so. Remove it from
`SETTINGS_ENV_OVERRIDE` and restart to hand the setting back.

### Stored in the database

Each of these is a field on **Settings** (and on the setup flow's final step). The variable named
is still honoured as an override until a value is stored, and `SETTINGS_ENV_OVERRIDE` above makes
it win even then.

| Setting | Variable | Default |
| ------- | -------- | ------- |
| Application name - sidebar, login card, page-title suffix, the organization of a CA generated here | `APP_NAME` | `Caddy Proxy Manager` |
| Accent colour of the dashboard: `pink`, `purple`, `blue`, `cyan`, `teal`, `green`, `orange` or `red`. Also under **Settings → General → Branding** | `ACCENT_COLOR` | `pink` |
| Public URL. OAuth redirect URIs are built from it, so it must match what the provider has registered | `BASE_URL` | `http://localhost:3000` |
| Caddy admin API, for a deployment running Caddy with **no** agent. With an agent, every admin call is proxied through it and this is unused | `CADDY_API_URL` | `http://caddy-admin:2019` |
| Re-apply this controller's configuration to a Caddy that drifted away from it (restarted onto an old or default config). Under **Settings → Agent**, checked on every pass so it takes effect without a restart. Turn it off on a controller pointed at a Caddy it does not own, or two of them fight over the configuration | `CADDY_MONITOR_ENABLED` | `true` |
| Pinned as `admin.listen` in a config the controller loads with no agent in between, as the agent pins every config it forwards. Must match the `caddy` service's value | `CADDY_ADMIN_LISTEN` | `caddy-admin:2019` in `docker-compose.yml`, else unset (sent as built) |
| Gravatar fallback for user icons. Off keeps every avatar lookup off the network | `AVATAR_GRAVATAR` | `true` |
| Internal forward-auth address Caddy dials. Derived from the container network when empty | `FORWARD_AUTH_INTERNAL_URL` | Derived |
| Seconds before an xcaddy rebuild is abandoned | `CADDY_BUILD_TIMEOUT` | `1800` |
| Allow email/password self-registration | `AUTH_ALLOW_SELF_REGISTRATION` | `false` |
| Let a first-time OAuth identity create an account | `AUTH_ALLOW_OAUTH_REGISTRATION` | `false` |
| Trust the IdP's claims to set a new user's role and status. Off forces `user`/`active` | `AUTH_ALLOW_OAUTH_ROLE_FROM_CLAIMS` | `false` |
| OIDC-only mode: no local accounts, no credential sign-in, no bootstrap admin | `AUTH_DISABLE_LOCAL_USERS` | `false` |
| Build URLs from the request's Host header. Only behind a proxy that rewrites it | `AUTH_TRUST_HOST` | `false` |
| Force a reset for pre-argon2id bcrypt hashes. Leave unset to let the toggle decide | `AUTH_REQUIRE_PASSWORD_CHANGE_ON_LEGACY_HASH` | Unset |
| Rate-limit the auth endpoints | `AUTH_RATE_LIMIT_ENABLED` | `true` |
| Auth rate-limit window, in seconds | `AUTH_RATE_LIMIT_WINDOW` | `60` |
| Auth requests allowed per window | `AUTH_RATE_LIMIT_MAX` | `5` |
| Failed sign-ins before lockout | `LOGIN_MAX_ATTEMPTS` | `5` |
| Window over which failed sign-ins are counted, in ms | `LOGIN_WINDOW_MS` | `300000` |
| How long a blocked client stays blocked, in ms | `LOGIN_BLOCK_MS` | `900000` |
| Lock an account after failed sign-ins, whatever address they come from | `ACCOUNT_LOCK_ENABLED` | `true` |
| Failed sign-ins before an account is locked | `ACCOUNT_LOCK_FREE_FAILURES` | `5` |
| First account lock, in ms. Each further failure doubles it | `ACCOUNT_LOCK_BASE_DELAY_MS` | `1000` |
| Longest account lock, in ms | `ACCOUNT_LOCK_MAX_DELAY_MS` | `900000` |
| Disable an account after repeated failed sign-ins, until an administrator enables it. Anyone who knows a username can then disable that account | `ACCOUNT_LOCK_DISABLE_ENABLED` | `false` |
| Failed sign-ins before an account is disabled | `ACCOUNT_LOCK_DISABLE_AFTER` | `10` |
| A closed access review holds its revocations until an administrator confirms them | `ACCESS_REVIEW_CONFIRM_REVOCATIONS` | `false` |
| Days before an access review is due that its undecided items are reported | `ACCESS_REVIEW_REMINDER_DAYS` | `3` |
| Non-default ports CPM forward-auth sites are served on, comma-separated. A sign-in on any other port is refused | `FORWARD_AUTH_ALLOWED_PORTS` | None |
| Send `X-CPM-User-Id` as the sequential account number rather than a UUID. On for installs upgraded from before the UUID | `FORWARD_AUTH_SEQUENTIAL_USER_IDS` | `false` |
| Check the registry for a newer release | `UPDATE_CHECK_ENABLED` | `true` |
| Image namespace the update check reads tags from, without the image name. Change it for a fork | `UPDATE_IMAGE_REPOSITORY` | `ghcr.io/caddyproxymanager` |
| Offline mode: stop every call to the internet this app makes on its own, and keep agents from building Caddy | `OFFLINE_MODE` | `false` |
| Revisions each host keeps at least, however old | `HOST_HISTORY_KEEP_REVISIONS` | `100` |
| Days of host history kept, however many revisions that is | `HOST_HISTORY_KEEP_DAYS` | `365` |
| Days of audit events kept; `0` keeps them forever | `AUDIT_LOG_KEEP_DAYS` | `0` |
| Collect traffic and WAF events. If left unset, analytics is on only when a password is set | `ANALYTICS_ENABLED` | Unset |
| ClickHouse endpoint | `CLICKHOUSE_URL` | `http://clickhouse:8123` |
| ClickHouse user | `CLICKHOUSE_USER` | `cpm` |
| ClickHouse password. Required for analytics - the container will not start without one. Encrypted at rest | `CLICKHOUSE_PASSWORD` | None |
| ClickHouse database | `CLICKHOUSE_DB` | `analytics` |
| Days of analytics kept. Lowering it migrates the tables' TTL on the next start | `CLICKHOUSE_RETENTION_DAYS` | `30` |
| Use GeoIP for country lookups and geo blocking. If left unset, GeoIP is on only when the databases are present | `GEOIP_ENABLED` | Unset |
| MaxMind account ID, for GeoLite2 downloads | `GEOIPUPDATE_ACCOUNT_ID` | None |
| MaxMind license key. Encrypted at rest | `GEOIPUPDATE_LICENSE_KEY` | None |
| Hours between checks for newer MaxMind databases, 1-168 | `GEOIP_UPDATE_INTERVAL_HOURS` | `24` |
| Send email. If left unset, email is on whenever an SMTP server is named | `SMTP_ENABLED` | Unset |
| SMTP server host name or address | `SMTP_HOST` | None |
| SMTP port | `SMTP_PORT` | `587` |
| SMTP encryption: `starttls`, `tls` (implicit) or `none` | `SMTP_SECURITY` | `starttls` |
| SMTP username. Empty for a relay that needs no sign-in | `SMTP_USERNAME` | None |
| SMTP password. Encrypted at rest | `SMTP_PASSWORD` | None |
| Sender address; the application name is the sender's name | `SMTP_FROM` | None |
| Comma-separated recipients of certificate alerts (empty: every active administrator), and extra recipients of every notification | `EMAIL_ALERT_RECIPIENTS` | None |
| Email once a certificate has fewer days than this left, 0-90. `0` turns alerts off | `CERTIFICATE_EXPIRY_ALERT_DAYS` | `14` |
| Notify: An account disabled after failed sign-ins, or the last administrator kept enabled | `NOTIFY_ACCOUNT_DISABLED` | `true` |
| Notify: Failed sign-ins locking an administrator's account | `NOTIFY_ADMIN_LOCKED` | `true` |
| Notify: An administrator account created, or a user made an administrator | `NOTIFY_ADMIN_ADDED` | `true` |
| Notify: An agent disconnected for longer than `NOTIFY_AGENT_OFFLINE_MINUTES`, and back online | `NOTIFY_AGENT_OFFLINE` | `true` |
| Notify: Minutes an agent may be disconnected before anyone is told, 1-1440 | `NOTIFY_AGENT_OFFLINE_MINUTES` | `5` |
| Notify: A proxy host answering 502, 503 or 504 `NOTIFY_UPSTREAM_ERROR_COUNT` times within `NOTIFY_UPSTREAM_ERROR_MINUTES`, and recovered. Needs access logging | `NOTIFY_UPSTREAM_ERRORS` | `true` |
| Notify: Upstream error responses from one host before a notification | `NOTIFY_UPSTREAM_ERROR_COUNT` | `10` |
| Notify: The window they are counted in, and the quiet time before a host counts as recovered, 1-1440 | `NOTIFY_UPSTREAM_ERROR_MINUTES` | `5` |
| Notify: Caddy refusing a configuration, and loading one again | `NOTIFY_CADDY_APPLY` | `true` |
| Notify: An agent reporting a failed Caddy build, optional service or L4 port change, or log files it cannot read or prune | `NOTIFY_AGENT_PROBLEMS` | `true` |
| Notify: The GeoIP update failing three times in a row, and working again | `NOTIFY_GEOIP_FAILED` | `true` |
| Notify: A CRS plugin switched off because Caddy refused it | `NOTIFY_CRS_PLUGIN_DISABLED` | `true` |
| Notify: A new release, once each, while the update check is on | `NOTIFY_UPDATE_AVAILABLE` | `true` |
| Notify: A scheduled backup failing, and its recovery | `NOTIFY_BACKUP_FAILED` | `true` |
| Notify: Audit streaming failing or falling behind, and its recovery | `NOTIFY_AUDIT_SINK_FAILED` | `true` |
| Notify: An access review nearing or past its due date with items undecided, or waiting for confirmation | `NOTIFY_ACCESS_REVIEWS` | `true` |
| Notify: An administrator applying a change request without its approvals | `NOTIFY_CHANGE_APPROVALS` | `true` |
| Notify: An alert channel failing, reported through the other channels, and its recovery | `NOTIFY_CHANNEL_FAILING` | `true` |
| Email the owner of an account, once, when it is disabled. A disabled account gets nothing else | `NOTIFY_DISABLED_ACCOUNT_OWNER` | `false` |

> Compose reads `CLICKHOUSE_PASSWORD` too, to provision the `clickhouse` container. **With an agent
> running the stack you do not need to keep it in `.env`**: the agent starts ClickHouse itself and
> passes the saved value to Compose. Without an agent, Docker is the only thing that can start it
> and it cannot read the database - so there it must stay in `.env`. The MaxMind credentials are
> read by the controller alone, and can go from `.env` once saved.

### Stays in `.env`

| Variable | Description | Default | Required |
| -------- | ----------- | ------- | -------- |
| `SESSION_SECRET` | Session key, and the HKDF root every stored secret is encrypted with. 32+ chars (`openssl rand -base64 32`). It cannot live inside what it encrypts. To rotate it, see `SESSION_SECRET_PREVIOUS` | None | **Yes** |
| `SESSION_SECRET_PREVIOUS` | The secret(s) `SESSION_SECRET` replaced, comma-separated. Only ever decrypts: each start re-encrypts what still needs it under `SESSION_SECRET`, two-factor secrets included, so one restart with it set completes a rotation and it can then be removed. OAuth sign-in tokens no key opens are dropped; the next sign-in stores new ones. Sessions end with the rotation either way | Unset | No |
| `POSTGRES_PASSWORD` | Password for the database. Provisions the bundled `postgres` service and is what the app authenticates with. Any characters; it is never put through a URL | None | **Yes** |
| `POSTGRES_USER` / `POSTGRES_DB` | Role and database the bundled `postgres` service creates, and what the app connects as | `cpm` / `cpm` | No |
| `POSTGRES_HOST` / `POSTGRES_PORT` | Where the app looks for PostgreSQL. Set these to use a server other than the bundled one | `postgres` / `5432` | No |
| `POSTGRES_SSL` | Whether the app connects with TLS. On/off only - anything finer wants `DATABASE_URL` | `false` | No |
| `DATABASE_URL` | A full connection string, which overrides every `POSTGRES_*` above. Only needed for what the fields cannot express, or to use SQLite (`file:/app/data/cpm.db`). A password in it must be percent-encoded. See [The database](#the-database) | Unset | No |
| `DATABASE_POOL_MAX` | Connections the pool may open - it sizes what reads the database, so it cannot be read from it. Requests beyond it queue. Keep the server's own `max_connections` above the total across every instance | `10` | No |
| `NODE_ENV` | Read at module load, before any query. `production` enforces the password policy | `production` in the image | No |
| `HOST` / `PORT` | The socket binds before anything can be read. `::` is dual-stack and accepts IPv4 too; `0.0.0.0` binds IPv4 only | `::` / `3000` | No |
| `CPM_APP_ROOT` / `CPM_HEALTHCHECK_URL` | Bootstrap paths for the `cpm-server` binary, used before the app starts | Executable's directory / `http://127.0.0.1:${PORT}/api/health` | No |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seeds an administrator at startup, as releases before 3.0 did. **Not required** - [First run](#first-run) creates the first account instead. Setting both skips the setup flow entirely. Applied again only when either value changes, which also ends the admin's sessions and re-enables it; a password changed in the UI survives restarts | None | No |
| `OAUTH_*` | An OAuth provider configured by environment. Synced into the `oauth_providers` table at startup rather than into the settings registry, so there is one source of truth per provider. See [OAuth authentication](#oauth-authentication) | None | No |
| `CERTS_DIRECTORY` | Where generated certificates are written | `./data/certs` | No |
| `ACME_CA_ROOT_DIR` | Directory holding a custom ACME CA root. For non-Docker deployments | `/acme-ca` | No |
| `L4_PORTS_DIR` | Directory where the controller leaves the bootstrap token the agent in its own stack pairs with, and the copy of the configuration a restore replaces (under `backups/`). For non-Docker deployments | `/app/data` | No |
| `LEGACY_KEY_CUTOFF_DATE` | Cutoff after which secrets still encrypted with the legacy key are refused, forcing re-encryption. ISO 8601 date, or `never` | Built-in date | No |
| `LEGACY_SQLITE_PATH` | Pins which pre-3.0 database the migration flow offers, instead of scanning the usual locations | Unset (scan) | No |
| `COMPOSE_PROFILES` | Compose profiles to activate: `clickhouse`. Only needed without an agent - with one, **Settings → Observability → Analytics** starts and stops ClickHouse regardless of this. `.env.example` ships it empty, since the bundled compose file runs an agent | Empty | No |
| `PUID` / `PGID` | Build args setting the UID/GID containers run as. Match your host user to avoid volume permission issues (`id -u` / `id -g`) | `10001`/`10001` (web)<br/>`10000`/`10000` (caddy) | No |
| `AGENT_PUID` / `AGENT_PGID` | Build args setting the UID/GID the agent runs as | `10002`/`10002` | No |
| `CADDY_GID` | Caddy's GID, added to the web and agent containers' supplementary groups so they can use Caddy's logs. Must match Caddy's `PGID` | `10000` | No |
| `CONTROLLER_GID` | The controller's GID, added to the agent's supplementary groups so it can read the bootstrap token. Must match web's `PGID` | `10001` | No |
| `DEMO_MODE` | Run with no Caddy at all: admin calls go to an in-memory Caddy, a simulated agent reports builds, ports and services as done, and real agents are refused pairing and connection. No certificate is ordered and no DNS provider is called. Environment-only so a demo's visitors cannot turn it off | `false` | No |
| `CADDY_IMAGE` | The image the `caddy` service runs. Set it to an image you built with the agent in external mode (`CADDY_BUILD_MODE`) - never the shipped name, or loading it would pull the registry's copy over yours. Forwarded to the agent, which runs Compose | `ghcr.io/caddyproxymanager/caddy:latest` | No |
| `DASHBOARD_DOMAIN` | Domain this dashboard is served on. The bundled Caddyfile answers on it until CPM applies its own config, and setup uses it to switch on the managed host that reverse-proxies the dashboard - see [Proxying the dashboard itself](#proxying-the-dashboard-itself). Falls back to the hostname in `BASE_URL` | Unset | No |

### The agent's environment

The agent has no database to read configuration from until it has one, and none of this is
changeable at runtime - it describes the host the agent is bolted to. So it stays environment-only.

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `CONTROLLER_URL` | Where the agent dials to reach its controller. A tailnet IP or MagicDNS name works here like any other address. A bare host means `https://`, except loopback and single-label names such as `web`. Overridden by `--host`/`--port` | Unset (idle until paired) |
| `CONTROLLER_ALLOW_INSECURE_HTTP` | Dial a plain `http://` controller address that is not private anyway. Without it the agent refuses one, because pairing sends the shared secret over that link. `http://` to loopback, a compose service name, an RFC 1918 range or a tailnet is allowed and only logs a warning | `false` |
| `PAIRING_CODE` | Pair on first start instead of idling. Overridden by `--code` | Unset |
| `AGENT_MODE` | `standalone` or `managed`, shown on the controller's agent status. A label only: either way the agent dials out and binds just its local control socket. Startup fails on any other value | `standalone` |
| `AGENT_SOCKET` | The local control socket `cpm-agent --pair` and `--healthcheck` dial | `$DATA_DIR/agent.sock` |
| `DATA_DIR` | Where the agent's SQLite state, control socket and GeoIP databases live. Must be writable | `/data` |
| `CONTROLLER_DATA_DIR` | The controller's data volume, mounted read-only: where the bootstrap token is read from, and where an upgraded agent copies its old state from on first start | Unset (token read from `DATA_DIR`) |
| `COMPOSE_DIR` | Where the compose project files are mounted, read-only. The agent never reads `.env` from it: what Compose interpolates into the services it runs comes from the agent's own environment | `/compose` |
| `CADDY_API_URL` | Where this host's Caddy admin API listens. The controller reaches it only through here | `http://caddy-admin:2019` in `docker-compose.yml`, else `http://caddy:2019` |
| `CADDY_ADMIN_LISTEN` | Pinned as `admin.listen` in every config the agent forwards to Caddy, replacing the controller's bind-every-interface default. `docker-compose.yml` sets `caddy-admin:2019` here and on the `caddy` service, whose Caddyfile binds the same address until the first config arrives - a name only the internal `caddy-admin` network resolves | Unset (forwarded as sent) |
| `CADDY_CONTAINER_NAME` | The container the agent recreates | `caddy-proxy-manager-caddy` |
| `CADDY_BUILD_TIMEOUT` | Seconds before a Caddy rebuild is abandoned | `1800` |
| `CADDY_BUILD_MODE` | `agent` builds Caddy's image when the module selection changes. `external` never builds: you build the image and **Settings → Caddy build** loads it, so the socket proxy's `GRPC` and `SESSION` can be `0`. See [Building the Caddy image yourself](#building-the-caddy-image-yourself). Startup fails on any other value | `agent` |
| `CADDY_HEALTH_TIMEOUT` | Seconds to wait for Caddy to report healthy after a recreate | `60` |
| `CERT_FILES_HOST_DIR` | A directory on the agent's host, as the Docker daemon sees it, that certificates may be read from (**Certificates → Import → From a file on an agent**). Read-only, in a throwaway container that mounts only this directory; the controller can name paths inside it and nothing else. Keys travel to the controller and are stored encrypted, like a pasted key. Startup fails on a relative path or one with a comma | Unset (off) |
| `SERVICE_START_TIMEOUT` | Seconds before starting an optional service (`clickhouse`, `crowdsec`) is abandoned. Generous because the first start pulls the image | `900` |
| `DOCKER_HOST` | The Docker API. Points at `docker-socket-proxy`, never the raw socket | `tcp://docker-socket-proxy:2375` |
| `COMPOSE_PROJECT_NAME` / `COMPOSE_HOST_DIR` / `COMPOSE_EXTRA_FILE` / `COMPOSE_SKIP_OVERRIDE` | Compose overrides: an explicit project name, a `--project-directory` for a host path the agent cannot see, an extra `-f` file, and skipping `docker-compose.override.yml`. The last two exist for the test rigs. `COMPOSE_HOST_DIR` is only needed where the project directory cannot be worked out from the compose labels - a UNC path, or a Docker Desktop old enough to expose drives at `/host_mnt/<letter>`; the agent logs a warning naming it when that happens | Auto-detected |
| `CADDY_ACCESS_LOG` / `WAF_AUDIT_LOG` / `WAF_RULES_LOG` | Where the agent reads Caddy's logs from | `/logs/...` |
| `GEOIP_DIR` / `GEOIP_DB` | Where the agent keeps the GeoLite2 databases it fetches, and the one its parsers read | `$DATA_DIR/geoip` / `$GEOIP_DIR/GeoLite2-Country.mmdb` |
| `NODE_EXTRA_CA_CERTS` | A CA bundle to trust in addition to the system store, for a controller behind TLS from a private CA. See [Connecting agents over Tailscale or Headscale](#connecting-agents-over-tailscale-or-headscale) | Unset |

**Production requirements:**

- `SESSION_SECRET`: 32+ characters (`openssl rand -base64 32`)
- Any password you set, whether through setup or `ADMIN_PASSWORD`: 12+ chars with uppercase,
  lowercase, numbers, and special characters - not required when OIDC-only mode is on

There is no development default. Setting neither variable is not an error in any environment:
the deployment runs [First run](#first-run) instead of seeding an account.
The password policy above - including the refusal of `admin` itself - is enforced only when
`NODE_ENV=production`, so a development instance may set whatever it likes.

---

## The API

`/api/graphql` serves every resource: proxy hosts, L4 hosts, certificates, access lists, users,
groups, agents, settings, the audit log, and a Caddy apply.

```bash
curl -sX POST https://cpm.example.com/api/graphql   -H "Authorization: Bearer $CPM_TOKEN"   -H 'content-type: application/json'   -d '{"query":"{ proxyHosts { id name domains enabled } }"}'
```

Tokens are created from **Profile → API tokens** in an authenticated dashboard session - an
existing bearer token cannot mint replacement credentials, so a leaked one cannot extend its own
life. An account holds at most ten, each expiring in 30 days, 90 days, a year, on a chosen date or
never, and each with a scope that narrows its owner's role: **same as my role** (`full`, what every
earlier token has), **read only** (`read`: no mutation, the config export and import, the audit
check and the host previews included), or **chosen permissions** (`custom`: `area:read` or
`area:write` for `overview`, `hosts`, `accessLists`, `certificates`, `security`, `analytics`,
`agents`, `users`, `settings`, `audit` and `tokens`). What a request gets is the role and the scope
together; a field or route added later is closed to a narrowed token until it is given an area.
`createApiToken` and `POST /api/v1/tokens` take `scope` and `permissions`.

### What is a field and what is JSON

Stable, queryable things are fields: ids, names, domains, timestamps, foreign keys. Configuration
the model layer owns - load balancing, WAF and geoblock overrides, location rules, mTLS - travels
as a `JSON` scalar, reachable through `config` on a host and passed back as `input` on a mutation.

That split is deliberate. Those settings change with the product and are validated by functions that
already exist; restating them in SDL would be thousands of lines that can drift out of step with
the validator while looking authoritative. It also means a GraphQL mutation and the REST route
beside it hand identical input to identical validation, which is what makes them interchangeable.

### Changing many hosts

`bulkProxyHosts` and `bulkL4ProxyHosts` take `{ action, ids }` (up to 500) and return how many hosts
changed; the REST equivalents are `POST /api/v1/proxy-hosts/bulk` and
`POST /api/v1/l4-proxy-hosts/bulk`. A batch is all or nothing, each host is audited on its own, and
Caddy is applied once (not at all for `addTag`, which takes a `tag`).

`proxyHostUpstreamHealth(id)` reads each upstream's live state from Caddy on every agent serving
the host: healthy, failing (with the failure count and whether it is out of rotation), unchecked,
unreported, or unknown for an agent that did not answer.

`attention(proxyHostId)` is the overview's Needs attention list (one host's items with the
argument), each item with an English `title` and `detail` plus the `code` and `values` to render
it in another language. `proxyHostTraffic(id)` is a host's last 24 hours, null with analytics off.
`setupChecklist` and the `setSetupStepDone` and `setSetupChecklistHidden` mutations drive the
setup checklist.

### Roles

A token carries its owner's role, built-in or custom: each field needs a permission the role holds
outright, so an operator's grants, which delegate the dashboard rather than the API, give its
token nothing. `apiTokens` is the exception: every signed-in role manages its own. `roles`,
`createRole`, `updateRole`, `deleteRole` and `setGroupRole` manage custom roles.

### REST is still there

`/api/v1/` keeps working and is still documented at `/api-docs`. It is deprecated rather than
removed: nothing in the field breaks, and both APIs call the same model functions, so they cannot
disagree about what a write does. New integrations should use GraphQL.

Backup is the exception: `POST /api/v1/backup` takes a passphrase and returns the encrypted file,
for scripts and cron. Scheduled backups (destinations, schedules, runs) are managed over GraphQL.
Restoring stays in **Settings → Backup**.
The portable configuration is GraphQL only: `exportConfig`, `previewConfigImport` and
`applyConfigImport` carry the file as base64, and `verifyAuditChain` checks the audit log.

---

## The database

PostgreSQL by default, or SQLite (see [SQLite](#sqlite) below). `docker compose up -d` starts a
`postgres` service alongside the app and hands it the `POSTGRES_*` values, so a default install
needs nothing but a password:

```bash
POSTGRES_PASSWORD=$(openssl rand -base64 32)
```

Those reach the app as discrete fields rather than folded into a connection string, and that is
deliberate: a password only has to be escaped when it goes into a URL, and Compose interpolates
without escaping anything. `openssl rand -base64 32` emits a `/` about half the time, and a `/` in
a URL's password ends the authority early - `postgres://cpm:pa/ss@postgres:5432/cpm` names the host
`cpm:pa` - so the app would fail to reach a server nobody had configured. As fields there is no
delimiter to collide with, and any password works as typed.

To use a server you already run, point the same fields at it:

```bash
POSTGRES_HOST=db.internal POSTGRES_USER=cpm POSTGRES_PASSWORD=secret POSTGRES_DB=cpm   docker compose up -d
```

`POSTGRES_PORT` (5432) and `POSTGRES_SSL` (off) are there too. `DATABASE_URL` still overrides all
of them, for a server needing something the fields cannot express - an `sslmode` beyond on/off, a
`search_path`, a libpq connection option:

```bash
DATABASE_URL=postgres://cpm:secret@db.internal:5432/cpm?sslmode=verify-full docker compose up -d
```

A password inside that URL has to be percent-encoded (`/` is `%2F`, `@` is `%40`), which is the
problem the fields exist to avoid.

The database must already exist; the app creates its own tables but not the database itself.
Migrations run on boot.

MySQL, MariaDB and the rest are rejected by name at startup rather than half-working: Bun can talk
to some of them, but Drizzle's Bun driver only builds PostgreSQL, and several write paths here
depend on `RETURNING`.

### SQLite

Point `DATABASE_URL` at a file and the app uses SQLite instead, with no database server at all:

```bash
DATABASE_URL=file:/app/data/cpm.db
```

`/app/data` is the controller's own volume, so the file persists with everything else. A bare path
and `sqlite:` work too. The file is created and migrated on boot, so a demo that should reset only
has to delete it (with its `-wal` and `-shm` siblings) before starting.

It is meant for legacy installs and demos, and an instance on it that is not in demo mode says so:
on every setup step, and in a banner across the dashboard that can be dismissed for a week at a
time. PostgreSQL stays the default because it is
what the bundled stack runs and what a busy instance wants: SQLite serializes writes, and the file
has to be backed up while nothing is writing to it (or with `sqlite3 cpm.db ".backup copy.db"`).
The bundled `docker-compose.yml` still requires `POSTGRES_PASSWORD` and starts the `postgres`
service; with `DATABASE_URL` set to a file the app never connects to it.

For a demo, `bun run demo` does all of it with no containers: `DEMO_MODE` on, a SQLite file under
`apps/controller/data/demo/`, seeded with sample hosts and people on first start, signed in as
`admin` / `admin` (`ADMIN_USERNAME`/`ADMIN_PASSWORD` override it). In demo mode that account cannot
be disabled, deleted, demoted or given a new password, so one visitor cannot lock out the next, and
the password policy does not apply to it. Analytics are on: with no ClickHouse the demo keeps its
traffic in `analytics.db` beside the database, seeded with a month of invented requests and WAF hits,
and adds more every minute while it runs. `--reset` starts over,
`--reset-every <hours>` does so on a timer for a public demo, `--prod` serves a production build
and `--port` moves it off 3020.

A pre-3.0 database is not opened in place, even though it is also SQLite - see
[Upgrading from a pre-3.0 install](#upgrading-from-a-pre-30-install-which-used-sqlite).

### Moving from SQLite to PostgreSQL

`cpm-server --copy-to-postgres` copies a current SQLite install into an empty PostgreSQL database:
every row with its id, secrets still sealed under the same `SESSION_SECRET`, the audit hash chain
verbatim, and each sequence moved past the copied ids. It runs in one transaction, then counts every
table on both sides and exits 1 if any differ.

```bash
docker compose stop web
docker compose up -d --wait postgres          # POSTGRES_PASSWORD set in .env
docker compose run --rm --entrypoint /app/cpm-server web --copy-to-postgres --dry-run
docker compose run --rm --entrypoint /app/cpm-server web --copy-to-postgres
# then remove DATABASE_URL from .env and start web again
```

The source defaults to `DATABASE_URL` and the target to the `POSTGRES_*` values; `--from` and `--to`
name them instead. `--dry-run` writes nothing. A source this version has not finished migrating is
refused (start the new release on it once first), and so is a target that already holds rows,
unless `--allow-non-empty` skips the rows whose key is taken. In a checkout it is
`bun scripts/sqlite-to-postgres.ts` in `apps/controller`.

### Upgrading from PostgreSQL 17

The bundled `postgres` service moved from 17 to 18 during the 3.0 release candidates. A major version cannot read
another's data files, so if your `docker-compose.yml` still says `image: postgres:17-alpine`, this
upgrade is a dump and restore. Getting the order wrong loses nothing: 18 refuses to start on a
volume holding a 17 cluster, and the data stays put. If you already updated the compose file, put
back `image: postgres:17-alpine` and the volume mount at `/var/lib/postgresql/data` for step 1.

```bash
# 1. On the old compose file: stop the app, dump the database from the 17 server
docker compose stop web
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --file=/tmp/cpm.dump'
docker compose cp postgres:/tmp/cpm.dump ./cpm.dump

# 2. Unpack the new release's archive over the old files, then drop the containers and the 17 volume only
docker compose down
docker volume rm caddy-proxy-manager_postgres-data   # <project>_postgres-data - see `docker volume ls`

# 3. Start 18, restore, bring everything back
docker compose up -d --wait postgres
docker compose cp ./cpm.dump postgres:/tmp/cpm.dump
docker compose exec postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error /tmp/cpm.dump && rm /tmp/cpm.dump'
docker compose up -d
```

The dump is copied out with `docker compose cp` rather than redirected, so it survives any shell -
PowerShell's `>` re-encodes it. Keep `cpm.dump` until you have signed in again. A server you run
yourself through `POSTGRES_HOST` is unaffected; the app works with 17 and 18 alike.

### Upgrading from a pre-3.0 install, which used SQLite

Leave the old `.env` alone and stand up PostgreSQL first, then point `DATABASE_URL` at it - or at
a new SQLite file (`file:/app/data/cpm.db`) to stay on SQLite. On the next start the app finds the old SQLite file, checks it against the schema it expects, and offers
to migrate it. If several candidate files are found, it asks which one; `LEGACY_SQLITE_PATH` pins
one instead of scanning.

The offer comes **before** account creation - an operator with an old database wants its accounts,
not a new one alongside them. By default it copies everything: proxy hosts, certificates, access
lists, users and their credentials, groups, tokens, agents, the audit log, and the settings blobs.
You then sign in with an account it just imported, using the password you already had, which is
what proves the credential rows arrived intact.

Each of those is a checkbox, so an installation changing hands can take the configuration and leave
the people behind. Two rules keep a partial choice honest:

- A proxy host references a certificate and an access list, and both references are nullable - so
  importing hosts without them would succeed and quietly publish a host that used to sit behind a
  password. Those groups come along with proxy hosts, shown ticked and locked.
- Everything else is resolved from the foreign keys rather than a list. A reference into a group
  you left behind is emptied when the column allows it (`createdBy`, `ownerUserId` - provenance
  nothing authorises against) and the row is dropped when it does not (an API token cannot exist
  without its user).

Leaving the users out means nothing can sign in yet, so the flow continues to account creation
instead of the login page - the same screen a fresh install sees, offering a first administrator or
an identity provider, and saying that your data arrived without its accounts.

### If the old installation used a different SESSION_SECRET

Certificate private keys, DNS provider credentials, OAuth client secrets, agent secrets and the
Tailscale auth key are stored encrypted, with `SESSION_SECRET` as the root key. A new deployment
generates its own, so the old database's secrets are usually unreadable by it. The mTLS CA's
private keys, which a pre-3.0 database holds in plain text, are encrypted as they are copied.

The migration screen notices and asks for the old value. Enter it, and every encrypted value is
decrypted with it and re-encrypted under the secret this deployment already uses, as the rows are
copied. The old secret is used for that one import and nothing stores it - you do not have to keep
it, and you do not have to change `SESSION_SECRET` to match the old installation.

The key is checked before anything is written, and the whole database is converted in memory before
the first row is inserted. A missing or mistyped key is a refusal with nothing written, not a
half-finished import. A value encrypted with the current secret already is copied across untouched,
so an upgrade that kept its `SESSION_SECRET` never sees this step.

Migrating without the key is not offered: the ciphertext would arrive intact and unreadable, and
every affected credential would have to be entered again by hand.

Your existing environment is read too - whatever your `.env` or your Compose file puts there.
Anything in it that is now a database setting is carried into the [settings step](#first-run)
pre-filled and marked as having come from the environment, so you can see what is being taken over
before agreeing to it.

Setup finishes on a summary rather than the dashboard, because a deployment that has just replaced
its database is owed three things first: a download of the old SQLite file, the path it was read
from, and the variables that have moved into the database. The old database file is read, never
moved or deleted - take the backup before you clean anything up.

Those variables come with a `sed` you can paste, which comments them out of the `.env` beside your
`docker-compose.yml` and leaves a `.env.bak` next to it. The command is generated rather than the
file rewritten, because the app cannot see that file: its environment arrives from Compose, and on
another deployment it might arrive from Swarm or Kubernetes secrets or a systemd unit instead.
It comments rather than deletes, so you keep the values - some of them are the only copy of a secret
you have. Cleaning up is optional either way: a variable that is still set is ignored once a value
is stored.

The variables Compose itself reads for ClickHouse are held back from that command and listed
separately, because removing them is a two-step change the command cannot make on its own. Without
an agent they stay: Docker is the only thing that can start ClickHouse, and it cannot read the
database. With an agent they can go too, as long as you drop `clickhouse` from `COMPOSE_PROFILES` in
the same pass - see [Pick one owner](#enabling-and-disabling-analytics).

Starting with `DATABASE_URL` still pointed at the old file fails immediately, with a message saying
so. Today's SQLite schema has its own migration history, and running it over the old file would
leave the app on a schema it does not know.

### More than one controller

Several controllers can share one PostgreSQL database behind a load balancer, so the dashboard,
the API and the agents keep working when one goes down. Each needs the same `SESSION_SECRET`, and
Caddy is reached through agents. Any controller answers any request: sessions, sign-in limits and
settings are shared through the database, an agent connected to one is reached through it by the
others, and one at a time runs the background jobs. SQLite runs one controller only, and a second
on the same file refuses to start; a controller with others running never configures Caddy
without an agent. The
[high availability guide](https://caddyproxy.com/features/high-availability/) has an example with
HAProxy.

### Working on the schema

`apps/controller/src/lib/db/schema.pg.ts` is the source of truth, hand-edited.
`schema.sqlite.ts` is generated from it, and each backend keeps its own migrations. After changing
it:

```bash
bun scripts/generate-sqlite-schema.ts                   # rewrites schema.sqlite.ts
DATABASE_URL=postgres://... bun run db:generate         # emits drizzle/postgres/
DATABASE_URL=file:./data/cpm.db bun run db:generate     # emits drizzle/sqlite/
```

`tests/unit/db/db-schema-parity.test.ts` fails if either of the last two steps was skipped.

`apps/controller/drizzle/legacy-sqlite/` holds the migrations every pre-3.0 deployment ran. Nothing
generates into it; it stays so the migration flow's tests can build a realistic old database.

### Running the tests

`bun run test` starts a throwaway PostgreSQL container, runs the suite against it, and removes it.
Docker is the only prerequisite. Each test gets its own schema, so nothing leaks between them.

To use a server of your own instead, set `TEST_POSTGRES_URL` - the suite will use it and start no
container. Anything in it may be dropped, so do not point it at something you care about.

```bash
TEST_POSTGRES_URL=postgres://cpm:pw@127.0.0.1:5432/cpm_test bun run test
```

`bun run test:sqlite` runs the same suite against SQLite, an in-memory database per test, with no
container.

---

## Backup and restore

**Settings → Backup** downloads the whole configuration as one `.cpmbak` file: hosts, certificates
and their keys, access lists, users, groups, API tokens and every setting, optionally with the audit
log and settings history. Scripts get the same file from `POST /api/v1/backup` with an admin token.
Sessions and sign-in state are never included, nor are the certificates Caddy obtained (they are
issued again), analytics or the GeoIP databases.

Every secret the database encrypts is decrypted into the file, and the file is encrypted with a
passphrase of at least 12 characters (scrypt, AES-256-GCM). That is what lets it restore onto a
machine with a different `SESSION_SECRET`, and why the passphrase is the only thing protecting it -
a lost passphrase cannot be recovered.

Restoring replaces every account, so it needs a sign-in from the last ten minutes. It reads and
converts the whole file before writing anything, saves the current configuration first to
`/app/data/backups/` on `caddy-manager-data` under the same passphrase, replaces the tables in one
transaction, and signs everyone out. A backup from an older release restores onto a newer one; one
from a newer release is refused. Turn off **Keep the agent pairings** when moving to a new machine:
its agents then pair afresh.

### Scheduled backups

Destinations are S3-compatible buckets (Amazon S3, Cloudflare R2, Backblaze B2, MinIO...) or a
folder under `backups/` on the data volume; schedules are cron expressions in a time zone of your
choice, with "keep the last N" and "keep N days" retention. The schedule's passphrase is stored
encrypted with `SESSION_SECRET` so runs need nobody present. One controller runs them; a run
missed while no controller was up happens once at the next start. Failures show under Needs
attention and are emailed. A backup kept at a destination restores from the same page. Backups are
zstd-compressed before they are sealed; older files still restore.

### Portable configuration

Below the backup, **Export configuration** writes a JSON file instead: proxy and L4 hosts (with
their agent pins, mTLS rules and sign-in grants), access lists, certificates (imported ones with
their keys), CAs, client certificates and mTLS roles, groups with their members and grants, WAF
presets, CRS plugins, WAF exclusions, blocked sources and settings, by section. It leaves out
users, API tokens, sessions, agents, the audit log, saved analytics views and the dashboard host.
The file stays readable; each secret in it is sealed on its own under the passphrase, with the
backup's scrypt and AES-256-GCM.

**Import configuration** merges rather than replaces. Rows match by name (users by email, agents
by name), ids are remapped, including the ones inside host settings, and the dry run lists what
would be created, updated or skipped before anything is written. A host whose domain another host
here already serves is skipped and named, as is anything pointing at a user, agent or list this
instance lacks rather than losing that reference. Files are limited to 50 MiB; admin only, and
both directions are audited.

---

## Security

- Production enforces strong passwords (12+ chars, mixed case, numbers, special characters)
- 32+ character session secrets required
- Two independent throttles on the auth endpoints: Better Auth's request limit (5 per 60 seconds)
  and a per-address lockout (5 failed sign-ins per 5 minutes, then blocked for 15). Both are Settings
  fields
- A per-account lock on top, whatever address the guesses come from: past five failures each one
  doubles the wait, from 1 second up to 15 minutes. All three, or the lock itself, are Settings
  fields. A locked account gets a 429 with code `ACCOUNT_LOCKED` (it
  was `TOO_MANY_REQUESTS`), `retryAfter` seconds in the body and a `Retry-After` header; the login
  page and the forward-auth portal say how long. The per-address limit keeps its generic message
- Optionally, an account disabled outright after 10 failed sign-ins (the lock's own count), until an
  administrator enables it or `cpm-server --enable-user` does. Off by default: anyone who knows a
  username could then disable that account. The last active administrator is only ever locked, and
  the administrators are emailed either way
- Addresses the controller itself requests (an acme-dns server, a CrowdSec Local API) may not be
  a cloud metadata service (`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal` and
  the rest of link-local), however the address is written
- Optional two-factor sign-in (TOTP and backup codes) on the dashboard and the forward-auth portal,
  which can be required for administrators
- Passkeys with user verification required; adding one needs a sign-in from the last ten minutes
- Audit trail for all configuration changes
- A backup holds every secret the database encrypts, decrypted and sealed with the backup's own
  passphrase instead. Treat the file and its passphrase like `SESSION_SECRET`
- Private key downloads and restores need a sign-in from the last ten minutes
- Caddy's admin API, PostgreSQL and ClickHouse sit on internal networks the containers you proxy to
  cannot reach. The agent is root-equivalent on its host; [SECURITY.md](SECURITY.md) says why and
  what bounds it
- Supports OAuth2/OIDC for SSO, including group-based roles and an OIDC-only mode with no local accounts
- LDAP sign-in escapes the typed name for filters and DNs, refuses empty passwords before any bind,
  verifies TLS by default, and gives every refusal the same answer

**Production setup:**

```bash
export SESSION_SECRET=$(openssl rand -base64 32)
export POSTGRES_PASSWORD=$(openssl rand -base64 32)
docker compose up -d
```

Then create the administrator through [First run](#first-run). Nothing needs a password in `.env`.

**Limitations:**
- Per-host rate limits are counted by each Caddy instance on its own, so a host served by several
  agents allows its limit on each of them. Sign-in and pairing guess limits are shared by
  every controller through the database; password-reset and captcha flood limits are kept per
  controller
- `SESSION_SECRET` encrypts every secret the database holds - DNS credentials, private keys, agent
  secrets, two-factor secrets. Rotate it by moving the old value to `SESSION_SECRET_PREVIOUS`, which
  the next start re-encrypts everything away from; changing it without that makes them unreadable.
  A backup restores them under a new one

---

## User roles

CPM has four built-in roles, and **Users → Roles** makes more (see below):

| Capability | Viewer | User | Operator | Admin |
| ---------- | ------ | ---- | -------- | ----- |
| Log in to the dashboard | Yes | Yes | Yes | Yes |
| View own profile | Yes | Yes | Yes | Yes |
| Access forward-auth-protected apps (when granted) | Yes | Yes | Yes | Yes |
| Manage proxy hosts, L4 hosts and agents | No | No | Only what their groups were granted | Yes |
| Create or delete hosts | No | No | No | Yes |
| Manage certificates and access lists | No | No | No | Yes |
| Manage users, groups, and settings | No | No | No | Yes |
| View analytics, logs, audit log, and API docs | No | No | No | Yes |
| Create and manage own API tokens | Yes | Yes | Yes | Yes |
| Access role-appropriate REST API endpoints (`/api/v1/`) | Yes | Yes | Yes | Yes |

New users default to the **user** role. The first administrator is created in [First run](#first-run), or imported from a pre-3.0 database during migration. `ADMIN_USERNAME` / `ADMIN_PASSWORD` still seed one at startup for deployments that predate the setup flow.

**Operator** is the delegating role: its baseline is nothing, and it reaches exactly what
[group grants](#groups-and-delegated-management) name. Viewer and user are unchanged and gain
nothing from a grant, so adding one never widens an existing account - someone has to be given the
operator role deliberately.

The management endpoints under `/api/v1/` need a permission the role holds outright. Grants apply
to the dashboard; an operator's API token gets the same user-scoped endpoints a user's does.

**Custom roles** are sets of permissions, one choice per area (none, read, or read and change),
optionally **scoped to granted objects** like operator. Nobody makes, gives or changes a role
holding more than they do; nobody edits the role they hold; a role still given to a user, a group,
a sign-in mapping or a provider default can't be deleted. A group can give a role to its members
(never admin), and OIDC and LDAP group mapping can give any role.

API tokens can only be created from an authenticated dashboard session; an
existing bearer token cannot mint replacement credentials. Viewer and user
tokens are restricted to the same user-scoped API capabilities as their owner.

> **Forward auth access** is separate from role - all roles must be explicitly granted access to each protected host via the forward auth access list.

### Viewing as a role

Permissions attach to roles and groups, not people, so an admin checks what someone would see by
previewing a role rather than impersonating a user: **View as a role** on Users, or **View as an
operator in this group** on a group. Pages, actions, REST and GraphQL all follow the preview, and a
banner on every page leads back.

It narrows the admin's own session and nothing else. Changes are still made and audited as the
admin, a demotion cancels it, and it ends after an hour. While it is on, API tokens cannot be minted
(a token carries the real role) and forward-auth sign-in waits.

---

## Groups and delegated management

Groups are lists of users. They do two jobs: they gate access to forward-auth-protected apps, and -
with the **Access** button on a group - they decide what an **Operator** may manage.

### Granting management

Open **Groups → Access** on a group and tick the proxy hosts, layer-4 hosts and agents it should
reach, then choose the capability:

- **Manage** - edit, enable, disable and delete those resources.
- **View only** - see them in the lists, change nothing.

The rules, stated once:

- Grants **only** reach users whose role is Operator. An admin already has everything and ignores
  them; a user and a viewer manage nothing and gain nothing from one.
- An operator sees empty lists until something is granted, and the pages stay in their navigation
  so the emptiness is explainable.
- **Creating** a host is not grantable - a grant names a resource that already exists. Operators
  ask an admin for a new host, and can then be granted it.
- Two groups reaching the same host give the more permissive of the two capabilities.
- A grant disappears with the resource it named: deleting a host takes its grants with it.

Agents work the same way. An operator granted an agent can rename it and trigger a Caddy rebuild
from the **Agents** page; pairing, unpairing and disabling stay in Settings with the admins,
because they decide whether the controller talks to that host at all.

### Mapping IdP groups onto CPM groups

An OIDC provider's `groupPrefix` convention mirrors claimed groups by name, which stops being
useful when the IdP's name is not the one you want to see. **Groups → Access → Identity provider
groups** is that mapping written down: list the names this group is known by in your IdP, one per
line, optionally scoped to one provider.

- Matching is case-insensitive, and a Keycloak-style path (`/company/Infra`) is reduced to its last
  segment.
- A name mapped here is **not** also mirrored under its raw IdP name, so one claim never puts a
  user in two groups.
- Mappings are applied at sign-in when the provider has **Sync groups** switched on, which is the
  same switch that governs the prefix convention.

Role mapping is separate: the provider's group settings decide whether a claim makes
someone an admin, operator, user or viewer, and group membership then decides what an operator can
reach.

---

## Certificate management

Caddy automatically obtains Let's Encrypt certificates for all proxy hosts.

**DNS-01 challenge** (optional): Configure a DNS provider in **Settings → DNS → DNS providers** for wildcard certificates and environments where ports 80/443 are not public. Supported providers: Cloudflare, Route 53, DigitalOcean, Duck DNS, Hetzner, Vultr, Porkbun, GoDaddy, Namecheap, OVH, IONOS, Linode, Njalla, netcup, Spaceship, deSEC, Dynu, acme-dns, Infomaniak, INWX, ClouDNS, and RFC2136 (BIND/TSIG). Credentials are encrypted at rest with AES-256-GCM. You can override the DNS provider per certificate. For a domain whose DNS host has no API, delegate its challenges under **Challenge delegation** on the same page, to another zone or to an acme-dns server.

**Custom certificates** (optional): Import your own certificates via the Certificates page, pasted in or read from a file on an agent's host (`CERT_FILES_HOST_DIR`). A pair is refused unless the certificate is PEM X.509, the key is an unencrypted PEM key, and the key matches the certificate. Private keys are encrypted at rest with AES-256-GCM, migrated from legacy plaintext storage on startup, and treated as write-only by ordinary API responses and browser payloads. The built-in mTLS CA's private keys are encrypted the same way.

**What Caddy holds.** The ACME tab reads each agent's certificate storage, so it shows the expiry
and issuer of the certificate Caddy is actually serving. This needs a [current
agent](#features-that-need-a-current-agent).

- **Renew** makes each agent's Caddy renew a host's certificate ahead of schedule. Caddy has no
  renew call, so this is a temporary renewal window plus two reloads; it lapses after 15 minutes if
  no newer certificate appears.
- **Test reachability**, on the certificate and proxy host menus, checks DNS, CAA and an HTTP
  request to the host's own domains, from the controller. **Check from outside with Let's Debug**
  asks letsdebug.net to check it from the internet, which tells that service the domain name.
- **Download certificate** works for ACME and imported certificates alike. **Download private key**
  needs a sign-in from the last ten minutes, and every key downloaded is in the audit log.

---

## Geo blocking

Geo blocking is configured per proxy host. It requires MaxMind GeoLite2 databases (see [GeoIP setup](#geoip-setup)).

### Rule types

| Type | Example | Description |
| ---- | ------- | ----------- |
| Country | `DE` | ISO 3166-1 alpha-2 country code |
| Continent | `EU` | `AF`, `AN`, `AS`, `EU`, `NA`, `OC`, `SA` |
| ASN | `24940` | Autonomous System Number |
| CIDR | `91.98.150.0/24` | IP range in CIDR notation |
| IP | `91.98.150.103` | Exact IP address |

Rules can be **block** or **allow**. Allow rules take precedence over block rules - you can block an entire continent and then allow specific IPs or ASNs through.

### GeoIP setup

Geo blocking requires MaxMind GeoLite2 Country and/or ASN databases, which the controller downloads
itself:

1. Register for a free MaxMind account at [maxmind.com](https://www.maxmind.com/)
2. Generate a license key with `GeoLite2-Country` and `GeoLite2-ASN` permissions
3. Open **Settings → Geo-blocking → GeoIP databases**, tick **Use GeoIP**, and enter the account ID and licence key

That is the whole setup, with or without an agent. The controller downloads the Country, ASN and
City databases onto `caddy-manager-data`, asks MaxMind for newer builds once a day (the interval is
a field under **Settings → Geo-blocking → GeoIP databases**), and
downloads only an edition that changed. **Settings → Geo-blocking → GeoIP databases** shows when it last checked, and **Check
now** runs it on demand. Turning the toggle off stops the downloads and hides country matching from
the proxy-host forms; the databases already on disk are kept.

The controller needs outbound HTTPS to `updates.maxmind.com`, `download.maxmind.com`, and the
Cloudflare R2 storage MaxMind redirects downloads to. Without an account ID and licence key nothing
is downloaded, but GeoIP still works with databases you upload under **Settings → Geo-blocking →
GeoIP databases** (each `.mmdb` file is opened and its edition checked first) or place in
`/app/data/geoip` yourself. Offline mode turns the downloads off; uploads still work.

Every agent - the one in the same stack included - fetches its own copy from the controller onto
`agent-data`, and Caddy mounts that copy read-only.

---

## CrowdSec

Caddy becomes a CrowdSec bouncer. Turn on **CrowdSec** under **Settings → Caddy build** and
rebuild, then pick where the Local API is under **Settings → CrowdSec**:

- **Managed (bundled host only).** The bundled agent runs a `crowdsec` container
  (`crowdsecurity/crowdsec`, pinned) behind the `crowdsec` Compose profile, as it does ClickHouse.
  It reads Caddy's access log from `caddy-logs`, read-only, with the `crowdsecurity/caddy`
  collection, and the controller keeps that log on and in JSON while CrowdSec is managed. The
  bouncer key is generated by the controller, encrypted at rest, and handed to Compose through the
  agent's environment, never a file. The container sits on its own `crowdsec` network with Caddy
  alone, so no upstream on `caddy-network` can reach its Local API. The online API is off by
  default, so no attacker address leaves the host; switch **Share signals** on for the community
  blocklist. AppSec (virtual patching and generic rules) is one switch away. Hosts served by other
  agents are not checked in this mode.
- **External.** A CrowdSec you run yourself, with either archive. CPM does not feed it logs or
  connect it to Caddy; you mount `<project>_caddy-logs` into it read-only with the
  `crowdsecurity/caddy` collection reading `access.log` (Access logging on), and put it on a
  network Caddy shares - a dedicated one added to `caddy` in `docker-compose.override.yml` and
  picked up with `docker compose restart agent`, since anything on `caddy-network` could reach the
  Local API. Then create a key with `cscli bouncers add caddy` and enter the Local API URL as Caddy
  reaches it and the key. The key is encrypted at rest, never returned by the API, and kept only
  while the Local API and AppSec addresses are unchanged. **Test** runs from the
  controller, which may not reach a Local API only Caddy's network can. The
  [CrowdSec docs](https://caddyproxy.com/features/crowdsec/#external)
  walk through it.

Every proxy host and L4 host then refuses the addresses CrowdSec has decided against, first in the
chain, ahead of rate limiting, geo blocking and the WAF; a host can opt out in its editor. The
bouncer checks the client address resolved through **Settings → Network → Trusted proxies**.

---

## Bot challenge (Anubis)

Run [Anubis](https://anubis.techaro.lol/) on `caddy-network` in subrequest mode (`TARGET=" "`),
then switch on **Bot challenge (Anubis)** in a host's editor and enter its URL, such as
`http://anubis:8923`. Caddy proxies `/.within.website/*` to it and checks every other request with
it, after the WAF and before any sign-in; a visitor without a pass gets a 307 to the challenge.

- Anubis's policy must set `status_codes: {CHALLENGE: 200, DENY: 403}`. Its default answers a
  denial with 200, which Caddy would take as a pass.
- Set `REDIRECT_DOMAINS` to the hosts' domains, and `ED25519_PRIVATE_KEY_HEX` so passes survive a
  restart. Leave `PUBLIC_URL` unset.
- API clients and webhooks cannot solve a challenge: list their paths under **Exempt paths**.

See the [bot challenge docs](https://caddyproxy.com/features/bot-challenge/)
for a Compose file and the caveats.

---

## Analytics

Analytics stores and queries traffic and WAF events in a bundled ClickHouse instance. Each request records why it ended - served, or the gate that answered it (WAF, geo block, access list, sign-in, rate limit, CrowdSec) - and how long it took, alongside its client's network (ASN) when the GeoIP ASN database is installed. Requests logged before an upgrade count as served, or as geo-blocked where the blocker logged them. The whole page state is in the URL, so a link or a saved view reopens it exactly. ClickHouse's TTL keeps data for **30 days** by default. Change the window under **Settings → Observability → Analytics** (`CLICKHOUSE_RETENTION_DAYS` until a value is stored) - saving it re-checks the schema on the next write, which migrates the existing tables' TTL to the new value and purges expired data, with no restart.

### Enabling and disabling analytics

Open **Settings → Observability → Analytics**, tick **Collect analytics**, and set a ClickHouse password. Saving
starts the `clickhouse` container; unticking stops it. Nothing needs to change in `.env`, and no
Compose profile has to be listed - the agent runs `docker compose --profile clickhouse up -d
clickhouse` on your behalf, passing the saved credentials through.

Three things to expect:

- **The first start pulls the ClickHouse image**, which takes a few minutes on a slow link. The
  save returns immediately; the agent reports progress under **Settings → Agent**.
- **Turning analytics off stops the container but keeps `clickhouse-data`.** Your event history
  survives, and turning it back on picks up where it left off.
- **Pick one owner.** Once the credentials live in Settings, drop `clickhouse` from
  `COMPOSE_PROFILES` and delete `CLICKHOUSE_PASSWORD` from `.env`. Leaving both in place means your
  own `docker compose up -d` also creates the container - from the `.env` values, which are now the
  stale copy. The controller repairs it on its next start, but the window is avoidable. A fresh
  install already starts this way: `.env.example` ships both commented out.

Without an agent - a standalone binary, or a stack you assemble yourself - Docker is the only thing
that can start ClickHouse, so it is the profile as before:

```env
COMPOSE_PROFILES=clickhouse
CLICKHOUSE_PASSWORD=your-clickhouse-password   # openssl rand -base64 32
```

```bash
docker compose up -d
```

Leaving `COMPOSE_PROFILES` empty and omitting `CLICKHOUSE_PASSWORD` disables analytics there. The
web container starts normally without ClickHouse, the Analytics page explains that it is not
enabled, and no data is collected.

---

## WAF (Web application firewall)

The WAF is built on [Coraza](https://coraza.io/) and includes the OWASP Core Rule Set.

Set the mode in **WAF → Settings** - Off, Detection only (matching requests are logged and let through) or Blocking (rejected with 403) - then optionally override it per proxy host. The **Hosts** tab lists every host's mode, where it comes from and its WAF events in the last week. With the CRS loaded, the settings also take the paranoia level (1-4), whether to log the next level without blocking, and the inbound and outbound anomaly thresholds (5 and 4 by default).

**OWASP CRS** covers SQLi, XSS, LFI, RCE, and more (enabled by default when WAF is on).

**WebSockets** - an upgrade request is inspected like any other, so a handshake carrying an attack is refused. The messages after the handshake are not inspected. A host with **WebSocket support** off refuses upgrades with 403, WAF or not.

**Exclusions** - switch a rule off globally or on one host, optionally only under a path (decoded and normalised before it is compared) or only for one variable such as `ARGS:content`, with a reason. **False positive** on an event fills in the narrowest one. Coraza compiles the change before it is saved, and if Caddy still refuses the result it is undone. The anomaly decision rules (949110, 949111, 959100, 959101) cannot be excluded. Suppressed rule ids from older versions are moved into exclusions on startup.

**Why was this blocked** - an event shows every rule it matched with the points each added and the variable it matched in, the score against the threshold and the deciding rule, with Working as intended, False positive, Block and Copy as curl. Credential headers, cookies and password- or token-named parameters are replaced with `[redacted]` before an event is stored, and again when it is shown.

**Security events and blocked sources** - **Security** shows what every gate stopped and from where, and keeps the global deny list: addresses and networks, and with the Geo Blocking module countries, continents and ASNs, each with a reason and an optional expiry. A match gets 403 before any other handler runs, on every HTTP host; layer-4 hosts are not covered.

**Rule presets** - an application that trips the CRS usually needs the same exclusions everywhere it runs. Write them once under a name in **WAF → Presets**, then select the preset globally in **WAF → Settings** or per host in its WAF card (added to the global ones in merge mode, replacing them in override mode). Editing a preset changes every host that selects it; one still selected cannot be deleted.

**CRS plugins** - install plugins from the [OWASP CRS plugin registry](https://github.com/coreruleset/plugin-registry), or registries of your own, under **WAF → Plugins**, then select them globally or per host. The registries are re-read on a schedule and every plugin checked, so ones Caddy cannot load (Lua scripts, data files, ModSecurity-only rules) are marked unsupported before anyone tries. The controller fetches from GitHub, so it needs outbound HTTPS to `api.github.com` and `raw.githubusercontent.com`; an optional GitHub token raises the API rate limit.

**Custom directives** - any ModSecurity SecLang syntax is accepted, e.g.:

```text
SecRule REQUEST_HEADERS:User-Agent "@contains badbot" "id:9002,phase:1,deny,status:403,log"
```

Directives are checked twice before they are stored, because Coraza compiles every WAF while Caddy loads its config and one refused rule would stop every host's config from loading. The editor marks what Coraza would refuse as you type - unknown variables, operators and actions, malformed or duplicate rules, regular expressions Go's RE2 cannot compile - and blocks the save on an error. On save the agent then has Caddy validate the WAFs the change produces, in a short-lived network-less container from the Caddy image and without loading them, which catches what only a merged config shows: rule ids colliding with the CRS or between the global settings and a host. The error names the host and quotes Coraza. The second check needs a paired agent whose Caddy container exists; without one the save goes ahead on the first check alone.

---

## IPv6

IPv4 and IPv6 both work everywhere by default.

- The controller binds `::`, a dual-stack socket that accepts IPv4 too. `HOST=0.0.0.0` restricts it
  to IPv4 if you want that.
- Caddy's admin API listens on a bare port rather than `0.0.0.0`, so an agent reaching it over IPv6
  finds something there.
- `caddy-network` is created with `enable_ipv6`, without which a proxy host with an IPv6 upstream
  has no route to it however the containers themselves are configured.
- Layer-4 listen addresses and upstreams accept `[2001:db8::1]:5432`. **The brackets are
  required**: unbracketed, `2001:db8::1` ends in `:1`, which is indistinguishable from a port - so
  it is rejected rather than silently read as one.
- Trusted proxies, geo-blocking allow/block lists and access lists accept IPv6 addresses and CIDR
  ranges.

## The agent

Publishing a layer-4 port and changing Caddy's compiled-in plugins both need the Caddy *container*
recreated, not just its config reloaded. The controller has no Docker access - deliberately - so a
second container does that work. It dials the controller and holds one GraphQL subscription open;
the controller never dials it.

Every request is signed with a shared secret using HMAC-SHA256 over the method, path, timestamp and
body. The secret never travels with a request, and the signature covers the path, so a captured
read cannot be replayed as a write.

### Analytics are parsed by the agent and written by the controller

Caddy's access and WAF logs are files on the agent's host - a controller elsewhere cannot read them
at all. So the agent parses them and relays the events to the controller in batches, every 30
seconds, signed with its pairing secret like every other request. The controller checks each row,
records which agent sent it, and writes it to ClickHouse. No agent holds a ClickHouse credential, and
ClickHouse never has to be reachable from an agent's host.

There is nothing to configure: enabling analytics on the controller is what switches the parsers on, and
turning it off switches them off. While the controller is unreachable an agent keeps its place in
the log, and sends what it missed once the controller is back.

### GeoIP databases come from the controller

The controller holds the MaxMind subscription and downloads the databases itself. Every agent
fetches them through the controller rather than needing a licence key of its own, checking daily -
and whenever the controller has just downloaded a new build - and fetching only when the copy it
has is out of date. It writes them to its own volume, which Caddy mounts read-only, so geo-blocking
works on every host in the fleet without the agent holding a licence key or running as root.

The request is signed with the same pairing secret, with no extra credential. It goes to the address the agent is paired with, so an agent that can
reach its controller at all can fetch them. An agent that cannot keeps using whatever database it
already has.

### Log permissions

The agent runs as its own user and reaches Caddy's logs through Caddy's group. If a log is
unreadable, the WAF audit log cannot be truncated, or Caddy cannot list the log directory to prune
rolled files, the agent logs a warning and the **Agents** page shows it on that agent's card with
the command that fixes it. The agent never changes a permission itself.

### Features that need a current agent

The log viewer, the certificate details and downloads on the ACME tab, and **Load built image** are
commands the controller sends an agent, and an agent lists the ones it understands. An older agent
is never sent one it did not list: it keeps serving, and those features are unavailable on it until
it is upgraded. The same goes for:

- **Certificates from files** - only an agent with `CERT_FILES_HOST_DIR` set, and new enough to
  read it, is offered in the picker.
- **Managed CrowdSec** - an older agent ignores the `crowdsec` service and reports it off.
- **L4 port ranges** - an older agent is sent a range one port at a time, since its pattern
  refuses a range.

### One controller, many configurations

Everything a proxy serves - hosts, certificates, access lists, published ports, compiled-in
plugins - belongs to this controller's database, not to any host. What each agent runs is computed
from that database and sent to it: **a document per agent**, not one for the fleet. A change is
sent to every agent at once - if one rejects the config or cannot be reached, the whole apply
fails and names that agent. A host that already accepted keeps the new config, so the failure is
reported rather than hidden, and the next successful apply brings the fleet back together.

**Assigning hosts to agents.** Each proxy host and layer-4 host has an *Agents* section listing
every paired agent. Tick none and the host is served by all of them, which is what a new host defaults to
and how hosts created before assignment existed behave. Tick one or more and only those agents
receive it - useful for a host that only one site can reach, or a pair of edge nodes sharing a
domain.

**Per-agent Caddy builds.** Settings → Caddy build has a *Module selection for* picker: the fleet
default, or one named agent. An agent with no selection of its own follows the fleet default, so
enabling a module for everyone still reaches the agents nobody configured separately. Give an agent
its own selection when it needs a plugin the rest do not - a DNS provider only it can reach - and
switch *Follow the fleet default* back on to put it back on the shared list.

Two consequences worth knowing:

- **Plugins are per agent, and a document only names what that agent has.** Caddy rejects a
  document naming a module it lacks - wholesale, taking every host on that instance down with it -
  so generation is gated on what each agent reports having built. Rebuild an agent before
  a newly enabled module takes effect on it.
- **Ports follow the assignment.** A layer-4 host's port is opened on the agents that serve it, and
  on all of them when it is unassigned. Publishing a port still needs the usual apply from the
  layer-4 page: assigning a host tells an agent what to serve, not to recreate its container on the
  spot.

### How an agent connects

The agent dials the controller, never the other way round. It opens one long-lived **GraphQL
subscription** at `/api/graphql`, delivered as SSE, and holds it open: the controller pushes desired
state, Caddy admin calls, and a periodic `ping` down it, and the agent reports status and command
results back as mutations to the same endpoint. So an agent on a NAT'd or firewalled host needs
**no inbound port** - only outbound reach to the controller.

Every one of those calls is signed with the secret agreed at pairing, over the request body. Pairing
itself is the one thing still on a plain REST route, because it runs before that secret exists.

An agent that has never been paired does nothing, and **leaves Caddy stopped**. Caddy sits behind a
Compose profile so that `docker compose up` will not start it: a host nobody has finished
installing must not answer on 80 and 443 with a default page. Pairing is what starts it.

### Same host - nothing to enter

The bundled stack pairs itself. The controller leaves a single-use token on its data volume, which
the agent mounts read-only and reads through the controller's group, and an idle agent that finds
one pairs with it - so `docker compose up` gives you a working install with no code typed anywhere.

The boundary is the volume: reaching that file already means being inside the stack. It is the same
boundary the pre-3.1 design used, which kept a long-lived shared secret there; this token is
single-use and is rotated the moment it is redeemed, so a copy someone else read stops working.

Caddy still waits for first-run setup to finish, because until then there is no configuration to
serve. Reach the dashboard on `:3000` to complete it, and Caddy starts on its own.

### A different host - pairing

An agent on another host cannot mount that volume, so it pairs with a code you carry.

Generate one under **Settings → Agent**. It is six letters, valid for five minutes and works once.
Wrong guesses are limited to five a minute per client address and 200 per code. Then, on the
agent's host:

```bash
docker exec -it caddy-proxy-manager-agent cpm-agent --pair --host https://cpm.example.com --code ABCDEF
```

Before anything is exchanged, the agent asks the controller who it is - without spending the code -
and asks you to confirm:

```text
This agent is about to pair with "Caddy Proxy Manager" (controller 3f9a1c2e)
  at https://cpm.example.com:443
Confirm pairing? [y/N]
```

The name is the controller's Application name (`APP_NAME`, or the setup step) - the one its sidebar
shows. Answering no changes nothing and leaves the code valid. The prompt needs a terminal, hence
`-it`; a script with none can pass `--yes` once it has another way to be sure of the address. A
wrong code is refused at this step and counts against the same guess limits.

`--host` is the controller's address as the agent can reach it. A bare host means `https://` on
443, except loopback and single-label names such as `web`. Plain `http://` towards a private address
(RFC 1918, a tailnet) works with a warning - `--host http://10.0.0.5:3000` - and towards a public
one is refused unless `CONTROLLER_ALLOW_INSECURE_HTTP=true`, because pairing sends the shared secret
over this link. The two exchange a secret, which is stored encrypted on the controller and in the
agent's own database, and the code is never used again. The agent then pulls its configuration and
starts Caddy.

The code pairs only an agent the controller has never seen. To re-pair one that is already listed -
its database was rebuilt, say - use **Re-pair** on its row, which mints a code for that agent alone.

`--pair` talks to the agent already running on that host rather than doing the work itself - the
running process is the one holding the database the secret lands in and the stream it will open.
Start the agent first; pairing a stopped one is an error, not a wait.

`CONTROLLER_URL` and `PAIRING_CODE` do the same thing without a terminal, for a deployment that
configures everything through the environment. A stored pairing wins over both, so a code left in
place after a successful pair is ignored rather than burned again on every restart.

### Connecting agents over Tailscale or Headscale

An agent needs one thing from the network: an outbound route to the controller. It dials out and
holds a GraphQL subscription open, and the controller never dials back - so it works over a tailnet as it does anywhere
else, and CPM needs no Tailscale-specific configuration to use one. Point `CONTROLLER_URL` (or
`--host`) at the controller's tailnet address and everything else is unchanged.

Any of three addresses works:

| Address | When |
| ------- | ---- |
| `http://100.98.59.37:3000` | Tailnet IP. No DNS, no TLS, nothing to set up on the controller |
| `http://cpm-controller:3000` | MagicDNS name. Same, but survives the IP changing |
| `https://cpm-controller.tailnet-1234.ts.net` | Behind `tailscale serve --bg --https=443 http://127.0.0.1:3000` on the controller's host |

An `https://` address with no port means **443**, because the controller serves plain HTTP and an
https address means something in front of it is terminating TLS. An `http://` address with no port
still means 3000. A bare host means `https://`, unless it is a single-label name like
`cpm-controller`, which keeps meaning `http://` on 3000. `--port` overrides either. Plain http to a
tailnet IP or name is allowed, since the tailnet encrypts it, and logs a warning.

**Getting the agent onto the tailnet.** If the agent's host is already on it, there is nothing to
do. Otherwise put the container on the tailnet however you normally would - a `tailscale/tailscale`
sidecar sharing the agent's network namespace works, and so does joining the host itself. CPM has
no opinion about it: the agent only needs an outbound route to `CONTROLLER_URL`.

This path is tested - an agent reaching its controller across a real tailnet pairs, streams, and
serves exactly as it does on a flat network.

Pairing works the same way: generate a code under **Settings → Agent** and run

```bash
docker exec -it caddy-proxy-manager-agent cpm-agent --pair --host https://cpm-controller.tailnet-1234.ts.net --code ABCDEF
```

**Headscale.** Everything above applies; set `--login-server` and use whatever address your
control server hands out. Headscale deployments usually have no `.ts.net` certificate, so the
plain `http://<tailnet-ip>:3000` or MagicDNS form is the normal one. If you do put TLS in front of
the controller using a private CA, mount the CA into the agent and set `NODE_EXTRA_CA_CERTS` to
its path - the agent's HTTP client reads it, and without it the connection is refused as
`unable to verify the first certificate`.

Two things worth knowing:

- **An agent that starts before tailscaled is up is fine.** A controller it cannot resolve is an
  ordinary unreachable controller: the agent retries with backoff and keeps Caddy serving whatever
  it already had. Only a 401 - the controller having forgotten this agent - ends the loop.
- **The stream is long-lived, and `tailscale serve` neither buffers it nor times it out.**
  Verified against a real tailnet: frames arrive as they are sent rather than batched at the end,
  and a stream held open for five and a half minutes still carried data at the end of it - even
  one that sent nothing at all in between, so the agent's 20-second keepalive has margin to spare
  rather than being the only thing holding the connection up.

### Unpairing

Unpairing revokes the secret. The agent's next call is refused, it drops back to idle, and **it
stops Caddy** - so unpairing takes that host out of service. Pair it again with a fresh code to
bring it back. A stream that goes silent for three keepalives (60 seconds) is reconnected, so an
agent whose stream stayed open after the controller closed it still notices within a minute.

### Stopping the agent

The agent owns Caddy on its host, so **stopping the agent stops Caddy** first - `docker compose
stop agent`, a host shutdown, anything that sends it `SIGTERM`. It gives Caddy 40 seconds, inside
the minute the bundled compose file allows the agent to exit. When the agent starts again with a
pairing it starts Caddy straight away, without waiting for the controller, so a host that reboots
while its controller is unreachable still serves; the controller's own setting still wins once it
answers. A restart the controller asks for, after a migration, keeps Caddy running.

---

## Caddy build

Caddy is a single static binary: a plugin either was compiled in with
[xcaddy](https://github.com/caddyserver/xcaddy) or it does not exist at runtime.
**Settings → Caddy build** makes that list editable.

The default image ships with every supported module except the opt-in ones -
Rate Limit, CrowdSec, HTTP Cache and its storages - so an existing install behaves exactly as it did
before this page existed. An opt-in module is compiled in only once you select
it and rebuild.

### Choosing modules

Each supported plugin has a toggle. Turning one off has two effects:

- The app stops generating config that uses it, immediately. This is safe - the
  handler stops being emitted - and it is what lets you remove a plugin
  without Caddy rejecting the stored config on the way out.
- Every setting that depends on it is disabled in the UI, with a tooltip naming
  the module. Global geoblocking and per-host geoblock rules follow the Request
  Blocker module; the WAF page and per-host WAF settings follow Coraza; the L4
  Proxy hosts page follows caddy-l4; the Tailscale settings and every per-host
  tailnet option follow caddy-tailscale; the **Caddy cache** mode of a host's
  Cache assets follows HTTP Cache; a host's rate limiting follows Rate Limit;
  the CrowdSec settings follow CrowdSec (whose L4 part compiles caddy-l4 in
  regardless); and each DNS provider follows its own
  `caddy-dns` module, so disabling Cloudflare leaves Route 53 alone.

A module still in use cannot be switched off - the save is refused and names
what is using it (for example "3 enabled L4 proxy hosts need the Layer 4 Proxy
module"). That check covers global WAF and geoblocking, CrowdSec while it is
switched on, per-host WAF and geoblock rules, enabled L4 hosts, and every DNS
provider with credentials on file. Turn the feature off first. Rate Limit and HTTP Cache are not checked,
because nothing breaks without them: a rate-limited host is served without
limits, and a host set to the Caddy cache falls back to browser caching, each
with a warning in its editor.

Per-host **Custom Caddyfile** snippets cannot be checked the same way - they are
free-form text, and only Caddy's adapter knows what a directive resolves to, for
the binary running *now* rather than the one a rebuild would produce. Saving a
module change while any host has a snippet therefore adds an advisory note
listing those hosts, so you can review them before rebuilding.

### Version pinning

Which modules get compiled is your choice; *which version* of each is pinned in
`docker/caddy/go.mod`, and `docker/caddy/build.sh` turns the two into
`xcaddy build --with <path>@<version>` flags. So a rebuild next month produces
the same binary as one today, and `go.sum` authenticates every module it pulls.

Dependabot proposes updates to those pins weekly. Caddy's own version is pinned
there too, as a release tag: `docker/caddy/update-compatibility-pins.sh` derives
the `cel-go` replacement from that release, which is what keeps the build off a
floating master commit. A scheduled workflow reruns it and opens a PR when the
replacement moves.

Every `replace` directive in that `go.mod` is passed through to the build, so a
plugin can be pointed at a fork carrying a fix its upstream has not merged. Each
one says why it exists in a comment beside itself, and the resolved list below
records them, so an image never hides which source a plugin came from.
`caddy-tailscale` is on one - see [The plugin is on a
fork](#the-plugin-is-on-a-fork).

You can see what an image was built with, without rebuilding it:

```bash
docker run --rm ghcr.io/caddyproxymanager/caddy:latest cat /etc/caddy/caddy-modules.resolved.txt
```

### Custom modules

Any Caddy plugin published as a Go module can be added by path, with an optional
tag, branch, or commit, and an optional name to tell it apart in the list (the
name is never part of the build). It is compiled from source at build time, so a module
that does not build fails the rebuild - the running container is left untouched
when that happens.

Custom modules are compiled into the proxy binary and run with its privileges.
Add only modules you trust, from sources you would trust with the proxy itself.

### Rebuilding

Saving a changed selection starts the rebuild - in Settings and over `PUT /api/v1/caddy/modules`
alike. The config is applied first, then the selection is pushed to the agent, which runs
`docker compose build caddy` at once and recreates the container. With `CADDY_BUILD_MODE=external`
it waits for **Load built image** instead, and with no agent connected the build starts when one
connects. Compiling Caddy takes several minutes; the proxy keeps serving on the current binary
until the new one is ready, then restarts. **Rebuild** only retries a build that failed.

Because *enabling* a module only takes effect once it is in the binary,
config generation uses the intersection of what you selected and what the running
image was built with. The panel shows a "Rebuild required" banner in between.

Those are two different things, and keeping them apart is what makes a failed
build harmless:

| | Owned by | Holds |
| --- | --- | --- |
| the selection | the controller's database | the *desired* module list - the build's input |
| the applied set | the agent, recorded only after the build succeeds and Caddy is healthy | what the running binary *actually* contains |

If a build fails, the applied set is left alone, so the app keeps generating
config the current binary can load. Nothing needs cleaning up by hand - fix the
selection and save it, or click Rebuild to retry it as it is. If the agent is
restarted mid-build (a host reboot, say), it clears the stale "building" state on
startup and the button becomes available again.

Rebuilding needs `GRPC: 1` and `SESSION: 1` on the `docker-socket-proxy` service (the
default in `docker-compose.yml`), which BuildKit builds through. To keep build access
away from the agent, build the image yourself instead.

#### Building the Caddy image yourself

Set `CADDY_BUILD_MODE=external` for the agent, and `GRPC: 0` and `SESSION: 0` on
`docker-socket-proxy`. The agent then never builds. **Settings → Caddy build** shows the
`docker build` command for your selection in place of the Rebuild button. It builds from
this release's tag on GitHub, so it needs no checkout and runs anywhere Docker can
build:

```bash
docker build \
  -f docker/caddy/Dockerfile \
  --build-arg CADDY_MODULES="github.com/caddy-dns/cloudflare github.com/mholt/caddy-l4" \
  --build-arg PUID=10000 --build-arg PGID=10000 \
  -t caddy-proxy-manager-caddy:custom \
  https://github.com/CaddyProxyManager/caddy-proxy-manager.git#v3.6.1
```

Build it on the agent's host, or elsewhere and push it to a registry. The first time,
set `CADDY_IMAGE` to that tag in `.env` and run `docker compose up -d agent` so the
agent's Compose sees it. Then click **Load built image**: the agent pulls the tag if it
is a registry image and reads the new image's module list before touching Caddy. If the
image lacks a module Caddy has now, the agent first has the controller push a config
without it, since Caddy resuming from a saved config that names a missing module would
not start. Then it recreates Caddy if the tag names a different image, and waits for it
to report healthy.

The agent takes the applied module set from the image itself, from
`/etc/caddy/caddy-modules.txt`, which the Dockerfile writes from `CADDY_MODULES`. It reads
it again whenever it starts Caddy, so a swap made behind its back is picked up on its
next restart. An image built some other way has no such file and is treated as having
no plugins: the app then generates config any Caddy can load, and every feature that
needs a module stays off until you load an image that lists it.

Every image records what it was compiled with, so you can check a container
directly rather than inferring it:

```bash
docker exec caddy-proxy-manager-caddy cat /etc/caddy/caddy-modules.txt
```

### Managing modules over the REST API

The same selection is available under `/api/v1/caddy/modules`:

- `GET` returns the module catalog, the stored selection, and how it differs
  from the running image.
- `PUT` replaces the selection. It applies the same refusal as the UI, returning
  `409` and naming what is still using a module you tried to disable.

Saving over the API starts the rebuild, the same as saving in the UI: the selection
is part of the agent's desired state, and the config is re-applied without the removed
modules first. External mode has nothing to build, so there it waits for **Load built
image**. The rebuild trigger (to retry one) and its progress live at `POST` /
`GET /api/caddy-build`, and external mode's
**Load built image** at `POST /api/caddy-build/image`. They take the same admin
Bearer token but sit outside the versioned `/api/v1` contract: they back the
Settings panel and may change without a version bump. Prefer the button.

### Per-host Caddyfile

Each proxy host also has a **Custom Caddyfile** field for raw Caddyfile
directives. They are adapted to JSON by the running Caddy - the same binary, with
the same plugin set, that will execute them - and inserted before that host's
reverse proxy, as a `subroute` so each directive keeps its own matcher.

A snippet Caddy cannot parse is rejected when you save, with Caddy's own error
naming the line. A snippet that stops adapting later - because it referenced a
plugin you have since removed - is skipped with a warning in the web container's
logs rather than failing the whole config, so one stale snippet cannot take the
other hosts down with it.

### Global Caddyfile

**Settings → Caddy build → Global Caddyfile** takes raw Caddyfile for the whole
instance: a global options block, and site blocks on ports of their own. It is
adapted by each agent's Caddy and added to that agent's config, never replacing
what CPM generates - CPM rebuilds the whole document on every apply, so an
override would only fight it.

A save is adapted by every connected agent and checked with `caddy validate`.
Anything that would replace CPM's own config is refused by name: the admin API,
storage, certificate automation, `http_port`/`https_port`, a port a CPM server
listens on, CPM's logs, and the `layer4` and `tailscale` apps. Like a per-host
snippet, one that stops adapting later is skipped with a warning.

---

## Cache assets

**Proxy host → Cache assets** caches stylesheets, scripts, images and fonts,
matched by file extension. Pages and API responses are never cached: they are
too often per-user.

| Mode | What it does |
| --- | --- |
| Browser | Sets `Cache-Control: max-age` on a 2xx asset response the upstream sent without one |
| Caddy cache | Also keeps a shared copy in Caddy ([Souin](https://github.com/darkweak/souin)), so repeat requests skip the upstream. Needs the opt-in HTTP Cache module; until an agent has it, the host falls back to browser mode there |

Either way the cache sits after forward auth, access lists and the WAF, in
front of the proxy. The Caddy cache skips any request carrying a cookie or an
`Authorization` header, and a response that sets a cookie is marked `private`
before any cache sees it, so one visitor's copy never reaches the next.

**Settings → Caddy build → HTTP cache** decides where the Caddy cache keeps
entries: in memory by default, or in Otter (memory, bounded by entry count),
Badger or SimpleFS (on `caddy-data`, so it survives a restart), Redis/Valkey or
etcd (shared by every Caddy pointed at it). Each storage but memory is an
opt-in module of its own; an agent whose image lacks the chosen one caches in
memory. It can also purge Cloudflare or Fastly. The Redis password and the CDN
API key are encrypted at rest and never sent back to the browser or the API.

---

## Default response

Configure **Settings → Responses → Default response** to preserve Caddy's native behavior for unmatched HTTP requests (such as an automatic HTTPS redirect or empty response, depending on the generated server config), or replace it with:

- a custom HTTP status, body, and response headers (including custom HTML);
- a redirect; or
- an aborted connection with no HTTP response (the Caddy equivalent of an nginx `444`).

Configured proxy hosts always take precedence over this catch-all. For HTTPS, Caddy can only send the response after TLS succeeds; an unknown hostname or direct-IP request may fail the certificate handshake first.

---

## Upstream DNS pinning

You can enable upstream DNS pinning globally (**Settings → DNS → Upstream DNS pinning**) and override per host (**Proxy host → Upstream DNS pinning**).

When it is on, hostname upstreams are resolved during config save/reload and written to Caddy as concrete IP dials. The address family is one of:

- `both` (preferred, resolves AAAA then A with IPv6 preference)
- `ipv6`
- `ipv4`

### HTTPS limitation

If one reverse proxy handler has several different HTTPS upstream hostnames, those HTTPS upstreams are not pinned and keep their hostname dials, to avoid a TLS SNI mismatch.

HTTP upstreams in the same handler are still eligible for pinning.

---

## Tailscale

A proxy host can be served on your [tailnet](https://tailscale.com/) instead of, or as well as, the
public internet - and it does not need anything else on the host. The
[caddy-tailscale](https://github.com/tailscale/caddy-tailscale) plugin runs a Tailscale node in
userspace inside the Caddy process: no `tailscaled`, no `/dev/net/tun`, no extra published ports,
and no change to `docker-compose.yml`.

Turn it on in **Settings → Network → Tailscale**, on the **Node defaults** card. The one thing it
needs is a reusable auth key from the Tailscale admin console. If you would rather not store the key
in the database, put a Caddy placeholder in the field instead - `{env.TS_AUTHKEY}` is passed through
untouched, and Caddy resolves it from the container's environment.

| Setting | What it does |
| --- | --- |
| **Auth key** | Registers each node. Encrypted at rest and never sent back to the browser. |
| **Default node name** | The tailnet machine name a host inherits when it names none. Several hosts can share one node. |
| **Tags** | ACL tags applied at registration. Most reusable auth keys require at least one, e.g. `tag:caddy`. |
| **Control server URL** | Point at Headscale or another coordination server. Empty uses Tailscale's own. |
| **State directory** | Where each node keeps its identity, one subdirectory per node. Defaults to `/data/tailscale`, which is on the `caddy-data` volume - keep it on a volume, or every restart registers a new machine. |
| **Ephemeral** | Nodes leave the tailnet when Caddy stops instead of lingering as offline machines. |
| **Check the auth key** | Verify the key against the Tailscale API before saving. Off by default; see [Checking the auth key](#checking-the-auth-key). |
| **Serve HTTP/3 on tailnet listeners** | Off by default. Adds QUIC to the tailnet listeners, if HTTP/3 is also on globally. HTTP/2 there follows the global switch alone. |

> **HTTP/3 on the tailnet can hang Caddy's config load.** An HTTP/3 listener makes Caddy bring the
> node up while it loads a configuration. Whenever the control server is unreachable, that load
> hangs and holds Caddy's admin API, so no host on that agent can be updated until it is back.
> Leave it off unless your tailnet clients need QUIC.

### Per host

**Proxy host → Tailscale** carries three things.

**Serve on tailnet.** The host's routes move to a listener on the chosen node. **Tailnet only** -
on by default - keeps them off the public `:80`/`:443` listener entirely, so the service exists
only for devices on your tailnet; turn it off to publish in both places.

Routing is still by `Host` header, so add the node's MagicDNS name (`<node>.<tailnet>.ts.net`) to
the host's **Domains**. Caddy gets the certificate for that name from Tailscale - no ACME, no DNS
provider, and nothing to configure. A `.ts.net` domain is never sent to a public CA, which could
not validate it anyway.

**Require a Tailscale identity.** Only devices signed in to your tailnet may reach the host, and the
caller is identified by their tailnet login. It supports the same protected/excluded path lists as the
other authentication integrations, and **Forward the identity upstream** sets these on the proxied
request:

| Header | Value |
| --- | --- |
| `X-Tailscale-User` | Full login, e.g. `alice@example.com` |
| `X-Tailscale-Login` | Login without the domain |
| `X-Tailscale-Name` | Display name |
| `X-Tailscale-Tailnet` | Tailnet name |
| `X-Tailscale-Profile-Picture` | Profile picture URL |

Any such header sent by the client is stripped before the request is proxied, on every route,
including ones that bypass the identity check - so an upstream can trust what it receives.

Tagged devices are refused: a tag has no user behind it, so there is no identity to forward.
Identity authentication needs the host to be served on the tailnet, and is dropped if it is not -
the authenticator finds its node through the listener the request arrived on.

**Reach upstreams over the tailnet.** Independent of the other two: a host published on the public
internet can still proxy to a machine that only exists on your tailnet. Name a node to dial through
and put a MagicDNS name or tailnet IP in **Upstreams**. Upstream DNS pinning and custom DNS
resolvers do not apply to these - names are resolved by MagicDNS on the far side, which this
container's resolver knows nothing about.

A node named only here is never listened on: it exists so Caddy has something to dial out through,
and it stays idle until a request goes through it.

### Checking the auth key

A node that cannot register is a listener that never comes up, and Caddy refuses a configuration it
cannot start - so a missing or rejected auth key fails the apply for **every** host on **every**
agent, with an error naming Tailscale rather than whatever was being edited. Two things guard
against that.

**A host that uses Tailscale will not save while no key is stored.** This is unconditional, and it
covers the REST API as well as the form. A Caddy placeholder counts as a key: whether the
environment defines `TS_AUTHKEY` is only knowable inside the Caddy container.

**Optionally, the key itself is checked before it is stored.** Turn on *Check the auth key against
the Tailscale API* in **Settings → Network → Tailscale**. A revoked, expired or mistyped key is then refused
at the point you paste it, with the reason, instead of surfacing at the next config apply.

This needs a second credential. An auth key (`tskey-auth-…`) authenticates a device registration and
nothing else - only an API access token (`tskey-api-…`) can call the API - so the check asks for one,
and is off by default because it is the only thing in this app that reaches Tailscale on its own.
Read access to keys is enough. The tailnet field is `-` for the token's own tailnet, which is right
unless you administer several.

> **With the check off, nothing can tell a revoked key from a working one.** The first sign is a
> failed apply, and until the key is fixed no proxy host on any agent can be updated. That is the
> trade: an outbound request to Tailscale on save, against discovering a dead key at the worst
> moment.

Some keys cannot be checked even with it on - an older `tskey-<secret>` key, a Headscale key, or a
Caddy placeholder - because none of them carries an id the API can address. Those save with a note
in the log rather than being refused: the format is not a documented contract, and guessing wrong
would reject a key that works. If the API cannot be reached at all, the save **is** refused, since
letting it through would quietly defeat the point of turning the check on.

### The plugin is on a fork

`docker/caddy/go.mod` points `caddy-tailscale` at a fork of upstream's own `main` plus the one
commit proposed in [tailscale/caddy-tailscale#142](https://github.com/tailscale/caddy-tailscale/pull/142),
which fixes a crash and is not merged yet.

A node is not started until something uses it, and a node named only by the reverse-proxy transport
is not used until the first request goes through it. Releasing one in that state crashed Caddy from
inside `tsnet`: `tailscaleNode.Destruct` calls `tsnet.(*Server).Close`, which is documented as unsafe
before `Start` and dereferences state that only `start()` creates. Caddy releases the previous
configuration's modules after every reload and again on shutdown, so a single host dialling over the
tailnet took the admin API down on the apply that stopped using it - reporting failure across the
fleet when the configuration had in fact been applied - and turned every container stop into a
crash. `CertDomains` had the same flaw, reached on every TLS handshake, so one idle node would break
certificates for all of them.

The commit records whether `Start` ever returned successfully and consults that in both places. With
it, four cases that used to crash are clean: the reload that stops using a node, shutdown, `caddy
validate`, and a load that fails on a bad auth key - which now exits 1 with the Tailscale error
instead of 2 with a stack trace.

Nothing else guards against this, so keep the `replace` directive until the PR merges.
`docker/caddy/go.mod` says as much beside it.

### What happens if the module is missing

Tailscale is a Caddy plugin, so it has to be in the binary. It is in the default image, but if it is
switched off in **Settings → Caddy build** - or switched back on and not rebuilt yet - a host set to
**tailnet only** is dropped from the configuration entirely rather than published on the public
listener. Serving something meant to be private to the internet is the one failure mode worth an
outage; the reason is logged, and everything else keeps serving.

L4 proxy hosts are not on the tailnet - only HTTP proxy hosts are.

---

## Two-factor sign-in

Any account with a password can turn it on from **Profile**: the password, a QR code for an
authenticator app, one code, and then ten backup codes shown once. Sign-in then asks for a code
after the password, on the dashboard and the forward-auth portal alike, and a backup code works in
its place once. The dashboard can skip the code on a trusted device for 30 days; the portal always
asks.

**Settings → Authentication → Two-factor sign-in** sets the policy: nobody, administrators, or
every account with a password must have a second factor, and an authenticator app or a passkey
satisfies it. An account the policy reaches gets a grace period (0-90 days, 7 by default, counted
from the policy change or the account's creation, whichever is later) with a banner naming the
date; after it, the dashboard sends them to setup and their session's REST and GraphQL calls answer
403. An account that signs in only through OAuth or a directory is left to its identity provider,
and API tokens are credentials of their own that keep working. The older "require for
administrators" switch is the administrators policy, enforced at once. `cpm-server
--lift-mfa-policy` turns it off from inside the container - see [Runtime](#runtime).

An admin resets another user's two-factor sign-in from **Users**, which also signs them out. With no
other admin to ask, `cpm-server --reset-2fa` does it from inside the container - see
[Runtime](#runtime).

### Passkeys

**Profile → Passkeys** adds a passkey, and the sign-in screen and portal sign in with one - no
username, no password. The authenticator has to verify the person (a PIN, fingerprint or face), so a
passkey counts as both factors, never asks for a code, and satisfies the two-factor policy. A passkey belongs to the Public URL's hostname: it needs HTTPS (or
`localhost`), and changing that hostname orphans every one registered. Adding one needs a sign-in
from the last ten minutes. Passkey sign-in skips the CAPTCHA and the per-account lockout, which
guard password guessing, and stays under Better Auth's per-address request limit. Admins remove a
user's passkeys from **Users**; `--reset-2fa` removes them too. Off in OIDC-only mode.

### LDAP and Active Directory

**Settings → Authentication → Directories (LDAP)** adds an LDAP or Active Directory server; there
are no environment variables for it. Its users sign in on the normal form and the forward-auth
portal: with one directory the form tries a local account first and then the directory, with
several it shows a selector. A service account searches with an escaped user filter that must match
exactly one entry, or CPM binds as the user with no service account: a DN template, or for Active
Directory a UPN (`{username}@realm`) or down-level name, whose found entry must be the account that
bound (these two need TLS). The connection is `ldaps://` or StartTLS, verified, with an
optional CA certificate; a refused StartTLS fails closed. The first sign-in creates the account
when first-time OAuth identities may create one, tied to `objectGUID`/`entryUUID`; an existing
account with the same email is only joined with **Link accounts by email** on. Directory accounts
have no local password. Groups (`memberOf`, or a search, nested on AD) map to roles and CPM groups as
an OAuth claim does. Throttle, CAPTCHA, two-factor code and audit apply as for a password, and every
refusal reads "Invalid username or password". **Test** reports which step failed.

---

## OAuth authentication

CPM supports any OIDC-compliant provider (Authentik, Keycloak, Auth0, etc.). Configure providers through environment variables or in **Settings → Authentication → Single sign-on providers**.

### Option A: Configure in the UI (recommended)

1. Sign in as an admin and open **Settings → Authentication → Single sign-on providers**
2. Click **Add provider** and fill in the details
3. Copy the displayed **Callback URL** and add it to your OAuth provider's allowed redirect URIs

### Option B: Configure with environment variables

```bash
# Set your public URL (REQUIRED for OAuth to work)
BASE_URL=https://caddy-manager.example.com

OAUTH_ENABLED=true
OAUTH_PROVIDER_NAME="Authentik"  # Display name
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_ISSUER=https://auth.example.com/application/o/app/
```

**Redirect URI configuration:**

The callback URL format is:

```text
{BASE_URL}/api/auth/callback/{provider-id}
```

For environment-configured providers, the provider ID is derived from `OAUTH_PROVIDER_NAME` (lowercased, non-alphanumeric replaced with `-`). The exact callback URL is shown in **Settings → Authentication → Single sign-on providers** after the provider is synced.

Examples:

- `https://caddy-manager.example.com/api/auth/callback/authentik-QXV0aG` (production)
- `http://localhost:3000/api/auth/callback/authentik-QXV0aG` (development)

The `BASE_URL` environment variable must match exactly where users access your dashboard.

> **Upgrading from < 1.0-RC:** The old callback URL (`/api/auth/callback/oauth2`) no longer works. Update your OAuth provider's redirect URI to the new format shown in **Settings → Authentication → Single sign-on providers**.

> **Upgrading to better-auth 1.7:** The callback URL changed again, from
> `/api/auth/oauth2/callback/{provider-id}` to `/api/auth/callback/{provider-id}`.
> Generic OAuth providers are now registered as first-class social providers and
> are served by the core callback endpoint, so the old plugin-specific path no
> longer exists. Update the redirect URI at your identity provider, or OAuth
> sign-in will fail with a redirect-URI mismatch. The current value is always
> shown in **Settings → Authentication → Single sign-on providers**.

The login page offers OAuth sign-in alongside the username and password form.

### Back-channel logout

CPM implements [OIDC Back-Channel Logout 1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html), so an identity provider can end a user's CPM sessions when it ends their SSO session - an administrator revoking access, a sign-out at another application, or a disabled account.

Register this as the provider's **back-channel logout URL**:

```text
{BASE_URL}/api/auth/oidc/backchannel-logout
```

It is also shown in **Settings → Authentication → Single sign-on providers**, beside the callback URL. One URL serves every configured provider: the logout token names its own issuer, and that selects the provider whose client ID and signing keys it is checked against.

The endpoint is optional - nothing else changes if you do not configure it - and unauthenticated by design, because the caller is the provider's server rather than a browser. The signed token is the whole of the authentication, so it is rejected unless it verifies against the issuer's published JWKS, carries that provider's client ID as its audience, names a back-channel logout in its `events` claim, carries no `nonce`, was issued within the last five minutes, and has a `jti` that has not been seen before.

What it ends:

- A token carrying a `sid` ends exactly the CPM session that came from that IdP session, leaving the user's other devices signed in. This needs a provider that puts `sid` in its ID tokens; most do.
- A token carrying only a `sub` ends every CPM session for that identity, because there is nothing finer to go on.
- Either way, the user's **forward-auth sessions** for proxied hosts are dropped too. Those are minted from a CPM session but outlive it, so a proxied host would otherwise keep letting the user in after their SSO session ended.

Failures answer `400` with an `error_description` naming the check that failed. A token for someone who was never signed in answers `200` - there is nothing to do, and reporting that as an error would have the provider retry indefinitely.

**Account linking:**

A signed-in user can always attach an OAuth identity to their own account from **Profile → OAuth connections**, whatever the provider's settings. Their session proves who owns the CPM account and the provider login proves the identity, so the provider's email does not have to match - which is what lets the administrator setup creates (`name@localhost`) link one at all.

**Auto-link accounts** (**Settings → Authentication → Single sign-on providers**, or `OAUTH_ALLOW_AUTO_LINKING=true` for environment-configured providers) governs only what happens when someone *signs in* through the provider and a CPM user already has the same email address:

- **On:** the sign-in links the identity to that existing user. The switch marks the provider as trusted to prove its identity owns the CPM account carrying that email, so leave it off for any IdP where users can register an arbitrary email themselves.
- **Off:** the sign-in is refused, and the user links the provider from their profile instead.

With it disabled, both paths are refused and the provider redirects to `/api/auth/error?error=account_not_linked`.

### Group-based roles

CPM can take a user's role from their identity provider's group claim instead of
managing it by hand. Configure it per provider in **Settings → Authentication → Single sign-on
providers → Group mapping**, or with the `OAUTH_*` variables for the env-configured provider.

There are two equivalent ways to say which groups grant which role. Use whichever
matches how your directory is already organised.

**Name the groups directly.** Each role takes any number of groups, comma-separated,
written exactly as your provider reports them:

```bash
OAUTH_SCOPES="openid email profile groups"   # ask the IdP for the claim
OAUTH_GROUPS_CLAIM=groups                    # dots address nested claims
OAUTH_ROLE_MAPPING=true
OAUTH_ADMIN_GROUP="platform-owners, sre-oncall"
OAUTH_OPERATOR_GROUP="proxy-ops"
OAUTH_USER_GROUP="staff"
OAUTH_VIEWER_GROUP="auditors, contractors"
OAUTH_DEFAULT_ROLE=user
```

Membership of *any one* of a role's groups grants it, so several unrelated groups can
map to the same role.

**Or use a prefix**, if your groups already share one. CPM then derives all four
names for you:

| Group (prefix `CPM_`) | CPM role |
| --------------------- | -------- |
| `CPM_Admin` | admin |
| `CPM_Operator` | operator |
| `CPM_User` | user |
| `CPM_Viewer` | viewer |

```bash
OAUTH_GROUP_PREFIX=CPM_
OAUTH_ROLE_MAPPING=true
```

The two mix freely: a role with its own group names ignores the prefix, and a role
left unset falls back to it. So `OAUTH_GROUP_PREFIX=CPM_` together with
`OAUTH_ADMIN_GROUP=platform-owners` means admins come from `platform-owners` while
the rest still come from `CPM_Operator`, `CPM_User` and `CPM_Viewer`.

Where two of a user's groups map to different roles the more privileged one wins, in the order
admin, operator, user, viewer - so losing the admin group demotes an account to operator rather
than all the way down.

`OAUTH_DEFAULT_ROLE` decides the role for users in none of the role groups: `admin`, `operator`,
`user` or `viewer`, and anything else counts as `user`.

Notes:

- **The IdP becomes authoritative.** With role mapping on, a user who loses
  `CPM_Admin` is demoted at their next sign-in. The last remaining active admin is
  never demoted, so a mistake in the IdP cannot lock you out.
- **Roles are applied at sign-in**, not continuously. A group change in the IdP
  takes effect when the user signs in again.
- **Matching is case-insensitive** and tolerates Keycloak-style group paths
  (`/Parent/CPM_Admin` matches `CPM_Admin`).
- **The most privileged match wins.** A user in both the admin and viewer groups is
  an admin.
- The claim may be an array of strings, an array of objects, a comma-separated
  string, or a JSON-encoded array. Nested claims use a dotted path, e.g.
  `resource_access.cpm.roles`.
- Groups are read from the ID token, falling back to the userinfo endpoint when the
  claim is not in the token. Remember to request the scope that carries it.

### Mirroring groups

With `OAUTH_SYNC_GROUPS=true` (or the **Mirror groups into CPM groups** switch), the
remaining prefixed groups become CPM groups with the prefix stripped -
`CPM_Devs` → `Devs` - so IdP groups can drive [forward auth](#forward-auth-portal)
access control. Membership of these groups is reconciled on every sign-in. Groups
you created yourself keep `source=ui` and are never modified by the sync; if a
mirrored name matches one of them, the user is added to it but never removed.

### OIDC-only mode

Turn on **Settings → Authentication → Sign-in → OIDC-only mode**, or set
`AUTH_DISABLE_LOCAL_USERS=true`, to hand identity entirely to your IdP:

- No bootstrap admin is created, and `ADMIN_USERNAME` / `ADMIN_PASSWORD` are not
  required at startup, even in production.
- Credential sign-in is turned off in Better Auth, and the username/password form
  disappears from both the login page and the forward auth portal.
- Creating local users and setting or changing passwords is rejected in the UI and
  the REST API.
- OAuth self-provisioning is on by default, since the IdP is the only way an
  account can come into existence. Clear **Allow OAuth registration**, or set
  `AUTH_ALLOW_OAUTH_REGISTRATION=false`, to restrict sign-in to accounts that
  already exist.

```bash
AUTH_DISABLE_LOCAL_USERS=true
OAUTH_ENABLED=true
OAUTH_ISSUER=https://auth.example.com/application/o/cpm/
OAUTH_CLIENT_ID=your-client-id
OAUTH_CLIENT_SECRET=your-client-secret
OAUTH_SCOPES="openid email profile groups"
OAUTH_GROUP_PREFIX=CPM_
OAUTH_ROLE_MAPPING=true
```

> Configure and verify the provider **before** enabling this. With no enabled OAuth
> provider there is no way to sign in; CPM logs a warning at startup, and the only
> recovery is to fix the provider through the `OAUTH_*` environment variables.

---

## Forward auth portal

CPM includes a built-in forward auth identity provider, so you need no external IdP (Authentik, Authelia, etc.).

### How it works

1. Enable **Forward auth** on a proxy host and choose which users or groups may access it.
2. Unauthenticated visitors are redirected to the CPM login portal.
3. After login, CPM issues a session cookie and redirects back to the protected app.
4. Caddy's `forward_auth` directive validates every subsequent request against CPM.

### Groups

Create groups on the **Groups** page to organise users. When you grant a group access to a proxy host, all current and future members of that group gain access automatically.

### Per-host access control

Each forward-auth-protected host has its own access list of allowed users and/or groups. Access is separate from the user's role - even admins must be explicitly granted access.

---

## Roadmap

[Open an issue](https://github.com/CaddyProxyManager/caddy-proxy-manager/issues) for feature requests.

---

## Contributing

Contributions welcome:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/name`)
3. Commit changes (`git commit -m 'Add feature'`)
4. Push to branch (`git push origin feature/name`)
5. Open a pull request

- Follow the existing code style - `bun run lint` and `bun run format` run Biome, which is the formatter here
- Add tests for new features when applicable
- Update documentation for user-facing changes
- Keep commits focused and write clear commit messages

---

## Support

- **Documentation:** [caddyproxy.com](https://caddyproxy.com/)
- **Issues:** [GitHub Issues](https://github.com/CaddyProxyManager/caddy-proxy-manager/issues) for bugs and feature requests

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- **[Caddy Server](https://caddyserver.com/)** - The web server this project manages
- **[Nginx Proxy Manager](https://github.com/NginxProxyManager/nginx-proxy-manager)** - The original project
- **[Next.js](https://nextjs.org/)** - React framework for production
- **[Astryx](https://www.npmjs.com/package/@astryxdesign/core)** - The component library the dashboard is built from
- **[Drizzle ORM](https://orm.drizzle.team/)** - Lightweight SQL migrations and type-safe queries

---

<div align="center">

[⬆ back to top](#caddy-proxy-manager)

</div>
