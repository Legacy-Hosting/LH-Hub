# Legacy Hosting Hub

Internal operations workspace for Legacy Hosting staff. LH-Hub is not a customer product and never exposes provider credentials to the browser.

The backend validates LH-SSO access tokens against the configured issuer, audience, and JWKS endpoint. Only normalized staff roles (`founder`, `management`, `platform_admin`, `developer`, `infrastructure`, `support`, and `sales`) pass authorization. Customer and Discord role names are not accepted directly.

The Hub uses LH-SSO Authorization Code Flow with PKCE through a backend-for-frontend. Authorization codes, access tokens, and rotating refresh tokens stay on the Hub server; the browser receives only a random Secure, HttpOnly, SameSite session cookie. Browser sessions are held in memory and are intentionally invalidated by a Hub restart, after which the existing LH-SSO session provides a quick reauthentication.

Only a verified access token containing an allowlisted staff role creates a browser session. The token is refreshed server-side before expiry so role changes and SSO revocation are enforced without exposing tokens to React. The Hub keeps bearer-token support for authenticated service access.

The infrastructure view reads Droplet metadata and DigitalOcean Insights only on the Hub server. Use a custom DigitalOcean token with `monitoring:read` and its required read scopes, including `droplet:read`, `regions:read`, `sizes:read`, `actions:read`, `image:read`, and `snapshot:read`. The token is never returned to the browser. Metrics are cached for two minutes by default, concurrent refreshes are deduplicated, and provider failures fall back to the last successful snapshot.

## Development

```bash
pnpm install
pnpm dev
pnpm dev:ui
```

## Release and deployment

Tags named `v*` publish immutable archives to `LH-Releases/LH-Hub` and checksums to its `SHA256` directory. Deploy on `ams3-hub-01` with:

```bash
ops/scripts/deploy-release.sh ARCHIVE CHECKSUM VERSION
```

Production requires `/etc/legacy-hosting/hub.env` with mode `0600`, a valid certificate for `hub.legacyhosting.xyz`, and a live LH-SSO issuer. The release is installed below `/opt/legacy-hosting/hub/releases`.
