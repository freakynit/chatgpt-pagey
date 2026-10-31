# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a
vulnerability** flow on this repository, or open a minimal issue asking for a
private contact channel. Do not include Pagey API tokens, OAuth tokens, or
private site content in a public issue.

## What this server stores

- The Pagey API token you paste during OAuth, encrypted with AES-256-GCM using a
  key derived from `PAGEY_MCP_SECRET` (or `DATA_DIR/secret`).
- Your Pagey user ID, email address, and account tier, so the connection can be
  shown and audited.
- OAuth access and refresh tokens, only as SHA-256 hashes.
- OAuth client metadata for dynamically registered clients.
- The ID of the last site published through the connection.

It does not store site content after an upload finishes. Content is streamed to
Pagey and then released.

## Pagey token scope

A Pagey API token grants **full API access to the Pagey account**, not just
publishing. Treat it like a password:

- Create a dedicated token labeled `ChatGPT`.
- Revoke it in the Pagey dashboard when you stop using the connection.
- Do not paste a token into chat, a repository, or a screenshot. The OAuth page
  is the only place you should enter it.

The server never asks for your Pagey password. It does not log request bodies or
authorization headers, and it does not send the token anywhere except
`https://pagey.site/api` (or the `PAGEY_API_URL` the operator configured).

## OAuth and transport

- ChatGPT authenticates with OAuth 2.1 using authorization code + PKCE (S256).
- Public clients use dynamic client registration. Redirect URIs are restricted
  to HTTPS (loopback HTTP is allowed for native MCP clients).
- Access tokens are opaque, short-lived, and stored hashed. Refresh tokens rotate
  on use; reusing an old refresh token fails.
- Authorization codes are single-use, expire after five minutes, and are stored
  hashed.
- The authorization form uses a signed, HttpOnly, SameSite=Lax cookie plus a
  per-form nonce to prevent CSRF.
- The MCP endpoint requires a Bearer token. Unauthenticated requests return RFC
  9728 protected-resource metadata so ChatGPT can start the OAuth flow.
- Request bodies to `/mcp` are capped; site uploads are capped by file count and
  total decoded size.
- OAuth endpoints are rate-limited by the MCP SDK. The MCP endpoint also has a
  per-connection limiter.

## Publishing safety

The server is a transport, not a content sandbox. It forwards the content the
user asks to publish to Pagey. Pagey applies its own terms, content scanning, and
takedown process. Do not use the plugin to publish content you do not have the
right to publish.

Input checks reject path traversal, hidden files, dependency folders, source
maps, key material, databases, unsupported extensions, oversized uploads, and
common credential patterns. These are limited safeguards; review what you
publish.

## Self-hosting notes

- Use HTTPS. `PUBLIC_BASE_URL` must be the exact public origin.
- Keep `DATA_DIR` private and persistent. It contains encrypted tokens and the
  encryption secret.
- Set `TRUST_PROXY` only behind a trusted proxy; otherwise clients can spoof
  `X-Forwarded-For` and influence rate limiting.
- Preserve the incoming `Host` header. Host validation is intentional.
- Run one replica with one SQLite volume. Do not point multiple instances at
  separate copies of the database.
- Rotate `PAGEY_MCP_SECRET` only if you accept that all existing connections must
  be re-authorized.
- For a large public deployment, add edge/WAF rate limits in front of
  `/register`, `/token`, and `/authorize`.

## Known limits

- The server does not implement Client ID Metadata Documents; it supports
  dynamic client registration instead. ChatGPT supports both.
- The SQLite store is single-instance.
- Pagey's API token model does not provide scoped, read-only tokens. The
  connector's own authorization is therefore only as narrow as the Pagey token.
- The landing page and OAuth form contain no third-party scripts or analytics.
