/**
 * Blocks medusa-worker until a backend running *this* build has migrated.
 *
 *   node wait-for-deploy.mjs medusa-backend.railway.internal:9000
 *
 * The obvious gate, waiting for the backend's port, is only correct on a first
 * deploy. Railway keeps the previous deployment serving until the new one
 * passes its healthcheck, so on every later deploy the port is already open,
 * answered by the old backend, while the new one is still running migrations.
 * A worker gated on the port starts new code against the old schema.
 *
 * So the gate is a build handshake instead. Both services are deployed from one
 * commit and therefore share RAILWAY_GIT_COMMIT_SHA; this sends it to
 * /deploy-ready, which answers whether it matches the build that migrated. The
 * backend opens its port only once migrations and bootstrap have finished, so
 * agreement is proof the schema is current. The build is sent rather than read
 * back because that endpoint is public, and returning it would disclose the
 * live commit of what may be a private fork.
 *
 * Railway sets RAILWAY_GIT_COMMIT_SHA only for deploys originating from a
 * GitHub trigger. Without it there is nothing to compare, so this falls back to
 * waiting for the port, which is what the worker did before and is still right
 * on a first deploy, but which restores the redeploy race described above. That
 * is loud rather than silent when it happens on Railway. Set
 * MEDUSA_SCHEMA_VERSION to override the token, which docker-compose.yml does.
 */
import { parseHostPort, sleep, tryConnect } from './lib/net.mjs'

const TIMEOUT_MS = Number(process.env.WAIT_FOR_DEPLOY_TIMEOUT_MS || 600_000)
const RETRY_MS = Number(process.env.WAIT_FOR_DEPLOY_RETRY_MS || 3_000)
const EXPECTED = process.env.MEDUSA_SCHEMA_VERSION || process.env.RAILWAY_GIT_COMMIT_SHA || ''

/**
 * Whether the backend agrees it is running `EXPECTED`, or null if it is not
 * answering yet.
 *
 * A 404 means the backend predates this route, which is the old deployment
 * during the first rollout that introduces it. That is "not ready" rather than
 * an error: the new one answers once it is healthy.
 */
async function askReady({ host, port }) {
  const authority = host.includes(':') ? `[${host}]` : host
  const url = `http://${authority}:${port}/deploy-ready?build=${encodeURIComponent(EXPECTED)}`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return null
    }
    const body = await response.json()
    return typeof body?.ready === 'boolean' ? body.ready : null
  } catch {
    return null
  }
}

async function waitForPort(target) {
  const { host, port } = parseHostPort(target)
  const deadline = Date.now() + TIMEOUT_MS

  for (;;) {
    if (await tryConnect({ host, port })) {
      console.log(`[wait-for-deploy] ${host}:${port} is accepting connections`)
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`[wait-for-deploy] ${host}:${port} not reachable after ${TIMEOUT_MS}ms`)
    }
    console.log(`[wait-for-deploy] waiting for ${host}:${port}`)
    await sleep(RETRY_MS)
  }
}

async function waitForBuild(target) {
  const { host, port } = parseHostPort(target)
  const deadline = Date.now() + TIMEOUT_MS
  let logged = false

  for (;;) {
    if (await askReady({ host, port })) {
      console.log(`[wait-for-deploy] backend is running build ${EXPECTED}, schema is current`)
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `[wait-for-deploy] backend never confirmed build ${EXPECTED} within ${TIMEOUT_MS}ms. ` +
          `If medusa-backend and medusa-worker are deployed from different commits, redeploy ` +
          `both from the same one.`
      )
    }
    // Logged once, so a long migration does not bury the log.
    if (!logged) {
      logged = true
      console.log(`[wait-for-deploy] waiting for a backend running build ${EXPECTED}`)
    }
    await sleep(RETRY_MS)
  }
}

const target = process.argv[2]

try {
  if (!target) {
    throw new Error('[wait-for-deploy] no target given')
  }
  if (EXPECTED) {
    await waitForBuild(target)
  } else {
    // On Railway with no build token, the stronger gate is unavailable and the
    // worker can race a redeploy's migrations. Say so plainly: the failure it
    // reintroduces is silent, so this warning is the only trace it leaves.
    if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID) {
      console.warn(
        '[wait-for-deploy] WARNING: RAILWAY_GIT_COMMIT_SHA is not set, which Railway only ' +
          'provides for GitHub-triggered deploys. Falling back to waiting for the port, which ' +
          'cannot tell a migrating new backend from the old one still serving. On a redeploy ' +
          'that changes the schema, this worker may start before migrations finish.'
      )
    } else {
      console.log('[wait-for-deploy] no build token set, falling back to waiting for the port')
    }
    await waitForPort(target)
  }
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(1)
}
