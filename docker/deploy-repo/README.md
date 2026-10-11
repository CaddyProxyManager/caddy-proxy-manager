# Caddy Proxy Manager - deployment

Everything needed to run [Caddy Proxy Manager](https://caddyproxy.com/) with Docker Compose, one
commit per release. The images are pinned to that release, so nothing moves until you pull.

This repository is generated from each release of
[CaddyProxyManager/caddy-proxy-manager](https://github.com/CaddyProxyManager/caddy-proxy-manager).
Report issues and send changes there.

## Install

Clone it into a directory named `caddy-proxy-manager`. Compose names the project after the
directory, and the volumes after the project, so the name is what keeps your data across upgrades.

```bash
git clone https://github.com/CaddyProxyManager/deploy.git caddy-proxy-manager
cd caddy-proxy-manager
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
```

On `main` and `next`, add a PostgreSQL password before starting:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" >> .env
```

The `nodb` and `nodb-next` branches omit the bundled PostgreSQL server. Configure an external
PostgreSQL server before starting:

```bash
echo 'POSTGRES_HOST=db.example.com' >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 32)" >> .env
```

The default port, user, and database are `5432`, `cpm`, and `cpm`. Set `POSTGRES_PORT`,
`POSTGRES_USER`, `POSTGRES_DB`, or `POSTGRES_SSL` in `.env` to change them. SQLite is rejected in
production.

Then start the stack:

```bash
chmod 600 .env
docker compose up -d
```

Then open `http://localhost:3000`. The [install guide](https://caddyproxy.com/start/install/) explains
each step.

## Upgrade

```bash
git pull
docker compose pull
docker compose up -d
```

Settings tells you when a release is out. Read its notes before pulling; a release that needs a
step of its own says so.

## Local changes

Never edit the tracked files - put changes in `docker-compose.override.yml`, which Compose merges over
`docker-compose.yml` and the agent applies when it starts Caddy. It and `.env` are ignored, so
`git pull` never conflicts with them.

```yaml
# docker-compose.override.yml
services:
  web:
    ports: !override
      - "127.0.0.1:3000:3000"
```

## Channels

- `main` - stable releases only.
- `next` - every release, prereleases included: `git checkout next`.
- `nodb` - stable releases without a bundled database; requires external PostgreSQL.
- `nodb-next` - every release without a bundled database; requires external PostgreSQL, prereleases included: `git checkout nodb-next`.

Every release is also a tag, so `git checkout v3.6.1` pins one.
