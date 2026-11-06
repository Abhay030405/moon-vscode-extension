#!/usr/bin/env sh
# setup-test-repo.sh: get the repositories used to test Moon ready (listed in config/test-repos.json).
# Moon itself works on any project; this is only for the demo tasks and evals.
#
# For each repo (or only the one named):
#   1. Clones <url> at <ref> into <dir>, or, if <dir> exists, checks <ref> out there.
#   2. Confirms HEAD is <commit>. Stops if it isn't.
#   3. Hides <localIgnores> from the repo's git status via .git/info/exclude (never committed),
#      so `git status` stays clean.
#   4. Runs the repo's <setup.unix> commands inside it (e.g. create a venv, install deps).
#
# Refuses to touch an existing checkout that has uncommitted changes.
#
# Usage:  sh scripts/setup-test-repo.sh [name] [--skip-setup]
set -eu

NAME=""
SKIP_SETUP=0
for arg in "$@"; do
  case "$arg" in
    --skip-setup) SKIP_SETUP=1 ;;
    *) NAME="$arg" ;;
  esac
done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONFIG="$ROOT/config/test-repos.json"

# On Windows (Git Bash / MSYS / Cygwin) the repo's setup.windows commands apply,
# so hand over to the PowerShell version of this script.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    set -- -ExecutionPolicy Bypass -File "$ROOT/scripts/setup-test-repo.ps1" \
      ${NAME:+-Name "$NAME"} $( [ "$SKIP_SETUP" -eq 1 ] && echo -SkipSetup )
    exec powershell "$@"
    ;;
esac

# q <repo-name> <field.path>: print one field of a repo; arrays one item per line.
q() {
  node -e '
    const repo = require(process.argv[1]).repos.find((r) => r.name === process.argv[2]);
    const value = process.argv[3].split(".").reduce((o, k) => (o == null ? o : o[k]), repo);
    if (value == null) process.exit(0);
    console.log(Array.isArray(value) ? value.join("\n") : value);
  ' "$CONFIG" "$1" "$2"
}

NAMES=$(node -e 'console.log(require(process.argv[1]).repos.map((r) => r.name).join("\n"))' "$CONFIG")
if [ -n "$NAME" ]; then
  if ! printf '%s\n' "$NAMES" | grep -qxF "$NAME"; then
    echo "No repo named '$NAME' in config/test-repos.json." >&2
    exit 1
  fi
  NAMES="$NAME"
fi

for repo in $NAMES; do
  URL=$(q "$repo" url)
  REF=$(q "$repo" ref)
  COMMIT=$(q "$repo" commit)
  TARGET="$ROOT/$(q "$repo" dir)"
  echo "== $repo: $(q "$repo" purpose)"

  if [ ! -e "$TARGET" ]; then
    echo "Cloning $URL at $REF into $TARGET"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$REF" "$URL" "$TARGET"
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
    echo "Checking out $REF in $TARGET"
    git -C "$TARGET" fetch --quiet --depth 1 origin "$REF"
    git -C "$TARGET" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  fi

  HEAD=$(git -C "$TARGET" rev-parse HEAD)
  case "$HEAD" in
    "$COMMIT"*) echo "OK: $REF at commit $HEAD" ;;
    *) echo "HEAD is $HEAD, expected $COMMIT. Wrong checkout." >&2; exit 1 ;;
  esac

  EXCLUDE="$TARGET/.git/info/exclude"
  touch "$EXCLUDE"
  q "$repo" localIgnores | while IFS= read -r pattern; do
    if [ -n "$pattern" ] && ! grep -qxF "$pattern" "$EXCLUDE"; then
      echo "$pattern" >> "$EXCLUDE"
    fi
  done

  [ "$SKIP_SETUP" -eq 1 ] && continue

  q "$repo" setup.unix | while IFS= read -r command; do
    [ -z "$command" ] && continue
    echo "> $command"
    (cd "$TARGET" && sh -c "$command")
  done
  echo "Ready: $TARGET"
done
