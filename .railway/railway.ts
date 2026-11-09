import { bucket, defineRailway, github, postgres, preserve, project, redis, service } from 'railway/iac'

/**
 * The whole stack, with its variables wired between the services. The bucket is
 * provisioned separately by scripts/railway-bucket.sh; see the comment on the S3_
 * variables below for why.
 *
 * Evaluated by the Railway CLI only, so it does not interfere with deploying
 * through the marketplace template or the dashboard:
 *
 *   railway config plan     preview
 *   railway config apply    create or update the project
 *
 * Applying this owns the environment: resources absent from this file are
 * deleted. Do not point it at a project that has anything else in it.
 *
 * The template composer does not read this file. Keep docs/railway-template.md in
 * step with it by hand.
 */
// Must match the region passed to scripts/railway-bucket.sh. Change both together,
// before first deploy: sjc (US West), iad (US East), ams (EU West), sin (Asia Pacific).
const BUCKET_REGION = 'ams'

const REPO = 'acewebs/medusa-js-railway'

export default defineRailway((ctx) => {
  const db = postgres('Postgres')
  const cache = redis('Redis')

  // Declared so that `railway config apply` adopts the bucket instead of offering
  // to delete it, but NOT created here: a bucket() declaration reports success and
  // creates nothing (Railway CLI 5.49.2), which is why scripts/railway-bucket.sh
  // exists. That script names its bucket 'Bucket' and takes the same region, and
  // the two must agree: a region cannot be changed after the bucket is created.
  const media = bucket('Bucket', { region: BUCKET_REGION })

  /**
   * One value, shared by the backend and the storefront. The storefront inlines
   * its publishable key at build time, before the backend has ever run, so the
   * key cannot be something the backend generates: bootstrap writes this exact
   * value onto the publishable key instead.
   *
   * A literal random string rather than `${{ secret() }}`, because a secret()
   * expression on a live service re-evaluates on every read, which would rotate
   * the key and break the storefront. The published template uses secret() there,
   * where it materialises once.
   */
  const publishableKey = `pk_${ctx.randomString('publishable-key', 32)}`

  const s3 = {
    // Created by scripts/railway-bucket.sh, not here, for the reason above.
    // preserve() keeps whatever that script set instead of overwriting it.
    S3_BUCKET: preserve(),
    S3_ENDPOINT: preserve(),
    S3_REGION: preserve(),
    S3_ACCESS_KEY_ID: preserve(),
    S3_SECRET_ACCESS_KEY: preserve(),
  }

  // Read-only public reads from the private bucket. Railway buckets have no
  // public URL of their own, and a presigned one expires, while the URL Medusa
  // writes onto a product image has to keep working.
  const mediaProxy = service('media-proxy', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'docker/media-proxy.Dockerfile' },
    healthcheck: '/_health',
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: 1,
    env: { ...s3 },
  })

  const backendEnv = {
    DATABASE_URL: db.env.DATABASE_URL,
    REDIS_URL: cache.env.REDIS_URL,
    JWT_SECRET: ctx.randomString('jwt-secret', 48),
    COOKIE_SECRET: ctx.randomString('cookie-secret', 48),
    MEDUSA_PUBLISHABLE_KEY: publishableKey,
    MEDUSA_ADMIN_EMAIL: 'admin@example.com',
    MEDUSA_ADMIN_PASSWORD: ctx.randomString('admin-password', 18),
    SEED_DEMO_DATA: 'true',
    ...s3,
    // Uploaded files are served through the proxy, and this URL is persisted onto
    // every product image, so it has to be the public one.
    S3_FILE_URL: `https://${mediaProxy.env.RAILWAY_PUBLIC_DOMAIN}`,
    // Raw Railway expressions rather than node references, because these point at
    // services defined after this object and at the service itself. Rename a
    // service and these have to change with it.
    MEDUSA_BACKEND_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
    STORE_CORS: 'https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}',
    ADMIN_CORS: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
    AUTH_CORS: 'https://${{RAILWAY_PUBLIC_DOMAIN}},https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}',
  }

  // Both this and medusa-worker are the backend, running the same image. They
  // differ only in MEDUSA_WORKER_MODE, whose values are Medusa's own vocabulary:
  // `server` serves the API and admin, `worker` runs jobs and subscribers.
  const backend = service('medusa-backend', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'docker/backend.Dockerfile' },
    healthcheck: '/health',
    // Generous: the first deploy migrates, bootstraps and seeds before the server
    // starts listening.
    healthcheckTimeout: 600,
    deploy: {
      // A failed migration should fail the deploy, not restart forever.
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 5,
    },
    replicas: 1,
    env: {
      ...backendEnv,
      MEDUSA_WORKER_MODE: 'server',
      MEDUSA_RUN_MIGRATIONS: 'true',
    },
  })

  // Same image, jobs and subscribers instead of HTTP. No public domain, and it
  // waits for medusa-backend, which opens its port only once migrations and
  // bootstrap have finished.
  const worker = service('medusa-worker', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'docker/backend.Dockerfile' },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: 1,
    env: {
      ...backendEnv,
      MEDUSA_WORKER_MODE: 'worker',
      MEDUSA_RUN_MIGRATIONS: 'false',
      DISABLE_MEDUSA_ADMIN: 'true',
      MEDUSA_WAIT_FOR: `${backend.env.RAILWAY_PRIVATE_DOMAIN}:9000`,
    },
  })

  const storefront = service('storefront', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'docker/storefront.Dockerfile' },
    healthcheck: '/',
    healthcheckTimeout: 300,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: 1,
    env: {
      // Build arguments as much as runtime variables: Next inlines every
      // NEXT_PUBLIC_ value into the client bundle while the image is built.
      NEXT_PUBLIC_MEDUSA_BACKEND_URL: `https://${backend.env.RAILWAY_PUBLIC_DOMAIN}`,
      NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY: publishableKey,
      NEXT_PUBLIC_DEFAULT_REGION: 'dk',
      NEXT_PUBLIC_BASE_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      // Stripe's publishable key, the counterpart to the backend's
      // STRIPE_API_KEY. Empty by default, like the backend's half, but it has to
      // exist: once a Stripe payment session is created, the starter's checkout
      // throws client side without it.
      NEXT_PUBLIC_STRIPE_KEY: '',
    },
  })

  return project('medusa-js', {
    resources: [backend, worker, storefront, mediaProxy, db, cache, media],
  })
})
