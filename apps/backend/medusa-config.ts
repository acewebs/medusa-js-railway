import { defineConfig, loadEnv } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

const isTrue = (value?: string) => value === 'true' || value === '1'

const REDIS_URL = process.env.REDIS_URL
const S3_BUCKET = process.env.S3_BUCKET
const BACKEND_URL = process.env.MEDUSA_BACKEND_URL

/**
 * Medusa marks the admin session cookie Secure whenever NODE_ENV is production,
 * and this image runs production everywhere including locally. Over plain HTTP
 * express-session then refuses to set the cookie at all, with no error: the
 * login call returns 200, no Set-Cookie comes back, and the dashboard's next
 * request is a 401. The admin panel is simply unusable.
 *
 * So derive it from the address the admin is actually served on. HTTPS keeps
 * Secure, a local HTTP stack can still log in, and an unset URL falls back to
 * Medusa's own rule rather than silently downgrading a real deployment.
 */
const secureCookies = BACKEND_URL
  ? BACKEND_URL.startsWith('https://')
  : process.env.NODE_ENV === 'production'

/**
 * Railway's private network resolves to IPv6 only, and ioredis defaults to an
 * IPv4 lookup. family 0 lets it use whichever the DNS answer carries, so the
 * same URL works locally and on Railway.
 */
const redisOptions = { family: 0 }

/**
 * Production infrastructure, per Medusa's deployment guide: Redis for the event
 * bus, the workflow engine, locking and caching. Each one is added only when
 * REDIS_URL is set, so a clone with nothing but Postgres still boots on the
 * in-memory defaults.
 */
const redisModules = REDIS_URL
  ? [
      {
        resolve: '@medusajs/medusa/event-bus-redis',
        options: { redisUrl: REDIS_URL, redisOptions },
      },
      {
        resolve: '@medusajs/medusa/workflow-engine-redis',
        options: { redis: { redisUrl: REDIS_URL, redisOptions } },
      },
      {
        resolve: '@medusajs/medusa/locking',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/locking-redis',
              id: 'locking-redis',
              is_default: true,
              options: { redisUrl: REDIS_URL, redisOptions },
            },
          ],
        },
      },
      {
        resolve: '@medusajs/medusa/caching',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/caching-redis',
              id: 'caching-redis',
              is_default: true,
              options: { redisUrl: REDIS_URL, redisOptions },
            },
          ],
        },
      },
    ]
  : []

/**
 * Uploads go to object storage rather than the container filesystem, which does
 * not survive a redeploy. `file_url` is persisted onto every product image, so
 * it has to be an address a browser can reach: the media proxy, not the private
 * S3 endpoint. Railway buckets are private and have no public URL of their own.
 */
const fileModules = S3_BUCKET
  ? [
      {
        resolve: '@medusajs/medusa/file',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/file-s3',
              id: 's3',
              options: {
                file_url: process.env.S3_FILE_URL,
                bucket: S3_BUCKET,
                endpoint: process.env.S3_ENDPOINT,
                region: process.env.S3_REGION,
                access_key_id: process.env.S3_ACCESS_KEY_ID,
                secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
                cache_control: process.env.S3_CACHE_CONTROL || 'public, max-age=31536000',
                // No ACL header at all. Railway buckets reject one, and so does
                // any S3 bucket with Block Public Access or BucketOwnerEnforced.
                acl: false,
                // MinIO locally. Railway buckets are virtual hosted, so this is
                // false there.
                ...(isTrue(process.env.S3_FORCE_PATH_STYLE)
                  ? { additional_client_config: { forcePathStyle: true } }
                  : {}),
              },
            },
          ],
        },
      },
    ]
  : []

/** Optional, and absent rather than half configured when the key is missing. */
const stripeModules = process.env.STRIPE_API_KEY
  ? [
      {
        resolve: '@medusajs/medusa/payment',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/payment-stripe',
              id: 'stripe',
              options: {
                apiKey: process.env.STRIPE_API_KEY,
                webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
              },
            },
          ],
        },
      },
    ]
  : []

/**
 * SendGrid over its HTTPS API, not SMTP: Railway blocks outbound SMTP, so an
 * SMTP transport times out rather than failing fast.
 */
const notificationModules = process.env.SENDGRID_API_KEY
  ? [
      {
        resolve: '@medusajs/medusa/notification',
        options: {
          providers: [
            {
              resolve: '@medusajs/medusa/notification-sendgrid',
              id: 'sendgrid',
              options: {
                channels: ['email'],
                api_key: process.env.SENDGRID_API_KEY,
                from: process.env.SENDGRID_FROM,
              },
            },
          ],
        },
      },
    ]
  : []

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    // Server, worker, or shared. Production runs one of each; a single shared
    // instance is the local default.
    workerMode: (process.env.MEDUSA_WORKER_MODE as 'shared' | 'worker' | 'server') || 'shared',
    redisUrl: REDIS_URL,
    redisOptions,
    cookieOptions: {
      secure: secureCookies,
      // Kept at lax rather than none even when not secure: none would let the
      // cookie ride cross-site POSTs, which is the CSRF hole Medusa closed in
      // GHSA-jhvc-qx3m-6r3q.
      sameSite: 'lax',
    },
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET,
      cookieSecret: process.env.COOKIE_SECRET,
    },
  },
  admin: {
    // The worker runs the same image and must not serve the dashboard. Only ever
    // set at runtime: disabling it during `medusa build` would leave the image
    // without an admin to serve.
    disable: isTrue(process.env.DISABLE_MEDUSA_ADMIN),
    // Where the dashboard sends its API requests. Without it the admin calls
    // its own origin, which is right locally and wrong behind a custom domain.
    backendUrl: BACKEND_URL,
  },
  modules: [
    ...redisModules,
    ...fileModules,
    ...stripeModules,
    ...notificationModules,
  ],
})
