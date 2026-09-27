#!/usr/bin/env bash
set -Eeuo pipefail

environment_file=${1:-/etc/legacy-hosting/hub.env}
if [[ ! -f $environment_file ]]; then
  echo "Missing protected Hub environment: $environment_file" >&2
  exit 1
fi
permissions=$(stat -c '%a' "$environment_file")
if (( 10#$permissions > 600 )); then
  echo "$environment_file must have mode 0600 or stricter" >&2
  exit 1
fi
set -a
. "$environment_file"
set +a
required=(NODE_ENV HOST PORT SSO_ISSUER SSO_AUDIENCE SSO_JWKS_URL SERVICE_HEALTH_TARGETS)
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
if [[ $SSO_ISSUER != https://* || $SSO_JWKS_URL != https://* ]]; then
  echo "Hub SSO endpoints must use HTTPS" >&2
  exit 1
fi
node -e 'const targets=JSON.parse(process.env.SERVICE_HEALTH_TARGETS); if(!Array.isArray(targets)||targets.length<1||targets.some((item)=>!String(item.url||"").startsWith("https://"))) process.exit(1)'
echo "Hub production environment validation passed without printing secrets."
