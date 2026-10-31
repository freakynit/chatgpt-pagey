# Deploy the Pagey MCP server

The public deployment is **`https://mcp.pagey.site/mcp`**. This guide is for
running your own copy.

ChatGPT connects to a remote MCP server over public HTTPS. This repository is
that server: one Node.js process with the OAuth flow, the Pagey API client, and
a small SQLite database for encrypted account connections.

You need:

- a hostname with a DNS A/AAAA record pointing at the server;
- a TLS-terminating reverse proxy (Caddy, Nginx, Traefik, a load balancer);
- a persistent disk for `/data`;
- Node.js 24 **or** Docker.

One replica is the supported topology. The SQLite store is local to the
instance; do not run multiple replicas against separate volumes.

## Option A: Docker Compose + Caddy (recommended)

Caddy obtains and renews the TLS certificate automatically.

```sh
cp deploy/.env.example .env
# Edit .env and set MCP_DOMAIN=mcp.example.com
docker compose up -d --build
docker compose logs -f pagey-mcp
```

Check `https://mcp.example.com/healthz` and open `https://mcp.example.com/` for
the connection instructions.

The Compose file sets `PUBLIC_BASE_URL=https://${MCP_DOMAIN}`, binds the app to
`0.0.0.0`, and keeps the database in the `pagey-data` volume. Caddy stores its
certificates in `caddy-data`.

## Option B: existing reverse proxy

```sh
docker build -t chatgpt-pagey .
docker run -d \
  --name pagey-mcp \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e PUBLIC_BASE_URL=https://mcp.example.com \
  -e TRUST_PROXY=1 \
  -v pagey-data:/data \
  chatgpt-pagey
```

Caddy:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name mcp.example.com;

  # ... your TLS certificate configuration ...

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 180s;
  }
}
```

Preserve the `Host` header. The server validates it against `PUBLIC_BASE_URL` to
block DNS-rebinding requests (the `/healthz` endpoint is exempt so that
orchestrator probes using a pod IP still work).

## Option C: Node directly

```sh
npm ci
npm run build

sudo mkdir -p /var/lib/pagey-mcp
sudo chown "$USER" /var/lib/pagey-mcp

PUBLIC_BASE_URL=https://mcp.example.com \
NODE_ENV=production \
HOST=0.0.0.0 \
PORT=8787 \
TRUST_PROXY=1 \
DATA_DIR=/var/lib/pagey-mcp \
node dist/index.js
```

Example systemd unit:

```ini
[Unit]
Description=Pagey MCP server for ChatGPT
After=network.target

[Service]
Type=simple
User=pagey
WorkingDirectory=/opt/chatgpt-pagey
Environment=PUBLIC_BASE_URL=https://mcp.example.com
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=8787
Environment=TRUST_PROXY=1
Environment=DATA_DIR=/var/lib/pagey-mcp
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `PUBLIC_BASE_URL` | Production | `http://127.0.0.1:PORT` | Exact public HTTPS origin, no path or trailing slash. Required when `NODE_ENV=production`. |
| `HOST` | No | `127.0.0.1` | Use `0.0.0.0` in containers. |
| `PORT` | No | `8787` | |
| `DATA_DIR` | No | `./data` | Must be persistent. Holds SQLite and the generated secret. |
| `PAGEY_MCP_SECRET` | No | generated in `DATA_DIR/secret` | ≥32 characters. Encrypts Pagey tokens and signs the OAuth form cookie. |
| `PAGEY_API_URL` | No | `https://pagey.site/api` | HTTPS required unless loopback. |
| `PAGEY_SITE_DOMAIN` | No | `pagey.site` | Domain used to build public site URLs. |
| `PAGEY_SITE_PROTOCOL` | No | `https` | Use `http` only for a local Pagey instance. |
| `TRUST_PROXY` | Behind a proxy | `0` | `1` (or a hop count) so rate limiting sees the real client IP. |
| `MAX_UPLOAD_BYTES` | No | `52428800` (50 MiB) | Decoded site content per publish. |
| `MCP_BODY_LIMIT` | No | `72 MiB` | JSON request limit for `/mcp`; must fit base64 assets. |
| `OAUTH_ACCESS_TOKEN_TTL` | No | `3600` | Seconds. |
| `OAUTH_REFRESH_TOKEN_TTL` | No | `2592000` | Seconds (30 days). |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error`. |
| `NODE_ENV` | No | | Set to `production` in production. |

## Connect ChatGPT

1. Open ChatGPT → **Plugins** → **Add custom MCP server**.
2. Name it **Pagey**.
3. Server URL: `https://mcp.example.com/mcp`.
4. Authentication: **OAuth**. ChatGPT discovers the server's OAuth metadata and
   opens the Pagey connection page.
