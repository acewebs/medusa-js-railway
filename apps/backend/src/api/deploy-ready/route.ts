/**
 * Answers whether the caller's build is the one that owns the current schema.
 *
 * medusa-worker polls this before starting. Waiting for the port alone is not
 * enough: Railway keeps the previous deployment serving until the new one
 * passes its healthcheck, so on every deploy after the first, port 9000 is
 * already open and answered by the *old* backend while the new one is still
 * migrating. A worker gated on the port would start new code against the old
 * schema. The server opens its port only after migrations and bootstrap
 * succeed, so agreement here is proof the schema is current.
 *
 * The caller sends its own build and gets back a boolean, rather than this
 * returning the build. Medusa serves every route on one listener, and this
 * service is public, so returning it would disclose the live commit of what
 * may be a private fork to anyone who asks. A caller that does not already
 * know the build learns nothing.
 */
import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'

// Same precedence as docker/wait-for-deploy.mjs, which calls this.
// MEDUSA_SCHEMA_VERSION is the override docker-compose.yml sets locally, where
// Railway's own variable does not exist.
const build = () => process.env.MEDUSA_SCHEMA_VERSION || process.env.RAILWAY_GIT_COMMIT_SHA || ''

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const asked = typeof req.query.build === 'string' ? req.query.build : ''
  res.json({ ready: asked !== '' && asked === build() })
}
