/**
 * Blocks until every target accepts a TCP connection.
 *
 *   node wait-for-tcp.mjs postgres://user:pass@host:5432/db redis://host:6379 host:9000
 *
 * A fresh Railway deploy starts every service at once, so a container can boot
 * before the database it migrates against exists. Waiting here means the first
 * deploy converges on its own rather than failing and needing a manual retry.
 *
 * The socket probe itself lives in lib/net.mjs, shared with wait-for-deploy.mjs.
 */
import { parseHostPort, sleep, tryConnect } from './lib/net.mjs'

const DEFAULT_PORTS = {
  'postgres:': 5432,
  'postgresql:': 5432,
  'redis:': 6379,
  'rediss:': 6379,
  'http:': 80,
  'https:': 443,
}

const TIMEOUT_MS = Number(process.env.WAIT_FOR_TCP_TIMEOUT_MS || 180_000)
const RETRY_MS = Number(process.env.WAIT_FOR_TCP_RETRY_MS || 2_000)

function parseTarget(target) {
  if (target.includes('://')) {
    const url = new URL(target)
    const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol]
    if (!port) {
      throw new Error(`Cannot tell which port to wait for in ${target}`)
    }
    return { host: url.hostname, port }
  }
  return parseHostPort(target)
}

async function waitFor(target) {
  const { host, port } = parseTarget(target)
  const deadline = Date.now() + TIMEOUT_MS

  for (;;) {
    if (await tryConnect({ host, port })) {
      console.log(`[wait-for-tcp] ${host}:${port} is accepting connections`)
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(`[wait-for-tcp] ${host}:${port} not reachable after ${TIMEOUT_MS}ms`)
    }
    console.log(`[wait-for-tcp] waiting for ${host}:${port}`)
    await sleep(RETRY_MS)
  }
}

const targets = process.argv.slice(2).filter(Boolean)

try {
  // Sequential, so the log reads as a list of dependencies rather than
  // interleaved noise. They are all up within seconds of each other anyway.
  for (const target of targets) {
    await waitFor(target)
  }
} catch (error) {
  console.error(String(error.message ?? error))
  process.exit(1)
}
