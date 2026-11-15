import { bucket, defineRailway, github, postgres, project, redis, service } from 'railway/iac'

/**
 * The whole stack, with its variables wired between the services.
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
 *
 * Needs the Railway SDK, which lives in .railway/package.json rather than the
 * repository's own, so upstream's manifest and lockfile stay untouched:
 *
 *   npm --prefix .railway install
 */
// Set before the first apply: sjc (US West), iad (US East), ams (EU West),
// sin (Asia Pacific). A bucket cannot be moved to another region afterwards.
const BUCKET_REGION = 'ams'

const REPO = 'acewebs/medusa-js-railway'

/**
 * Railway resolves a Dockerfile outside the repository root from either the
 * service's build setting or a `RAILWAY_DOCKERFILE_PATH` variable. Both are set
 * here, from one constant each, because they serve different paths in: the build
 * setting is what `railway config apply` writes, and the variable is the only
 * one of the two that survives template generation. A published template that
 * carries just the build setting falls back to Railpack and builds the monorepo
 * root, which fails.
 */
const BACKEND_DOCKERFILE = 'docker/backend.Dockerfile'
const STOREFRONT_DOCKERFILE = 'docker/storefront.Dockerfile'
const MEDIA_PROXY_DOCKERFILE = 'docker/media-proxy.Dockerfile'

// One constant, because two places need to agree: the port medusa-backend
// listens on, and the port medusa-worker waits for before it starts. Changing
// one alone puts the worker back to waiting forever on an unbound port.
const BACKEND_PORT = '9000'