5. Paste a Pagey API token from
   [pagey.site/dashboard/api-tokens](https://pagey.site/dashboard/api-tokens).
   Label it `ChatGPT`.
6. Start a conversation: “Build a one-page portfolio and publish it to Pagey.”

The OAuth flow uses dynamic client registration; no client ID or secret needs
to be configured. Tokens are stored as SHA-256 hashes, and the Pagey API token
is encrypted with AES-256-GCM.

## Data and backups

The important files are:

```text
DATA_DIR/pagey-mcp.sqlite      connections, OAuth clients, codes, tokens
DATA_DIR/pagey-mcp.sqlite-wal  write-ahead log (back up with the database)
DATA_DIR/pagey-mcp.sqlite-shm  shared-memory file (not needed at rest)
DATA_DIR/secret                generated encryption and signing secret (0600)
```

Back up the whole directory while the process is stopped, or use SQLite's
`.backup` command. Losing `secret` invalidates every stored Pagey connection and
OAuth token; users must reconnect. Losing the database also requires users to
reconnect, but does not affect their sites.

There is no automatic deletion of Pagey tokens. Revoke the dedicated Pagey token
in the Pagey dashboard when a connection is no longer needed.

## Verify a deployment

From a checkout, walk the real OAuth and MCP flow against the public endpoint:

```sh
MCP_BASE_URL=https://mcp.example.com \
PAGEY_API_TOKEN=... \
E2E_SUBDOMAIN=my-demo-site \
npm run smoke:remote
```

The script updates the existing demo site (it does not create one unless
`SMOKE_CREATE=1`), verifies the live HTML, exercises analytics, and creates and
deletes a test form. It prints no tokens.

## Updating

```sh
git pull
docker compose up -d --build
```

The `pagey-data` volume survives rebuilds. Run `npm test` and `npm run typecheck`
before deploying a fork. Updating the server version does not touch the Pagey
sites it published.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| ChatGPT opens OAuth and then reports a redirect error | `PUBLIC_BASE_URL` does not exactly match the public origin, or the proxy rewrites the path. |
| 403 with an “Invalid Host” JSON body | The proxy is changing `Host`, or the request is using an internal hostname. Preserve `Host`, or use `/healthz` for probes. |
| 502 from the reverse proxy | The app is not running, is bound to `127.0.0.1`, or is on the wrong port. |
| “Pagey rejected the saved API token” | The token was revoked or replaced. Reconnect the plugin and paste a new token. |
| 429 from Pagey | Pagey's account, upload, or request limits. Wait for the reset; updates do not use the 25/day new-site allowance. |
| OAuth connection lost after a restart | `DATA_DIR` is ephemeral, or `PAGEY_MCP_SECRET` changed. Use a persistent volume and a stable secret. |
| ChatGPT cannot refresh after a while | The server must stay reachable at the same `PUBLIC_BASE_URL`; changing the hostname invalidates the issuer metadata. |

## Security checklist

- Serve only over HTTPS. `PUBLIC_BASE_URL` must be HTTPS in production.
- Keep `DATA_DIR` on a private, persistent disk and restrict access to the host.
- Set `TRUST_PROXY` only when a trusted proxy is in front of the app.
- Create a dedicated Pagey API token for the plugin and revoke it when done.
  Pagey tokens are account-scoped, not read-only.
- Keep Node.js and the base image patched.
- Do not put `PAGEY_MCP_SECRET` or Pagey tokens in logs, screenshots, or chat.
- The server accepts dynamic OAuth client registration. Keep the built-in rate
  limit in place; for a large public deployment, put a WAF or edge rate limit in
  front of `/register`, `/token`, and `/authorize`.
