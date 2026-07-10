# Arc Launchpad

A self-hosted web UI for [Arc](https://github.com/Basekick-Labs/arc) — the high-performance columnar analytical database.

Arc Launchpad connects to one or more existing Arc instances and gives you a browser-based interface for running SQL, exploring schemas, browsing logs, managing tokens and retention policies, setting up alerts and continuous queries, and inviting teammates into shared organizations.

It does **not** provision or host databases. You point it at Arc instances you already run (by endpoint URL + admin token), and it stores only those connection details plus your accounts/teams in a local SQLite database.

## Features

- **SQL console** with schema explorer, query history, and multi-tab editing
- **Logs viewer** with pattern detection and trace extraction
- **Token management** and retention policies for your Arc instances
- **Alerts** and **continuous queries**
- **Organizations & teams** — invite users, assign roles
- **Local auth** — email/password with optional MFA (TOTP) and passkeys (WebAuthn)

## Tech stack

- **Runtime:** SvelteKit + Node.js (adapter-node)
- **Storage:** SQLite (accounts, teams, connection records)
- **Auth:** session JWTs, bcrypt password hashing, optional TOTP MFA + WebAuthn passkeys

## Quick start (local)

Requires Node.js 20+.

```bash
npm install
cp .env.example .env        # then edit .env — set LAUNCHPAD_JWT_SECRET at minimum
npm run dev                 # http://localhost:5173
```

The **first account you create becomes the admin.** After that, self-service signup is closed — additional users join by admin invitation only.

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full annotated list. The only strictly required variable is:

| Variable | Purpose |
|---|---|
| `LAUNCHPAD_JWT_SECRET` | Secret used to sign session tokens. **The app refuses to start in production without it.** Generate one with `openssl rand -hex 32`. |

Email (Mailgun), signup CAPTCHA (Cloudflare Turnstile), ops alerting (Google Chat), and Google OAuth are all **optional** — without them, those features are simply skipped (e.g. emails print to the console instead of being sent).

### Connecting to an Arc instance on a private network

By default, Launchpad **rejects Arc endpoints that resolve to a private, loopback, or link-local address** (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `*.internal`, cloud metadata, …). This is an SSRF safeguard: the built-in proxy forwards requests to whatever endpoint you register, so untrusted endpoints must not be able to reach internal services.

If your Arc server legitimately runs on a private network reachable from the Launchpad host — e.g. on the same box (`http://localhost:8000`), the same Docker network, or the same Kubernetes cluster — set:

| Variable | Purpose |
|---|---|
| `LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS` | Set to `true` to allow registering Arc instances on private/localhost addresses. Default `false` (blocked). Even when enabled, the proxy still resolves-and-pins the target IP per request (DNS-rebinding safe). |

Without it, registering (or health-checking) a private Arc endpoint fails with a "private/localhost endpoint blocked" error.

## Production build

```bash
npm run build
LAUNCHPAD_JWT_SECRET=$(openssl rand -hex 32) node build
```

The server listens on `$PORT` (default `3000`).

## Docker

Use the published image (`latest`, or pin a version tag from the [releases](https://github.com/basekick-labs/launchpad/releases)):

```bash
docker run -p 3000:3000 \
  -e LAUNCHPAD_JWT_SECRET=$(openssl rand -hex 32) \
  -v launchpad-data:/app/data \
  ghcr.io/basekick-labs/launchpad:latest
```

The SQLite database is written to `/app/data/launchpad.db` — mount a volume there to persist it.

> If your Arc instance is on a private network reachable from the container (same host/Docker network), add `-e LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS=true` (see [Configuration](#configuration)). Note that `localhost` inside the container is the container itself — reach a host-side Arc via `host.docker.internal` or the host's LAN IP.

## Docker Compose

```bash
curl -O https://raw.githubusercontent.com/basekick-labs/launchpad/main/docker-compose.yml
LAUNCHPAD_JWT_SECRET=$(openssl rand -hex 32) docker compose up -d
```

The compose file uses `ghcr.io/basekick-labs/launchpad:latest` and a named volume for the data.

## Helm

```bash
helm install launchpad oci://ghcr.io/basekick-labs/charts/launchpad \
  --set jwtSecret=$(openssl rand -hex 32) \
  --set baseUrl=https://launchpad.example.com
```

Or from a release chart archive:

```bash
# grab launchpad-<version>.tgz from the latest GitHub Release
helm install launchpad ./launchpad-*.tgz --set jwtSecret=$(openssl rand -hex 32)
```

Common values (see [`helm/launchpad/values.yaml`](helm/launchpad/values.yaml) for the full list):

| Value | Default | Purpose |
|---|---|---|
| `jwtSecret` | `""` | **Required** unless `existingSecret` is set. Signs session tokens. |
| `existingSecret` | `""` | Name of a pre-created Secret holding `LAUNCHPAD_JWT_SECRET` instead. |
| `baseUrl` | `http://localhost:3000` | Public URL (email links + passkey origin). |
| `persistence.size` | `1Gi` | PVC size for the SQLite database. |
| `ingress.enabled` | `false` | Enable to expose via an Ingress. |

## Connecting to an Arc instance

After signing in, add a connection with your Arc instance's endpoint URL (e.g. `http://localhost:8000`) and an admin token. Arc Launchpad verifies the connection and then lets you query and manage that instance.

## License

[Apache-2.0](LICENSE).
