#!/usr/bin/env sh
# setup-providers.sh: register Moon's model providers in TrueForge from config/trueforge.json and .env.
# TrueForge must already be running (scripts/start-trueforge.sh). The work is done by setup-providers.mjs.
#
# Usage:  sh scripts/setup-providers.sh
set -eu
exec node "$(dirname "$0")/setup-providers.mjs"
