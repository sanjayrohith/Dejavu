#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 APP_URL TEAM.cloudflareaccess.com ACCESS_AUD" >&2
  echo "Obtains a user assertion with cloudflared, verifies it, and deletes the temporary copy." >&2
  exit 2
fi

APP_URL=$1
TEAM_DOMAIN=$2
ACCESS_AUD=$3
[[ "$APP_URL" == https://* ]] || { echo "APP_URL must use https" >&2; exit 2; }
command -v cloudflared >/dev/null || { echo "cloudflared is required" >&2; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
umask 077
TOKEN_FILE=$(mktemp "${TMPDIR:-/tmp}/dejavu-access-assertion.XXXXXX")
cleanup() {
  rm -f "$TOKEN_FILE"
}
trap cleanup EXIT HUP INT TERM

# A valid cached Access login makes this invisible. If there is no valid login,
# cloudflared deliberately initiates the IdP/browser ceremony rather than
# falling back to a reusable service-token secret.
cloudflared access token --app "$APP_URL" > "$TOKEN_FILE"
bun "$HERE/verify-session.mjs" \
  --token-file "$TOKEN_FILE" \
  --team-domain "$TEAM_DOMAIN" \
  --audience "$ACCESS_AUD"
