# Privacy

This connector exists to publish and manage sites in your Pagey account. It
collects as little as possible.

## What is stored

When you connect, the Pagey API token you paste is encrypted at rest with
AES-256-GCM. The connector also stores your Pagey user ID, email address,
account tier, and the ID of the last site you published. OAuth access and refresh
tokens are stored only as SHA-256 hashes. Site content is not stored after the
upload to Pagey finishes.

## What is sent where

Site content, settings, and API requests go from ChatGPT to this connector, then
to Pagey's API at `pagey.site`. Nothing is sent to analytics, advertising, or
other third parties. The connector does not log request bodies, API tokens, or
OAuth tokens.

## Cookies

The only browser cookie is a short-lived, HttpOnly, SameSite=Lax cookie set on
the OAuth authorization page. It is signed, expires after ten minutes, and is
used only to prevent cross-site request forgery. ChatGPT itself receives OAuth
tokens, not this cookie.

## Retention and removal

Connection records remain until the Pagey token is revoked or the operator
deletes the record. Removing the plugin from ChatGPT stops new requests but does
not automatically delete the stored connection. Revoke the `ChatGPT` token in
your Pagey dashboard to cut off access immediately.

For a self-hosted deployment, the operator controls `DATA_DIR` and can delete the
SQLite database to remove all connections.

## Contact

This is an independent open-source project. Report privacy concerns or request
deletion through the repository:
<https://github.com/freakynit/chatgpt-pagey>.
