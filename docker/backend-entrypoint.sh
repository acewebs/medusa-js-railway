#!/bin/sh
#
# One image, two services. The server migrates, bootstraps and serves; the worker
# waits for it and then runs jobs, subscribers and scheduled workflows.
#
# All of this lives in the image rather than in a Railway pre-deploy command,
# because a published template does not carry pre-deploy commands: anything put
# there never runs on the deploy that needs it.
set -e

cd /app

# An `if` rather than `[ -n "$1" ] && ...`, which would return 1 for an unset
# target and take the whole script down under `set -e`.
wait_for() {
  if [ -n "$1" ]; then
    node /app/docker/wait-for-tcp.mjs "$@"
  fi
}

wait_for "$DATABASE_URL"
wait_for "$REDIS_URL"

if [ "${MEDUSA_RUN_MIGRATIONS:-true}" = "true" ]; then
  # A failed migration exits here, before anything serves traffic, so the
  # healthcheck never passes and Railway keeps the previous version live.
  echo "==> medusa db:migrate"
  node_modules/.bin/medusa db:migrate

  echo "==> bootstrap"
  node_modules/.bin/medusa exec ./src/scripts/bootstrap.js
fi

# The worker gates on the server, which opens its port only once migrations and
# bootstrap have finished. That makes a reachable port the schema's readiness
# signal, so the worker never races a half-migrated database.
wait_for "$MEDUSA_WAIT_FOR"

echo "==> medusa start (worker mode: ${MEDUSA_WORKER_MODE:-shared})"
exec node_modules/.bin/medusa start
