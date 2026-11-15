/**
 * Shared by wait-for-tcp.mjs and wait-for-deploy.mjs, which both probe a
 * host:port before the application starts.
 *
 * Node's resolver is used rather than nc or pg_isready: Railway's private
 * network is IPv6 only and the busybox tools in a slim image disagree about
 * whether they support it.
 */
import net from 'node:net'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Bare host:port. A bracketed IPv6 literal keeps its brackets off the host. */
export function parseHostPort(target) {
  const match = target.match(/^\[?([^\]]+)\]?:(\d+)$/)
  if (!match) {
    throw new Error(`Expected host:port, got ${target}`)
  }
  return { host: match[1], port: Number(match[2]) }
}

export function tryConnect({ host, port }) {
  return new Promise((resolve) => {
    // family 0 so the IPv6-only private network and an IPv4 local stack both work.
    const socket = net.connect({ host, port, family: 0 })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(5_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}
