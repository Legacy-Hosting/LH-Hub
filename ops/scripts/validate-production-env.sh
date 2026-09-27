#!/usr/bin/env bash
set -Eeuo pipefail

environment_file=${1:-/etc/legacy-hosting/hub.env}
if [[ ! -f $environment_file ]]; then
  echo "Missing protected Hub environment: $environment_file" >&2
  exit 1
fi
permissions=$(stat -c '%a' "$environment_file")
if (( (8#$permissions & 077) != 0 )); then
  echo "$environment_file must have mode 0600 or stricter" >&2
  exit 1
fi
set -a
# The protected environment path is an operator argument.
# shellcheck disable=SC1090
. "$environment_file"
set +a
required=(NODE_ENV HOST PORT SSO_ISSUER SSO_AUDIENCE SSO_JWKS_URL SSO_CLIENT_ID \
  SSO_CLIENT_SECRET SSO_REDIRECT_URI SSO_RESOURCE SSO_REQUEST_TIMEOUT_MS HUB_ORIGIN HUB_SESSION_TTL_SECONDS \
  API_ORIGIN API_REQUEST_TIMEOUT_MS \
  SERVICE_HEALTH_TARGETS DIGITALOCEAN_TOKEN DIGITALOCEAN_REQUEST_TIMEOUT_MS \
  DIGITALOCEAN_CACHE_TTL_MS DIGITALOCEAN_METRIC_WINDOW_SECONDS)
for name in "${required[@]}"; do
  if [[ -z ${!name:-} ]]; then
    echo "Missing Hub setting: $name" >&2
    exit 1
  fi
done
if [[ $NODE_ENV != production || $HOST != 127.0.0.1 || $PORT != 8081 ]]; then
  echo "Hub must run in production mode on 127.0.0.1:8081" >&2
  exit 1
fi
if [[ $SSO_ISSUER != https://* || $SSO_JWKS_URL != https://* || \
      $SSO_REDIRECT_URI != https://* || $SSO_RESOURCE != https://* || \
      $HUB_ORIGIN != https://* || $API_ORIGIN != https://* ]]; then
  echo "Hub SSO endpoints must use HTTPS" >&2
  exit 1
fi
if [[ ${#SSO_CLIENT_SECRET} -lt 32 ]]; then
  echo "SSO_CLIENT_SECRET must contain at least 32 characters" >&2
  exit 1
fi
if [[ ${#DIGITALOCEAN_TOKEN} -lt 32 || $DIGITALOCEAN_TOKEN == *replace-with* ]]; then
  echo "DIGITALOCEAN_TOKEN must be a real scoped read-only token" >&2
  exit 1
fi
if [[ $SSO_REDIRECT_URI != "${HUB_ORIGIN%/}/auth/callback" ]]; then
  echo "SSO_REDIRECT_URI must use HUB_ORIGIN and /auth/callback" >&2
  exit 1
fi
if [[ ! $HUB_SESSION_TTL_SECONDS =~ ^[0-9]+$ ]] || \
   (( HUB_SESSION_TTL_SECONDS < 300 || HUB_SESSION_TTL_SECONDS > 28800 )); then
  echo "HUB_SESSION_TTL_SECONDS must be between 300 and 28800" >&2
  exit 1
fi
if [[ ! $SSO_REQUEST_TIMEOUT_MS =~ ^[0-9]+$ ]] || \
   (( SSO_REQUEST_TIMEOUT_MS < 1000 || SSO_REQUEST_TIMEOUT_MS > 15000 )); then
  echo "SSO_REQUEST_TIMEOUT_MS must be between 1000 and 15000" >&2
  exit 1
fi
if [[ ! $API_REQUEST_TIMEOUT_MS =~ ^[0-9]+$ ]] || \
   (( API_REQUEST_TIMEOUT_MS < 1000 || API_REQUEST_TIMEOUT_MS > 15000 )); then
  echo "API_REQUEST_TIMEOUT_MS must be between 1000 and 15000" >&2
  exit 1
fi
if [[ ! $DIGITALOCEAN_REQUEST_TIMEOUT_MS =~ ^[0-9]+$ ]] || \
   (( DIGITALOCEAN_REQUEST_TIMEOUT_MS < 1000 || DIGITALOCEAN_REQUEST_TIMEOUT_MS > 15000 )); then
  echo "DIGITALOCEAN_REQUEST_TIMEOUT_MS must be between 1000 and 15000" >&2
  exit 1
fi
if [[ ! $DIGITALOCEAN_CACHE_TTL_MS =~ ^[0-9]+$ ]] || \
   (( DIGITALOCEAN_CACHE_TTL_MS < 60000 || DIGITALOCEAN_CACHE_TTL_MS > 900000 )); then
  echo "DIGITALOCEAN_CACHE_TTL_MS must be between 60000 and 900000" >&2
  exit 1
fi
if [[ ! $DIGITALOCEAN_METRIC_WINDOW_SECONDS =~ ^[0-9]+$ ]] || \
   (( DIGITALOCEAN_METRIC_WINDOW_SECONDS < 600 || DIGITALOCEAN_METRIC_WINDOW_SECONDS > 86400 )); then
  echo "DIGITALOCEAN_METRIC_WINDOW_SECONDS must be between 600 and 86400" >&2
  exit 1
fi
if ! node -e 'const issuer=new URL(process.env.SSO_ISSUER); const jwks=new URL(process.env.SSO_JWKS_URL); const hub=new URL(process.env.HUB_ORIGIN); const resource=new URL(process.env.SSO_RESOURCE); const api=new URL(process.env.API_ORIGIN); if(jwks.origin!==issuer.origin||resource.origin!==hub.origin||api.pathname!=="/"||api.search||api.hash||api.username||api.password) process.exit(1)'; then
  echo "Hub SSO issuer, JWKS, resource, and origin do not match" >&2
  exit 1
fi
node -e 'const targets=JSON.parse(process.env.SERVICE_HEALTH_TARGETS); if(!Array.isArray(targets)||targets.length<1||targets.some((item)=>!String(item.url||"").startsWith("https://"))) process.exit(1)'
echo "Hub production environment validation passed without printing secrets."