export default defineRailway((ctx) => {
  const db = postgres('Postgres')
  const cache = redis('Redis')

  // Created here, verified on CLI 5.71.0. On 5.49.2 this reported success and
  // created nothing, so the S3_ variables had to be set by a separate script;
  // that is no longer true and the script is gone.
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

  // Raw expressions rather than `media.env.*`, for the same reason as every other
  // reference here: the expression form is the one that survives composition and
  // is what the template composer needs anyway.
  const s3 = {
    S3_BUCKET: '${{Bucket.BUCKET}}',
    S3_ENDPOINT: '${{Bucket.ENDPOINT}}',
    S3_REGION: '${{Bucket.REGION}}',
    S3_ACCESS_KEY_ID: '${{Bucket.ACCESS_KEY_ID}}',
    S3_SECRET_ACCESS_KEY: '${{Bucket.SECRET_ACCESS_KEY}}',
  }

  // Read-only public reads from the private bucket. Railway buckets have no
  // public URL of their own, and a presigned one expires, while the URL Medusa
  // writes onto a product image has to keep working.
  const mediaProxy = service('media-proxy', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: MEDIA_PROXY_DOCKERFILE },
    healthcheck: '/_health',
    healthcheckTimeout: 60,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: 1,
    env: { ...s3, RAILWAY_DOCKERFILE_PATH: MEDIA_PROXY_DOCKERFILE },
  })

  /**
   * Everything both Medusa services need. Two different things keep a variable
   * out of here, and the second one is the trap:
   *
   * 1. Only `src/scripts/bootstrap.ts` reads it. Bootstrap runs behind the
   *    entrypoint's `MEDUSA_RUN_MIGRATIONS=true` branch, which is the server
   *    alone, so the variable is dead weight on the worker.
   * 2. Its value is built from `${{RAILWAY_PUBLIC_DOMAIN}}`, which resolves
   *    against whichever service evaluates it. medusa-config.ts reads
   *    MEDUSA_BACKEND_URL, ADMIN_CORS and AUTH_CORS on both services, so by
   *    rule 1 they belong here, but the worker has no public domain and would
   *    store "https://" and an empty origin. The worker takes the two it needs
   *    as references to the server instead.
   *
   * So "medusa-config.ts reads it" is not sufficient grounds to move something
   * into this object. Check what the value is composed from as well.
   */
  const sharedEnv = {
    DATABASE_URL: db.env.DATABASE_URL,
    REDIS_URL: cache.env.REDIS_URL,
    JWT_SECRET: ctx.randomString('jwt-secret', 48),
    COOKIE_SECRET: ctx.randomString('cookie-secret', 48),
    ...s3,
    // Uploaded files are served through the proxy, and this URL is persisted onto
    // every product image, so it has to be the public one.
    S3_FILE_URL: 'https://${{media-proxy.RAILWAY_PUBLIC_DOMAIN}}',
    // Raw Railway expressions throughout, not node references. A node reference
    // works when assigned directly (DATABASE_URL above), but interpolating one
    // into a template literal stringifies it to "[object Object]" and Railway
    // stores that, with no error at plan or apply time. Anything composed with a
    // host or a scheme therefore has to be written as an expression. Rename a
    // service and these have to change with it.
    //
    // This one names the storefront rather than the current service, so it
    // resolves identically on both Medusa services.
    STORE_CORS: 'https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}',
  }

  // Bootstrap-only, or built from this service's own public domain. Either way,
  // the server's alone. See the two rules above.
  const serverEnv = {
    MEDUSA_PUBLISHABLE_KEY: publishableKey,
    MEDUSA_ADMIN_EMAIL: 'admin@example.com',
    MEDUSA_ADMIN_PASSWORD: ctx.randomString('admin-password', 18),
    SEED_DEMO_DATA: 'true',
    MEDUSA_BACKEND_URL: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
    ADMIN_CORS: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
    AUTH_CORS: 'https://${{RAILWAY_PUBLIC_DOMAIN}},https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}',
  }

  // Both this and medusa-worker are the backend, running the same image. They
  // differ only in MEDUSA_WORKER_MODE, whose values are Medusa's own vocabulary:
  // `server` serves the API and admin, `worker` runs jobs and subscribers.
  const backend = service('medusa-backend', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: BACKEND_DOCKERFILE },
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
      ...sharedEnv,
      ...serverEnv,
      RAILWAY_DOCKERFILE_PATH: BACKEND_DOCKERFILE,
      MEDUSA_WORKER_MODE: 'server',
      MEDUSA_RUN_MIGRATIONS: 'true',
      // Pinned, not left to Railway's injected default. Medusa listens on
      // whatever PORT says, and medusa-worker's MEDUSA_WAIT_FOR gates on 9000;
      // without this the server comes up on 8080 and the worker waits forever
      // on a port nothing is bound to, while still reporting a healthy deploy.
      PORT: BACKEND_PORT,
    },
  })

  // Same image, jobs and subscribers instead of HTTP. No public domain, and it
  // waits for medusa-backend, which opens its port only once migrations and
  // bootstrap have finished.
  const worker = service('medusa-worker', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: BACKEND_DOCKERFILE },
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: 1,
    env: {
      ...sharedEnv,
      RAILWAY_DOCKERFILE_PATH: BACKEND_DOCKERFILE,
      MEDUSA_WORKER_MODE: 'worker',
      MEDUSA_RUN_MIGRATIONS: 'false',
      DISABLE_MEDUSA_ADMIN: 'true',
      MEDUSA_WAIT_FOR: `\${{medusa-backend.RAILWAY_PRIVATE_DOMAIN}}:${BACKEND_PORT}`,
      // Taken from the server rather than written again here. Both expressions
      // name the *current* service's public domain, and this one has none, so
      // declaring them locally would store "https://" and an empty origin.
      ADMIN_CORS: '${{medusa-backend.ADMIN_CORS}}',
      AUTH_CORS: '${{medusa-backend.AUTH_CORS}}',
    },
  })

  const storefront = service('storefront', {
    source: github(REPO, { branch: 'main' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: STOREFRONT_DOCKERFILE },
    healthcheck: '/',
    healthcheckTimeout: 300,
    deploy: { restartPolicyType: 'ON_FAILURE', restartPolicyMaxRetries: 10 },
    replicas: 1,
    env: {
      RAILWAY_DOCKERFILE_PATH: STOREFRONT_DOCKERFILE,
      // Build arguments as much as runtime variables: Next inlines every
      // NEXT_PUBLIC_ value into the client bundle while the image is built.
      NEXT_PUBLIC_MEDUSA_BACKEND_URL: 'https://${{medusa-backend.RAILWAY_PUBLIC_DOMAIN}}',
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
