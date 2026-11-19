#!/bin/sh
# demo.sh: helpers for recording the demo video. See docs/demo/video-script.md.
#   sh scripts/demo/demo.sh prep | break | restore | intro | edit --video raw.mp4 [--intro <mp4>]
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
action=$1; [ $# -gt 0 ] && shift
case "$action" in
  prep)    exec node "$DIR/prep-demo.mjs" "$@" ;;
  break)   exec node "$DIR/task-c.mjs" break "$@" ;;
  restore) exec node "$DIR/task-c.mjs" restore "$@" ;;
  edit)    exec node "$DIR/edit-video.mjs" "$@" ;;
  intro)   exec node "$DIR/intro/render-intro.mjs" "$@" ;;
  *) echo "Usage: demo.sh prep | break | restore | intro | edit --video <file>"; exit 1 ;;
esac
