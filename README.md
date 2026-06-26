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

Email (Mailgun), signup CAPTCHA (Cloudflare Turnstile), ops alerting (Google Chat), and GitHub/Google OAuth are all **optional** — without them, those features are simply skipped (e.g. emails print to the console instead of being sent).

## Production build

```bash
npm run build
LAUNCHPAD_JWT_SECRET=$(openssl rand -hex 32) node build
```

The server listens on `$PORT` (default `3000`).

## Docker

```bash
docker build -t arc-launchpad .
docker run -p 3000:3000 \
  -e LAUNCHPAD_JWT_SECRET=$(openssl rand -hex 32) \
  -v $(pwd)/data:/app/data \
  arc-launchpad
```

The SQLite database is written to `/app/data/launchpad.db` — mount a volume there to persist it.

## Connecting to an Arc instance

After signing in, add a connection with your Arc instance's endpoint URL (e.g. `http://localhost:8000`) and an admin token. Arc Launchpad verifies the connection and then lets you query and manage that instance.

## License

[Apache-2.0](LICENSE).
