#!/usr/bin/env sh
# start-trueforge.sh: start TrueForge in local mode with the settings from config/moon.json.
#
#   - Checks Node.js is new enough (version from "engines.node" in package.json).
#   - Sets OUTBOUND_URL_ALLOWED_HOSTS so TrueForge may call Moon's MCP server on localhost
#     (blocked by default) and our own provider endpoints (see scripts/lib/allowed-hosts.mjs).
#   - Runs npx @truefoundry/trueforge@<trueforge.version> --port <trueforge.port>.
#
# Usage (from anywhere):  sh scripts/start-trueforge.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONFIG="$ROOT/config/moon.json"
PACKAGE="$ROOT/package.json"

if [ ! -f "$CONFIG" ]; then
  echo "config/moon.json not found. Create it first:" >&2
  echo "  cp config/moon.example.json config/moon.json" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed or not on PATH." >&2
  exit 1
fi

# Node version check against package.json "engines.node" (e.g. ">=22.14").
if ! node -e '
  const want = require(process.argv[1]).engines.node.match(/\d+(\.\d+)+/)[0].split(".").map(Number);
  const have = process.versions.node.split(".").map(Number);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) > want[i]) process.exit(0);
    if ((have[i] ?? 0) < want[i]) process.exit(1);
  }
' "$PACKAGE"; then
  echo "Node.js $(node -v) is too old; $(node -p "require('$PACKAGE').engines.node") is required." >&2
  exit 1
fi

# Read one value from config/moon.json, e.g. cfg trueforge.port
cfg() {
  node -e '
    const value = process.argv[2].split(".").reduce((o, k) => o[k], require(process.argv[1]));
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  ' "$CONFIG" "$1"
}

VERSION=$(cfg trueforge.version)
PORT=$(cfg trueforge.port)
BASE_URL=$(cfg trueforge.baseUrl)
# Local hosts from config/moon.json + the hosts of our provider endpoints (config/trueforge.json + .env).
OUTBOUND_URL_ALLOWED_HOSTS=$(node "$ROOT/scripts/lib/allowed-hosts.mjs")
export OUTBOUND_URL_ALLOWED_HOSTS

echo "Starting TrueForge $VERSION on port $PORT"
echo "Allowed outbound hosts: $(node -p "JSON.parse(process.argv[1]).length" "$OUTBOUND_URL_ALLOWED_HOSTS")"
echo "Open $BASE_URL once it is up. Press Ctrl+C to stop."

exec npx --yes "@truefoundry/trueforge@$VERSION" --port "$PORT"
