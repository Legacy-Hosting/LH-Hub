#!/usr/bin/env bash
set -Eeuo pipefail

base=/opt/legacy-hosting/hub
test -L "$base/current"
test -f "$base/current-release"
test -f /var/www/legacy-hosting-hub/index.html
curl --fail --silent --show-error http://127.0.0.1:8081/health | \
  grep -q '"status":"ok"'
pm2 describe lh-hub >/dev/null
current_release=$(readlink -f "$base/current")
recorded_release=$(cat "$base/current-release")
if [[ $recorded_release != "$(basename "$current_release")" ]]; then
  echo "Hub current-release marker does not match the current symlink" >&2
  exit 1
fi
if [[ $current_release != "$base/releases/"* ]]; then
  echo "Hub current symlink points outside the release directory" >&2
  exit 1
fi
CURRENT_RELEASE="$current_release" node <<'NODE'
const { execFileSync } = require("node:child_process");
const currentRelease = process.env.CURRENT_RELEASE;
const processInfo = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8" }))
  .find((item) => item.name === "lh-hub");
if (!processInfo?.pm2_env?.pm_exec_path?.startsWith(`${currentRelease}/`)) {
  throw new Error(`lh-hub is not running from ${currentRelease}`);
}
NODE
nginx -t
echo "LH-Hub release verification passed for $(cat "$base/current-release")."
