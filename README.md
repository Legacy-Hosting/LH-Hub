# Legacy Hosting Hub

Internal operations workspace for Legacy Hosting staff. LH-Hub is not a customer product and never exposes provider credentials to the browser.

The backend validates LH-SSO access tokens against the configured issuer, audience, and JWKS endpoint. Only normalized staff roles (`founder`, `management`, `platform_admin`, `developer`, `infrastructure`, `support`, and `sales`) pass authorization. Customer and Discord role names are not accepted directly.

The first foundation provides public process health, protected staff/session endpoints, and bounded server-side health checks. Full sign-in remains intentionally disabled in the UI until LH-SSO implements and verifies Authorization Code with PKCE.

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
