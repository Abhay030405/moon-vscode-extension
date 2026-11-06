#!/usr/bin/env sh
# setup-flask.sh: get the competition repository (pallets/flask) ready for the three fixed tasks.
#
#   1. Clones flask.repoUrl at flask.tag into flask.dir (from config/moon.json),
#      or, if that folder already exists, checks the tag out there.
#   2. Confirms HEAD is flask.commit. Stops if it isn't.
#   3. Hides flask.localIgnores (venv, test cache) from Flask's git status using
#      .git/info/exclude, so `git status` stays clean for Task C.
#   4. Creates a Python virtual environment in <flask.dir>/.venv and installs
#      Flask (editable) plus flask.testRequirements, so the task checks can run.
#
# Refuses to touch an existing checkout that has uncommitted changes.
#
# Usage:  sh scripts/setup-flask.sh [--skip-install]
set -eu

SKIP_INSTALL=0
[ "${1:-}" = "--skip-install" ] && SKIP_INSTALL=1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONFIG="$ROOT/config/moon.json"
if [ ! -f "$CONFIG" ]; then
  echo "config/moon.json not found. Create it first:" >&2
  echo "  cp config/moon.example.json config/moon.json" >&2
  exit 1
fi

# Read one flask.* value; arrays are printed one item per line.
cfg() {
  node -e '
    const value = require(process.argv[1]).flask[process.argv[2]];
    console.log(Array.isArray(value) ? value.join("\n") : value);
  ' "$CONFIG" "$1"
}
REPO_URL=$(cfg repoUrl)
TAG=$(cfg tag)
COMMIT=$(cfg commit)
TARGET="$ROOT/$(cfg dir)"

if [ ! -e "$TARGET" ]; then
  echo "Cloning $REPO_URL at $TAG into $TARGET"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" "$REPO_URL" "$TARGET"
else
  if [ ! -d "$TARGET/.git" ]; then
    echo "$TARGET exists but is not a git repository. Move it away and run again." >&2
    exit 1
  fi
  DIRTY=$(git -C "$TARGET" status --porcelain)
  if [ -n "$DIRTY" ]; then
    echo "$TARGET has uncommitted changes. Commit, stash or discard them first:" >&2
    echo "$DIRTY" >&2
    exit 1
  fi
  echo "Checking out $TAG in $TARGET"
  git -C "$TARGET" fetch --quiet --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
  git -C "$TARGET" checkout --quiet --detach "$TAG"
fi

HEAD=$(git -C "$TARGET" rev-parse HEAD)
case "$HEAD" in
  "$COMMIT"*) echo "OK: $TAG at commit $HEAD" ;;
  *) echo "HEAD is $HEAD, expected $COMMIT. Wrong checkout." >&2; exit 1 ;;
esac

# Hide local-only files (venv, test cache) from git status, without touching Flask's own files.
EXCLUDE="$TARGET/.git/info/exclude"
touch "$EXCLUDE"
cfg localIgnores | while IFS= read -r pattern; do
  if [ -n "$pattern" ] && ! grep -qxF "$pattern" "$EXCLUDE"; then
    echo "$pattern" >> "$EXCLUDE"
  fi
done

[ "$SKIP_INSTALL" -eq 1 ] && exit 0

if command -v python3 >/dev/null 2>&1; then PYTHON=python3; else PYTHON=python; fi
VENV="$TARGET/.venv"
if [ ! -d "$VENV" ]; then
  echo "Creating virtual environment in $VENV"
  "$PYTHON" -m venv "$VENV"
fi
if [ -x "$VENV/bin/python" ]; then VENV_PYTHON="$VENV/bin/python"; else VENV_PYTHON="$VENV/Scripts/python.exe"; fi

echo "Installing Flask (editable) and its test requirements"
# shellcheck disable=SC2046  # one argument per line from the config is intended
"$VENV_PYTHON" -m pip install --quiet --disable-pip-version-check -e "$TARGET" $(cfg testRequirements)

echo ""
echo "Flask is ready in $TARGET"
echo "Activate the environment with:  . $VENV/bin/activate"
