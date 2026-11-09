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
| `LAUNCHPAD_PROXY_BODY_SIZE_LIMIT` | Raw proxy streaming limit in bytes. New default `8388608` (8 MiB); larger proxy payloads require an explicit override. |
| `BODY_SIZE_LIMIT` | Adapter declared-length limit. Set at least as high as the proxy limit; Docker and Helm align both to `8388608`. JSON/setup forms separately enforce 1 MiB. |

Email (Mailgun), signup CAPTCHA (Cloudflare Turnstile), ops alerting (Google Chat), and Google OAuth are all **optional** — without them, those features are simply skipped (e.g. emails print to the console instead of being sent).

### Connecting to an Arc instance on a private network

By default, Launchpad **rejects Arc endpoints that resolve to a private, loopback, or link-local address** (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `*.internal`, cloud metadata, …). This is an SSRF safeguard: the built-in proxy forwards requests to whatever endpoint you register, so untrusted endpoints must not be able to reach internal services.

If your Arc server legitimately runs on a private network reachable from the Launchpad host — e.g. on the same box (`http://localhost:8000`), the same Docker network, or the same Kubernetes cluster — set:

| Variable | Purpose |
|---|---|
| `LAUNCHPAD_ALLOW_PRIVATE_ENDPOINTS` | Set to `true` to allow registering Arc instances on private/localhost addresses. Default `false` (blocked). Even when enabled, the proxy still resolves-and-pins the target IP per request (DNS-rebinding safe), and cloud-metadata, link-local, unspecified and multicast addresses stay blocked. |
| `LAUNCHPAD_CLUSTER_NODE_CIDRS` | Comma-separated CIDRs Launchpad may contact for per-node metrics and logs of an Arc cluster (e.g. `10.42.0.0/16` for the k3s pod network). Default: only nodes on the instance endpoint's own /24 (IPv4) or /64 (IPv6). Set by the operator; tenants cannot widen it. |

Without it, registering (or health-checking) a private Arc endpoint fails with a "private/localhost endpoint blocked" error.

## Production build

```bash
npm run build
LAUNCHPAD_PROXY_BODY_SIZE_LIMIT=8388608 BODY_SIZE_LIMIT=8388608 LAUNCHPAD_JWT_SECRET=$(openssl rand -hex 32) node build
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
| `requestBodySizeLimit` | `8388608` | Proxy streaming and adapter declared-length limit in bytes. JSON API/setup forms enforce a separate 1 MiB limit. |
| `persistence.size` | `1Gi` | PVC size for the SQLite database. |
| `ingress.enabled` | `false` | Enable to expose via an Ingress. |

## Connecting to an Arc instance

After signing in, add a connection with your Arc instance's endpoint URL (e.g. `http://localhost:8000`) and an admin token. Arc Launchpad verifies the connection and then lets you query and manage that instance.

The token has to be an **admin** token, not a read-scoped one. Launchpad forwards it on every request, so Arc answers with that token's reach: a token Arc restricts to particular databases cannot enumerate them, and a token without read permission cannot query at all. Arc's refusals are passed back with their own status rather than flattened into a Launchpad error, so you see which one you hit.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get a change from idea to merged, and browse [`good first issue`](https://github.com/Basekick-Labs/launchpad/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) for scoped work with a clear starting point.

## License

[Apache-2.0](LICENSE). Contributions are covered by the [CLA](CLA.md).

## Request-body limits

JSON API writes and first-run setup forms are streamed with a **1 MiB** limit.
The Arc proxy accepts raw bytes (including msgpack/parquet and empty bodies)
with a separate **8 MiB** default, including requests without Content-Length.
Oversized bodies return 413 before forwarding to Arc.

This is a conservative Launchpad deployment limit, **not Arc's ingestion
limit**. Arc permits SQL up to 1 MiB; JSON escaping can expand that to 6 MiB
plus its envelope, which fits the proxy default. Arc bulk ingestion/imports
can be much larger, but buffering those in Launchpad's default 512 MiB pod
would compete with the control plane. Existing proxy uploads larger than
8 MiB must use direct Arc access or an explicit operator override.

- Docker: set both `LAUNCHPAD_PROXY_BODY_SIZE_LIMIT` and `BODY_SIZE_LIMIT`
  to the chosen byte count (for example, `16777216` for 16 MiB).
- Helm: set `requestBodySizeLimit: "16777216"`; the chart sets both variables.
- Running the production build directly: explicitly set both variables, e.g.
  `LAUNCHPAD_PROXY_BODY_SIZE_LIMIT=8388608 BODY_SIZE_LIMIT=8388608 node build`.
  Without an explicit adapter setting, adapter-node retains its smaller
  512 KiB declared-length default, which can reject otherwise valid dashboard bodies.

Values must be positive decimal byte counts, the proxy limit must be at least
1 MiB, and the adapter limit must be at least the proxy limit. Invalid explicit
settings fail validation; they do not silently disable the limit. The locked
adapter-node 2.1.2 only checks declared length, so its setting is defense in
depth, not a replacement for the application streaming readers.

Raising the cap increases memory use for each concurrent request. The proxy
uses a bounded growing buffer and shares it with the upstream writer, but
buffer growth, transport buffers and concurrent requests still need headroom.
This is not a rate/concurrency limit or a guarantee against unlimited parallel
requests. Size the pod and upstream/proxy concurrency controls before raising
it; binary byte compatibility does not mean unlimited upload compatibility.


The Linux production-adapter regression is reproducible after a build with
`npm run test:body-limits` and is configured to run in CI on Node 20 and 22. It uses disposable
SQLite data and a loopback Arc stub, validates exact limits/binary fidelity/
error responses, and asserts peak RSS during concurrent oversized streams.
The RSS budget is a regression threshold, not a deployment capacity guarantee.

Default rationale sources: [Arc SQL limits](https://github.com/Basekick-Labs/arc/blob/8d5acf2c630d8777e075072a7f3581135f4ccdd2/internal/config/config.go#L2049-L2078)
and [Arc request limit](https://github.com/Basekick-Labs/arc/blob/8d5acf2c630d8777e075072a7f3581135f4ccdd2/internal/config/config.go#L2098-L2099).
