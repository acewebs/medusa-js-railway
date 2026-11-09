/**
 * Serves objects out of the bucket Medusa uploads to, read only.
 *
 * Railway Storage Buckets are private and have no public URL, so something has
 * to stand in front of them. A presigned URL is not an option: Medusa persists
 * the file URL onto every product image, and a presigned one expires, which
 * would turn a catalogue into broken images a few hours after it was built.
 *
 * GET and HEAD only. Nothing here can list, write, or delete, so the bucket's
 * credentials never leave this process and a public URL cannot be turned into
 * anything else.
 *
 * It lives outside the pnpm workspace on purpose. Adding a package under apps/
 * would mean editing the root lockfile that upstream owns, and every sync with
 * upstream would conflict on it.
 */
import http from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AwsClient } from 'aws4fetch'

const PORT = Number(process.env.PORT || 9200)
const BUCKET = requireEnv('S3_BUCKET')
const ENDPOINT = requireEnv('S3_ENDPOINT')
const REGION = process.env.S3_REGION || 'us-east-1'
const FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE === 'true'
const PREFIX = (process.env.S3_PREFIX || '').replace(/^\/+|\/+$/g, '')
const CACHE_CONTROL = process.env.CACHE_CONTROL || 'public, max-age=31536000, immutable'

const client = new AwsClient({
  accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
  secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY'),
  service: 's3',
  region: REGION,
})

/** Headers worth passing through. The rest is the bucket's business, not a browser's. */
const FORWARDED = [
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'accept-ranges',
  'content-range',
]

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    // Fail at boot rather than serving 500s: an unconfigured proxy means every
    // product image on the store is broken, which is worth a failed deploy.
    console.error(`[media-proxy] ${name} is required`)
    process.exit(1)
  }
  return value
}

function objectUrl(key) {
  const endpoint = new URL(ENDPOINT)
  const path = [PREFIX, key].filter(Boolean).join('/')

  if (FORCE_PATH_STYLE) {
    // MinIO and anything else serving buckets as a path segment.
    return new URL(`${endpoint.origin}/${BUCKET}/${encodePath(path)}`)
  }

  // Virtual hosted, which is what Railway buckets and current S3 use.
  return new URL(`${endpoint.protocol}//${BUCKET}.${endpoint.host}/${encodePath(path)}`)
}

/** Each segment is encoded on its own so the slashes survive. */
const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/')

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end('Method not allowed')
    return
  }

  const { pathname } = new URL(req.url, 'http://localhost')

  // Railway's healthcheck, and a readable answer for anyone who opens the root.
  if (pathname === '/' || pathname === '/_health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    return
  }

  const key = decodeURIComponent(pathname.replace(/^\/+/, ''))

  // Traversal cannot reach outside the bucket, but a key with .. in it is never
  // something this proxy wrote, so refuse it rather than signing it.
  if (!key || key.includes('..')) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request')
    return
  }

  try {
    const upstream = await client.fetch(objectUrl(key), {
      method: req.method,
      headers: req.headers.range ? { range: req.headers.range } : undefined,
    })

    const headers = { 'cache-control': CACHE_CONTROL }
    for (const header of FORWARDED) {
      const value = upstream.headers.get(header)
      if (value) {
        headers[header] = value
      }
    }

    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
      // The bucket's own XML error body says more than this needs to.
      res.writeHead(upstream.status === 404 ? 404 : 502, { 'content-type': 'text/plain' })
      res.end(upstream.status === 404 ? 'Not found' : 'Upstream error')
      return
    }

    res.writeHead(upstream.status, headers)

    if (req.method === 'HEAD' || !upstream.body) {
      res.end()
      return
    }

    // pipeline, not a write loop: it honours backpressure, so a slow client
    // cannot make this process hold a whole object in memory, and it tears both
    // streams down on either side failing instead of leaking the upstream one.
    await pipeline(Readable.fromWeb(upstream.body), res)
  } catch (error) {
    console.error(`[media-proxy] ${key}: ${error}`)

    // The bucket can drop the connection partway through a large object, and a
    // browser can walk away mid-download; both throw here with the response
    // already open. Writing a status then would throw ERR_HTTP_HEADERS_SENT out
    // of this handler and take the process down with it, so an interrupted
    // response is aborted instead: one broken image rather than every request on
    // this instance.
    if (res.headersSent) {
      res.destroy()
      return
    }

    res.writeHead(502, { 'content-type': 'text/plain' }).end('Upstream error')
  }
})

// Last resort. Anything that still escapes a request should not be able to exit
// the process and take every other in-flight response with it.
server.on('error', (error) => {
  console.error(`[media-proxy] server error: ${error}`)
})
process.on('unhandledRejection', (error) => {
  console.error(`[media-proxy] unhandled rejection: ${error}`)
})

server.listen(PORT, () => {
  console.log(`[media-proxy] serving ${BUCKET} on ${PORT}`)
})
