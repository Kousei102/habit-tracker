#!/bin/sh
# Prepares the SQLite volume, then drops root.
#
# Fly attaches a volume owned by root, and the image's unprivileged `node` user
# cannot create the database inside it. So the directory is prepared as root and
# the privileges are dropped immediately afterwards.
set -e

DATA_DIR=$(dirname "${DB_PATH:-/data/habits.db}")
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"

  # setpriv replaces this shell rather than forking, so node keeps PID 1 and
  # receives SIGTERM directly. That signal is what closes the SQLite handle
  # cleanly (server/src/index.ts), so anything that inserts a process in
  # between — su, gosu wrappers, `npm start` — risks losing it.
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid=node --regid=node --init-groups "$@"
  fi

  # Not fatal: on Fly the container is alone in its own microVM. Worth knowing
  # about, so it is not swallowed.
  echo "[entrypoint] setpriv is unavailable; running as root" >&2
fi

exec "$@"
