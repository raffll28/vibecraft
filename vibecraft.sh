#!/usr/bin/env bash
# Vibecraft launcher: starts the server in the background (if it isn't
# running yet) and opens the monitor in the browser.
#
#   ./vibecraft.sh         start (once) and open http://localhost:4003
#   ./vibecraft.sh stop    turn the server off (same as the page's power button)
#
# The first run also adds "Vibecraft" to the applications menu
# (~/.local/share/applications/vibecraft.desktop), so it can be opened
# with a click or pinned to the dock.

set -u

ROOT="$(dirname "$(readlink -f "$0")")"
SERVER="$ROOT/rust/target/release/vibecraft-server"
PORT="${VIBECRAFT_PORT:-4003}"
URL="http://localhost:$PORT"
LOG="$HOME/.vibecraft/server.log"
DESKTOP_FILE="$HOME/.local/share/applications/vibecraft.desktop"

# Opened from the menu there's no terminal: errors go to a desktop notification
fail() {
  echo "vibecraft: $1" >&2
  command -v notify-send >/dev/null && notify-send "Vibecraft" "$1"
  exit 1
}

# Send a request to the server; prints the status code (empty if it's off)
request() {
  local method="$1" path="$2" status
  { exec 3<>"/dev/tcp/127.0.0.1/$PORT"; } 2>/dev/null || return 0
  printf '%s %s HTTP/1.1\r\nHost: localhost:%s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n' \
    "$method" "$path" "$PORT" >&3
  read -r -t 2 _ status _ <&3
  exec 3>&-
  echo "$status"
}

running() {
  [ "$(request GET /health)" = 200 ]
}

install_launcher() {
  [ -f "$DESKTOP_FILE" ] && grep -qF "Exec=\"$ROOT/vibecraft.sh\"" "$DESKTOP_FILE" && return
  mkdir -p "$(dirname "$DESKTOP_FILE")"
  cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Vibecraft
Comment=3D monitor for your Claude Code sessions
Exec="$ROOT/vibecraft.sh"
Icon=$ROOT/public/logo.svg
Terminal=false
Categories=Development;
EOF
  echo "Added Vibecraft to the applications menu"
}

if [ "${1:-}" = stop ]; then
  if [ "$(request POST /shutdown)" = 200 ]; then
    echo "Vibecraft server stopped"
  else
    echo "Vibecraft server isn't running"
  fi
  exit 0
fi

install_launcher

if ! running; then
  [ -x "$SERVER" ] || fail "server not built: run 'deno task build' in $ROOT"
  [ -f "$ROOT/dist/index.html" ] || fail "frontend not built: run 'deno task build' in $ROOT"
  mkdir -p "$(dirname "$LOG")"
  # Its own session, so closing a terminal doesn't take it down
  (umask 077 && setsid "$SERVER" >>"$LOG" 2>&1 </dev/null &)
  for _ in $(seq 50); do
    running && break
    sleep 0.1
  done
  running || fail "the server didn't start, see $LOG"
fi

xdg-open "$URL" >/dev/null 2>&1 &
