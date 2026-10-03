# Docker integration test suite

A complete, self-contained caddy-proxy-manager deployment on an isolated Docker
network, driven from a separate client container that exercises the proxy the
way a real user would - over DNS, TLS, HTTP, WebSockets, and raw TCP/UDP.

Nothing here mocks anything. The Caddy under test is the project's own image,
the web app is the project's own image, certificates are issued by a real ACME
server over a real HTTP-01 challenge, and every assertion is made from outside
the system, over the wire.

```bash
./run.sh
```

The first run builds Caddy from source with its plugin set and can take several
minutes. Afterwards a full pass is a couple of minutes.

A full run is several hundred assertions, all green. Its first run
was not - see [What the rig has caught](#what-the-rig-has-caught).

## What the rig looks like

Everything lives on one bridge network, `172.28.0.0/24`, declared
`internal: true` - the containers can reach each other and nothing else. No host
ports are published. That restriction is not incidental: it is what proves the
certificate tests are talking to the in-network CA rather than quietly reaching
a public one, and the suite asserts the isolation before it asserts anything
else.

| Container    | Address       | Role                                                        |
| ------------ | ------------- | ----------------------------------------------------------- |
| `certgen`    | `172.28.0.4`  | one-shot: mints the rig's fixed PKI, then exits              |
| `dns`        | `172.28.0.5`  | dnsmasq - `*.cpm.test` → Caddy, everything else → Docker DNS |
| `coredns`    | `172.28.0.6`  | `dyn.cpm.test`, a zone the tests rewrite at run time          |
| `caddy`      | `172.28.0.10` | **system under test** - the project's Caddy image            |
| `web`        | `172.28.0.11` | **system under test** - the project's CPM image              |
| `postgres`   | DHCP          | the controller's database - the only backend since 3.0       |
| `origin-a`   | `172.28.0.20` | L7 HTTP origin                                               |
| `origin-b`   | `172.28.0.21` | L7 HTTP origin, second identity for load-balancing tests     |
| `origin-tls` | `172.28.0.22` | L7 HTTPS origin with a deliberately mismatched certificate   |
| `origin-tcp` | `172.28.0.23` | L4 TCP echo - no HTTP awareness at all                       |
| `origin-udp` | `172.28.0.24` | L4 UDP echo                                                  |
| `anubis`     | `172.28.0.25` | Anubis in subrequest mode, for the bot challenge            |
| `acme-dns`   | `172.28.0.27` | acme-dns, authoritative for `acmedns.cpm.test`, for DNS-01 delegation |
| `pebble`     | `172.28.0.30` | ACME certificate authority                                   |
| `runner`     | `172.28.0.40` | **simulated client** - the only container that runs tests    |
| `agent`      | `172.28.0.12` | agent phase only: an agent in external build mode            |
| `crowdsec-lapi` | `172.28.0.26` | agent phase only: an operator's own CrowdSec, for external mode |
| `crowdsec`   | DHCP, alias `cpm-crowdsec` | agent phase only: the managed CrowdSec, started by the agent |
| `docker-socket-proxy` | own network | agent phase only: the agent's Docker API, BuildKit denied |
| `runner-docker-proxy` | own network | agent phase only: the runner's Docker API, for `cscli` and a retag |

### The destinations

caddy-proxy-manager proxies at two layers, and the rig provides a destination
for each:

- **Layer 7** - `origin-a`, `origin-b` and `origin-tls` speak HTTP. They reflect
  the request back as JSON: the `Host` they were given, every header the proxy
  added, the address the connection came from, the body. That is what lets a
  test assert *how* a request was proxied, not merely that it arrived.
- **Layer 4** - `origin-tcp` and `origin-udp` are byte-level echo servers with
  no notion of HTTP. They exist so the stream proxy can be tested for what it
  actually is: a socket relay, with no request/response framing to lean on.

All five are one small standard-library Python script
(`images/backend/server.py`) run in different modes. The HTTP ones also keep the
last 500 requests they served at `GET /__requests`, so a test can prove a
request never arrived, or read what a subrequest carried.

### Certificates

There is no route to Let's Encrypt, so the rig runs [Pebble][pebble] as its CA
and CPM is pointed at it through the ACME settings the product already exposes
(`caUrl` + `caRootPem`). Pebble is told to validate challenges on ports 80 and
443 against Caddy, and to resolve names through the same dnsmasq the client
uses. Certificate issuance in this suite is therefore a genuine ACME order with
a genuine challenge - the only thing that is fake is who signs it.

Two CAs are in play, and they are unrelated:

- `certgen` mints the CA that signs **Pebble's own HTTPS endpoint**, because
  Caddy has to trust something to talk ACME over TLS. This is what gets handed
  to CPM as `caRootPem`.
- **Pebble** generates its own issuing root at startup. The client fetches it
  from Pebble's management API during bootstrap and adds it to the trust store
  it verifies Caddy against.

DNS-01 is real too. dnsmasq forwards two subzones: `dyn.cpm.test` to CoreDNS, which serves a
zone file the runner rewrites (`rig_dns_set` in `suite/lib.sh`), and `acmedns.cpm.test` to acme-dns.
An `_acme-challenge` CNAME in the first pointing into the second is followed by CoreDNS, which
dnsmasq cannot do for a name it forwards, so Pebble - asking dnsmasq - reads the TXT acme-dns
holds. `web` and `caddy` resolve through dnsmasq as well, as a host would through its own DNS: the
delegation check looks CNAMEs up from the controller, and certmagic dials the nameserver its
propagation check finds by name.

[pebble]: https://github.com/letsencrypt/pebble

## Running

```bash
./run.sh                    # everything, then tear down
./run.sh mtls l4            # only files whose name matches a pattern
./run.sh --keep             # leave the rig up afterwards
./run.sh --shell            # a shell in the client container
./run.sh --logs caddy       # tail a service
./run.sh --down             # tear down, volumes included
./run.sh --rebuild          # rebuild images from scratch
./run.sh --no-agent         # skip the agent phase
./run.sh external           # only the agent phase (a filter matching agent-tests/ only)
```

Two feature areas can be switched off when they are not the point of the run:
`--no-geoblock` and `--no-waf`.

Inside the client container the suite is at `/suite`, so with `--keep` you can
iterate without restarting anything:

```bash
docker compose exec runner bash /suite/run-tests.sh 25
```

Test files are ordinary bash. Editing one on the host takes effect immediately -
`/suite` is a bind mount.

## What is covered

| File                       | Area                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `00-infrastructure`        | DNS, network isolation, every destination reachable, admin-API origin pinning          |
| `05-api-auth`              | bearer tokens, token lifecycle, role enforcement, CSRF on session writes               |
| `10-proxy-hosts`           | CRUD, proxying, forwarded headers, upstream changes, disable/delete, input validation   |
| `15-tls-certificates`      | ACME issuance, multi-domain hosts, imported certificates, wildcards                    |
| `17-dns-challenge-delegation` | DNS-01 through a CNAME into a real acme-dns: an account and a delegation with a target (`override_domain`) over REST, Register with acme-dns, Apply and the delegation check through the dashboard's server actions, a name and its wildcard on one account |
| `20-http-behaviour`        | sslForced, HSTS, host header handling, WebSockets, HTTPS upstreams                     |
| `22-response-shaping`      | zstd/gzip compression, X-Robots-Tag and robots.txt, maintenance 503s and bypass, upstream timeouts |
| `23-bot-challenge`         | Anubis: redirect and redir escaping, a solved proof of work, ALLOW/DENY, exempt paths, client address, the check subrequest |
| `25-routing-rules`         | location rules, redirects, prefix rewrite, path blocks/allows/rewrites, error pages    |
| `30-access-lists`          | HTTP basic auth, live credential add/remove, detaching                                 |
| `32-access-list-hostnames` | a hostname in an IP rule on HTTP and L4 hosts: resolved on save, a changed record picked up by the refresher, the last answer kept when the name stops resolving |
| `35-load-balancing`        | round robin, first-available, ip_hash, active health checks, per-location balancing    |
| `40-mtls`                  | CA + client certs, roles, full/whitelist/exclusion modes, per-path RBAC, revocation    |
| `45-l4-proxy`              | TCP and UDP streams, connection matchers, shared listeners, port ranges, disable, validation |
| `47-l4-proxy-protocol`     | access-list IP rules and IP blocking on L4 hosts: the PROXY header's source behind PROXY protocol, the connection's own address without it |
| `50-geoblock`              | per-host and global IP/CIDR blocking, allow-over-block, override mode                  |
| `55-waf`                   | Coraza rules, DetectionOnly, global/host merge, directive allowlist, WebSocket carve-out |
| `60-forward-auth`          | portal bounce, full login round-trip, identity headers, header spoofing, revocation    |
| `65-settings-and-admin`    | every settings group, metrics listener, groups, sessions, audit log, OpenAPI           |
| `agent-tests/70-external-build` | agent phase: self-pairing, external build mode, Load built image onto an image with fewer modules |
| `agent-tests/76-rate-limit` | agent phase: 429 and Retry-After, per-client buckets, trusted proxies and X-Forwarded-For, ip+path, path-scoped zones, the host's 429 page, the window running out |
| `agent-tests/80-crowdsec` | agent phase: external LAPI - ban, throttle and captcha decisions on HTTP and L4 hosts, opting out, AppSec virtual patching, a scenario tripped by Caddy's access log |
| `agent-tests/85-crowdsec-managed` | agent phase: managed mode - the agent starts the `crowdsec` profile with the generated key, the online API stays off, managed AppSec, back to external stops it |
| `agent-tests/90-certificate-files` | agent phase: a certificate from files in certbot's layout (`CERT_FILES_HOST_DIR`), served on a pinned host; a renewal re-read without a restart, a mismatched key and a link out of the directory keeping the last good one |

### The agent phase

The main suite runs with no agent, so it is followed by a second phase that starts one:
`agent` and a `docker-socket-proxy` with `GRPC` and `SESSION` at `0`, so BuildKit is out of
reach. The agent pairs itself with the bootstrap token `web` leaves on its volume, as the bundled
agent does, and runs in external build mode (`CADDY_BUILD_MODE=external`). `run.sh` builds
`cpm-test/caddy:external` beforehand from the same Dockerfile with a single DNS module, standing
in for the image an operator builds, and the test loads it through `POST /api/caddy-build/image`.

The swap drops every module the rig's own image carries, so it covers the case a careless load
would break: Caddy resumes from an autosaved config, and exits on one naming a module the binary
lacks. The agent narrows the applied set first, the controller pushes a config without the
dropped modules, and only then is Caddy recreated. The test checks the applied set is the new
image's own list and that a host created before the swap still serves after it.

It runs last because pairing moves every admin call onto the agent. The files live in
`suite/agent-tests/`, which the main pass never reads.

#### Opt-in modules

Rate Limit and CrowdSec are not in the shipped image, and without an agent the controller assumes
the shipped list, so both are tested in this phase. `run.sh` builds `cpm-test/caddy:opt-in` from
the Dockerfile's own default list plus the two, so it cannot drift from the shipped one.
`helpers/opt-in-caddy.sh` then does what an operator would: selects the modules in Settings → Caddy
Build, rebuilds under the tag the agent runs (a `docker tag` onto `cpm-test/caddy:external`) and
loads it. The agent reads both off the image's `caddy-modules.txt`, and nothing in the controller
is told anything else. Each file calls it, so any one can run alone.

The runner reaches Docker for this and for `cscli` through `runner-docker-proxy`, on a network of
its own. CrowdSec's image is built from the digest `docker-compose.yml` pins, with the hub content
baked in, since the rig has no egress. It also drops `crowdsecurity/whitelists`, which ignores
private addresses and so every client the rig has. `crowdsec-lapi` stands in for an operator's
CrowdSec; the managed `crowdsec` service is `docker-compose.yml`'s, started by the agent itself.

### What the rig has caught

**Forward auth never sent identity headers to the upstream.** CPM's forward auth
asks `/api/forward-auth/verify` who the user is and copies the answer onto the
upstream request as `X-CPM-User`, `X-CPM-Email`, `X-CPM-Groups` and
`X-CPM-User-Id`. The verify endpoint returned all four correctly; Caddy copied
none of them. The generated `handle_response` block read each value back through
`{http.reverse_proxy.header.X-CPM-User}`, and that placeholder does not
resolve - Go canonicalises the stored header key to `X-Cpm-User`, and Caddy
indexes the map with the literal name from the placeholder. Probing the running
config from inside the rig showed `{http.reverse_proxy.header.X-Cpm-User}`
returning the username while the all-caps spelling came back as its own literal
text. The `not vars … ""` guard around each copy then matched the empty string,
the route was skipped, and nothing was set at all - so every application behind
CPM forward auth saw an anonymous request.

Fixed in `apps/controller/src/lib/caddy.ts` by canonicalising the placeholder for
both the CPM and Authentik copy lists, and pinned at the unit level in
`apps/controller/tests/unit/caddy-forward-auth-copy-headers.test.ts`.

**The bot challenge sent the page's query to Anubis.** Caddy's `rewrite` keeps
the original query string unless the new URI names one, so every check went to
`/.within.website/x/cmd/anubis/api/check?<the visitor's query>`. Anubis answers a
passing check whose query holds `redir` with a redirect of its own, which Caddy
passed through: with a valid pass, `/login?redir=/account` never reached the
site. The check now rewrites to the endpoint with an empty query, pinned in
`apps/controller/tests/unit/caddy-anubis.test.ts`.

**A rig that cannot start catches nothing.** Between the compiled-binary change
and 2026-09-04 this one could not come up at all: `web`'s healthcheck ran `bun`,
which the runtime image stopped containing when its final stage became Debian
with `cpm-server` and nothing else. `runner` waits on that healthcheck, so the
whole run hung. Two suite files had drifted from the API in the meantime -
tokens became session-only to mint, and the geoblock settings group gained
required fields - and neither was noticed, because nothing was running. The
healthcheck is now the image's own probe, the same one `docker-compose.yml`
uses. Run it after anything that changes the images.

Two lesser things the rig documents rather than treats as bugs, both pinned so
a change to either is deliberate:

- `/api/waf-events`, `/api/geoip-status` and `/api/l4-ports` sit outside the
  session middleware's allowlist in `proxy.ts`, so a bearer token gets a 307 to
  the login page. They are UI-support endpoints, absent from the OpenAPI
  document, and each still enforces `requireApiAdmin` on its own.
- The Caddy admin API's `origins` list rejects a foreign `Origin` header but not
  a foreign `Host`: binding to an open interface makes Caddy skip Host checking
  entirely. What actually bounds reach is that port 2019 is never published.

**A frame the agent deferred was never applied.** The agent runs one operation at a time, and a
desired-state frame arriving while one ran was dropped on the assumption that another frame would
follow. None does until something changes: after an L4 host was deleted mid-recreate, Caddy kept
publishing its port, and switching CrowdSec to managed right after never started the container.
The agent now re-applies the newest frame when the operation ends (`apps/agent/src/lifecycle.ts`),
pinned in `apps/agent/tests/deferred-reconcile.test.ts`.

**A delegation with a target lost its acme-dns account.** The acme-dns module finds an account by
the name it writes, so the controller looked accounts up by the delegation's target - an
account's own fulldomain, which no account is keyed by. A delegation given its CNAME target next to
a registered account quietly dropped DNS-01, and a wildcard under it could not be issued. The
account registered for the delegation's domain now answers for its target
(`apps/controller/src/lib/dns-challenge-delegation.ts`), pinned in
`apps/controller/tests/unit/dns-challenge-delegation.test.ts`.

**GraphQL could not list agents.** `Agent.connected` is non-null in the schema and had no
resolver, so `{ agents { connected } }` failed the whole query. It now asks the registry, pinned in
`apps/controller/tests/integration/graphql-api.test.ts`; `90-certificate-files` reads the agent's
id through it.

### Known limits

- **Country, continent and ASN blocking** need MaxMind databases, which are a
  licensed download. `50-geoblock` asserts on CIDR and bare-IP rules, which go
  through the same handler and need no database. If the blocker plugin turns out
  to refuse a config without one, the file reports a skip with that reason
  rather than a failure.
- **OAuth/OIDC sign-in** would need an identity provider in the rig. The suite
  covers local credentials, bearer tokens, and forward auth; it does not cover
  the OIDC paths.
- **Authentik forward auth** would need an Authentik outpost. CPM's own forward
  auth, which shares the same route-building code, is covered end to end.
- **The dashboard host with a bot challenge** cannot be set up: no REST surface
  configures the dashboard host, and its editor drops the challenge. The Caddy
  builder's guard is covered by `caddy-anubis.test.ts` instead.
- **Analytics** (ClickHouse) is not started. `55-waf` checks that the WAF event
  endpoint answers, not that a specific event was ingested.
- The **agent** runs only in the agent phase, and only in external build mode.
  The main suite points `web` straight at Caddy's admin API with `CADDY_API_URL`,
  the no-agent path the controller keeps for this shape of deployment. So
  rebuilding the binary itself, parsing this host's logs into ClickHouse, the
  managed ClickHouse, and fanning one configuration out to several hosts are not
  exercised here; the e2e suite runs the bundled agent for most of that. Ports
  are republished only in passing, by `80-crowdsec`'s L4 host, and not asserted:
  the client is on the same network as Caddy, so it reaches stream listeners
  directly.
- **First-run setup and migration** are not reachable: `web` is given
  `ADMIN_USERNAME`/`ADMIN_PASSWORD`, so the setup flow is marked complete at
  startup, which is what every pre-3.0 deployment does. Those flows are covered
  in a browser instead - `apps/controller/tests/e2e/setup.spec.ts` and
  `setup-migrate.spec.ts`, each against its own empty database.

## How a test file is written

Each file sources `suite/lib.sh` and runs as its own bash process, so a crash
takes down that file and nothing else. Assertions record a result and keep
going rather than aborting, so one broken feature does not hide the state of the
rest. Everything a file creates is registered for teardown on exit, including
resources left behind by a create that failed after the row was written.

```bash
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

banner "my feature"

domain=$(domain_for "my-feature")
create_host_or_fail "a host can be created" "$(jq -nc --arg d "$domain" '{
  name: "docker-test my feature", domains: [$d], upstreams: ["origin-a:8080"]
}')" && pass "a host can be created"

wait_for_https "$domain"

fetch "https://$domain/some/path"
t_eq "the request is proxied" "200" "$FETCH_CODE"
t_eq "it reaches the right origin" "origin-a" "$(fetch_json '.origin')"

finish
```

Useful helpers, all in `suite/lib.sh`:

| Helper                            | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `api METHOD PATH [BODY]`          | call the CPM API; sets `API_STATUS` / `API_BODY`               |
| `api_session METHOD PATH [BODY]`  | same, but with the admin's browser session instead of a token  |
| `jqr EXPR [jq args]`              | jq over the last API response                                  |
| `create_host` / `create_l4_host`  | create and register for teardown; sets `NEW_ID`                |
| `fetch URL [curl args]`           | request through Caddy; sets `FETCH_CODE` / `FETCH_BODY` / …     |
| `http_code URL [curl args]`       | status only - `000` when the TLS handshake itself was refused  |
| `wait_for_https DOMAIN`           | block until a certificate has been issued and verifies         |
| `make_ca` / `issue_cert`          | local PKI for imported certificates and mTLS clients           |
| `rig_dns_set` / `rig_dns_del`     | records under `dyn.cpm.test`, waiting until CoreDNS serves them |
| `add_client_alias`                | a second source address (`$ALT_CLIENT_IP`) for IP rules        |
| `server_action PAGE ACTION …`     | call a dashboard server action as the admin, for flows with no REST route |
| `t_eq` / `t_contains` / `t_ok` / …| assertions that record rather than abort                       |

## Coverage

A full run ends with an API surface coverage report:

```
API surface coverage (documented operations driven over the wire)
  42/70 operations - 60%

  not exercised:
    GET    /api/v1/certificates
    PUT    /api/v1/mtls-roles/{id}
    DELETE /api/v1/sessions/{id}
    …

  exercised but not in the document:
    POST   /api/v1/users
    DELETE /api/v1/users/{id}
    POST   /api/v1/proxy-hosts/{id}/mtls-access-rules
    GET    /api/v1/dns-providers
    …
```

Line coverage is deliberately not attempted here. The application under test is
a bundled standalone server in another container; instrumenting it would mean
measuring something other than the artefact that ships. The useful question for
a black-box suite is how much of the declared REST surface it actually drove,
which is what this measures - against the running instance's own
`/api/v1/openapi.json`, so the report always describes the build under test.

Every call made through `api` or `api_session` is recorded and matched back to a
path template, so `/api/v1/proxy-hosts/42` counts towards
`/api/v1/proxy-hosts/{id}`. Calls that match no template are listed separately:
they are either endpoints missing from the OpenAPI document or a typo in a test,
and both are worth seeing.

It is a report, not a gate - `./run.sh mtls` legitimately touches less of the
surface, so a threshold would fail for the wrong reason. The report is skipped
entirely on a filtered run.

The second list is worth reading as carefully as the first. On its first run it
showed that `POST /api/v1/users`, `DELETE /api/v1/users/{id}`, the whole
`/api/v1/proxy-hosts/{id}/mtls-access-rules` path, `/api/v1/dns-providers` and
`/api/v1/oauth-providers` are all implemented and exercised but absent from the
OpenAPI document - i.e. the published API contract understates what the API
does. `/api/v1/oauth-providers` has since been documented; the rest are still
there. (`/api/geoip-status`, `/api/l4-ports` and `/api/waf-events` also appear,
but those are UI-support endpoints and are meant to be undocumented.)

For line coverage of the server-side library and API handlers, run the unit and
integration suites instead, from the repository root:

```bash
bun run test:coverage
```

That writes `coverage/lcov.info` and enforces the ratchet thresholds in
`apps/controller/scripts/coverage-ratchet.ts`.

## Debugging a failure

```bash
./run.sh --keep 40-mtls          # run one file, leave the rig up
./run.sh --logs caddy            # what Caddy thought of the config
./run.sh --logs pebble           # ACME orders and challenge results
./run.sh --shell                 # poke at it from the client's point of view
```

From inside the client container, the running Caddy config is the fastest way to
see what CPM actually generated:

```bash
curl -s http://caddy:2019/config/ | jq '.apps.http.servers.cpm.routes'
```
