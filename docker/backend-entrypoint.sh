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

# The worker gates on a server running its own build, not merely on an open
# port. Railway keeps the previous deployment serving until the new one is
# healthy, so on every deploy after the first the port is already open and
# answered by the old backend while the new one is still migrating. Comparing
# builds is what makes this correct on a redeploy and not just a cold start.
if [ -n "$MEDUSA_WAIT_FOR" ]; then
  node /app/docker/wait-for-deploy.mjs "$MEDUSA_WAIT_FOR"
fi

echo "==> medusa start (worker mode: ${MEDUSA_WORKER_MODE:-shared})"
exec node_modules/.bin/medusa start
