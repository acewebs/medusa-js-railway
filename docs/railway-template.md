# Publishing this as a Railway template

Notes for whoever maintains the published template. Deploying the repo normally
needs none of this.

## Two ways in, and they do not share configuration

`.railway/railway.ts` describes the four services plus Postgres and Redis, and is
applied with `railway config apply`. The bucket is created by
`scripts/railway-bucket.sh`, because a `bucket()` declared in the IaC file reports
"applied" and then does not exist (Railway CLI 5.49.2), leaving every `S3_`
reference resolving to an empty string. Those five variables are marked
`preserve()` in the IaC file so a later apply does not overwrite what the script
set.

The template composer reads neither file. A published template carries only what
was entered in the composer, so everything below has to be re-entered there. Keep
the two in step: a variable changed in `.railway/railway.ts` has to be changed in
the composer too.

## Services

Six, plus the bucket, created in the composer:

1. **medusa-backend**, this repo, `docker/backend.Dockerfile`. API, admin at `/app`, public.
2. **medusa-worker**, this repo, the same Dockerfile. Jobs and subscribers, private.

Both of the first two **are** the backend: one image, one codebase, one database,
differing only in `MEDUSA_WORKER_MODE`. That variable's values are Medusa's own
vocabulary rather than ours, so `medusa-backend` deliberately runs
`MEDUSA_WORKER_MODE=server`. The mismatch is not a leftover.

3. **storefront**, this repo, `docker/storefront.Dockerfile`. Next.js, public.
4. **media-proxy**, this repo, `docker/media-proxy.Dockerfile`. Public reads of the bucket.
5. **Postgres**, Railway's official PostgreSQL.
6. **Redis**, Railway's official Redis.
7. **Bucket**, a Railway Storage Bucket.

The names matter, because the variable references below use them. If you rename a
service, update every reference that mentions it. Set **Root Directory** to the
repository root for all four application services: the Dockerfiles copy from the
root, and the build context is independent of the Dockerfile path.

## Variables

### medusa-backend

```text
DATABASE_URL            = ${{Postgres.DATABASE_URL}}
REDIS_URL               = ${{Redis.REDIS_URL}}
JWT_SECRET              = ${{secret(48)}}
COOKIE_SECRET           = ${{secret(48)}}
MEDUSA_WORKER_MODE      = server
MEDUSA_RUN_MIGRATIONS   = true
MEDUSA_BACKEND_URL      = https://${{RAILWAY_PUBLIC_DOMAIN}}
MEDUSA_ADMIN_EMAIL      = admin@example.com
MEDUSA_ADMIN_PASSWORD   = ${{secret(18)}}
MEDUSA_PUBLISHABLE_KEY  = pk_${{secret(48)}}
SEED_DEMO_DATA          = true
STORE_CORS              = https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}
ADMIN_CORS              = https://${{RAILWAY_PUBLIC_DOMAIN}}
AUTH_CORS               = https://${{RAILWAY_PUBLIC_DOMAIN}},https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}
S3_BUCKET               = ${{Bucket.BUCKET}}
S3_ENDPOINT             = ${{Bucket.ENDPOINT}}
S3_REGION               = ${{Bucket.REGION}}
S3_ACCESS_KEY_ID        = ${{Bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY    = ${{Bucket.SECRET_ACCESS_KEY}}
S3_FILE_URL             = https://${{media-proxy.RAILWAY_PUBLIC_DOMAIN}}
```

Optional, and absent rather than empty when unused: `STRIPE_API_KEY`,
`STRIPE_WEBHOOK_SECRET`, `SENDGRID_API_KEY`, `SENDGRID_FROM`.

Stripe takes two variables on two services. `STRIPE_API_KEY` here is the secret
key, and the storefront needs the publishable one in `NEXT_PUBLIC_STRIPE_KEY`, or
its checkout throws as soon as a Stripe payment session exists. Setting only one
half is worse than setting neither.

`${{Postgres.DATABASE_URL}}` is Railway's private-network connection string. Do
not use `DATABASE_PUBLIC_URL`: it routes through the TCP proxy, which is slower
and billed as egress.

`pk_${{secret(48)}}` is the one variable worth understanding before changing
anything. The storefront inlines its publishable key into the client bundle at
build time, and on Railway every service builds in parallel, before this backend
has ever run, so the key cannot be something the backend generates and the
storefront discovers later. It is an input both sides share instead, and
bootstrap writes that exact value onto the publishable key. `secret()`
materialises once inside a template deploy, so both services see the same value.

### medusa-worker

Everything from medusa-backend except `MEDUSA_BACKEND_URL`, with these changed:

```text
MEDUSA_WORKER_MODE      = worker
MEDUSA_RUN_MIGRATIONS   = false
DISABLE_MEDUSA_ADMIN    = true
MEDUSA_WAIT_FOR         = ${{medusa-backend.RAILWAY_PRIVATE_DOMAIN}}:9000
MEDUSA_PUBLISHABLE_KEY  = ${{medusa-backend.MEDUSA_PUBLISHABLE_KEY}}
```

`MEDUSA_WAIT_FOR` is what keeps the worker from racing a half-migrated database:
medusa-backend opens its port only after migrations and bootstrap have finished, so a
reachable port is the schema's readiness signal. Reference the private domain
rather than hardcoding `medusa-backend.railway.internal`, which freezes on rename.

### storefront

```text
NEXT_PUBLIC_MEDUSA_BACKEND_URL      = https://${{medusa-backend.RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY  = ${{medusa-backend.MEDUSA_PUBLISHABLE_KEY}}
NEXT_PUBLIC_DEFAULT_REGION          = dk
NEXT_PUBLIC_BASE_URL                = https://${{RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_STRIPE_KEY              = (empty)
```

All five are build arguments as much as runtime variables. Railway passes a
service variable to the build as a build argument of the same name, and the
Dockerfile declares an `ARG` for each.

### media-proxy

The five `${{Bucket.*}}` variables, nothing else.

## Service settings

| Setting | medusa-backend | medusa-worker | storefront | media-proxy |
| --- | --- | --- | --- | --- |
| Healthcheck path | `/health` | none | `/` | `/_health` |
| Healthcheck timeout | 600 | | 300 | 60 |
| Restart policy | on failure, 5 | on failure, 10 | on failure, 10 | on failure, 10 |
| Public networking | yes, port 9000 | **no** | yes, port 8000 | yes, port 9200 |
| Start command | empty | empty | empty | empty |
| Pre-deploy command | **empty** | empty | empty | empty |

The generous healthcheck timeout on medusa-backend is deliberate: its first deploy
migrates, bootstraps and seeds a demo catalogue before it starts listening.

Pre-deploy stays empty because a published template does not carry pre-deploy
commands, so migrations put there would never run on the deploy that needs them.
They run from the image's entrypoint instead, which works however the service was
created. A failed migration exits before the backend starts, the healthcheck never
passes, and Railway keeps the previous version live.

Railway's Config as Code (`railway.json`) is deprecated and is not read at all for
services created from now on, so a healthcheck committed to the repo would
silently never apply. This repo describes the project in `.railway/railway.ts`,
which the Railway CLI evaluates; the composer does not read that either.

## Deploying this repository directly

The services point at `acewebs/medusa-js-railway` (`REPO` in
`.railway/railway.ts`). Change that to your own fork before applying, or the
project deploys this repository rather than yours.

```bash
railway login
railway init
railway config apply              # six services, variables wired
scripts/railway-bucket.sh ams     # bucket + its five variables, three services
railway domain --service medusa-backend
railway domain --service storefront
railway domain --service media-proxy
railway redeploy --service medusa-backend
railway redeploy --service medusa-worker
railway redeploy --service storefront
railway redeploy --service media-proxy
```

The domains come before the redeploys on purpose: the storefront bakes the
backend's public domain into its bundle at build time, and the backend's CORS
depends on the storefront's. Both resolve to empty strings until the domains
exist.

Read the resulting state back rather than trusting the command's output. Both
`railway config apply` and template generation report success while quietly doing
less than they said.

## Using something other than a Railway bucket

The S3 configuration is plain env, so any S3-compatible provider works:
Cloudflare R2, AWS S3, or a MinIO you run yourself. Point `S3_BUCKET`,
`S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` at it
on medusa-backend, medusa-worker and media-proxy.

**The media proxy exists only because Railway buckets are private.** A provider
that serves public reads of its own, which R2 with a public bucket or a CDN domain
does, does not need it: set `S3_FILE_URL` to that public base URL and delete the
media-proxy service. Set `S3_FORCE_PATH_STYLE=true` for a provider that serves
buckets as a path segment, such as MinIO. Nothing else changes.

One caveat worth knowing before choosing: `S3_FILE_URL` is written onto every
product image as it is uploaded. Changing it later does not rewrite the rows that
already exist, so pick the public address before the catalogue is built, or be
ready to update those URLs by hand.

## Before publishing

Deploy the template into a fresh, empty project and check all of it. A project
you already deployed from hides most of the failures that only happen cold.

- [ ] All seven resources reach Online, with no restart loops
- [ ] Every build succeeds without a reachable database or backend (Railway builds have no private networking)
- [ ] The medusa-backend log shows migrate, then bootstrap, then "Server is ready"
- [ ] The medusa-worker log shows it waiting for medusa-backend, then starting in worker mode
- [ ] `/health` returns 200 and `/app` loads
- [ ] The generated `MEDUSA_ADMIN_PASSWORD` logs in to the admin
- [ ] `node scripts/smoke-test.mjs` passes against the deployed URLs
- [ ] The storefront lists products, a product page renders, and search returns hits
- [ ] An image uploaded in the admin renders in the admin and through the media proxy
- [ ] The uploaded image still loads after restarting medusa-backend
- [ ] Orders still exist after restarting Postgres
- [ ] A redeploy with no schema change starts cleanly, reseeds nothing, and does not reset the admin password
- [ ] Deleting the demo products and redeploying does not bring them back
- [ ] Adding a custom domain does not break the admin or the storefront

## Variable descriptions

Railway will not publish a template until every required variable has one, including
inherited ones like `PGHOST` and `PGDATA`. Budget for it, and take the wording for
anything inherited from Railway's own published templates, readable from the CLI:

```bash
railway api 'query { template(code: "postgres") { serializedConfig } }'
```

medusa-backend and medusa-worker:

```text
DATABASE_URL            Connection to the Postgres service in this project. Set for you.
REDIS_URL               Connection to the Redis service in this project. Set for you. Redis
                        backs the event bus, workflow engine, locking and cache.
JWT_SECRET              Signs admin and customer authentication tokens. Generated on deploy.
                        Changing it signs everyone out.
COOKIE_SECRET           Signs session cookies. Generated on deploy. Changing it signs
                        everyone out.
MEDUSA_WORKER_MODE      server for the instance serving the API and admin, worker for the one
                        running jobs and subscribers. Do not run two servers.
MEDUSA_RUN_MIGRATIONS   Whether this service applies database migrations on boot. True on the
                        server only, so two services never migrate at once.
DISABLE_MEDUSA_ADMIN    Hides the admin dashboard on the worker, which runs the same image.
MEDUSA_WAIT_FOR         Host and port the worker waits for before starting, so it never races
                        a database that is still being migrated.
MEDUSA_BACKEND_URL      Public URL of this service, which the admin dashboard calls. Set for you.
MEDUSA_ADMIN_EMAIL      Email of the admin account created on first boot. Change it before
                        deploying.
MEDUSA_ADMIN_PASSWORD   Password for that account, generated on deploy. Only used the first
                        time: changing it later does not reset the password, and recovering a
                        lost one needs either SENDGRID_API_KEY configured for the admin's own
                        reset email or a manual change in the database. Copy it somewhere
                        before the store is in use.
MEDUSA_PUBLISHABLE_KEY  Publishable API key the storefront authenticates with. Generated on
                        deploy and written onto the key in the database, because the
                        storefront needs it while it is being built.
SEED_DEMO_DATA          Seeds a demo catalogue on first boot. Set it to false for an empty
                        store. Deleting the products later does not bring them back.
STORE_CORS              Origins allowed to call the store API. The storefront's domain.
ADMIN_CORS              Origins allowed to call the admin API. This service's own domain.
AUTH_CORS               Origins allowed to authenticate. Both domains.
S3_BUCKET               Bucket uploaded files are written to. Set from the Bucket in this
                        project, so uploads survive redeploys and restarts.
S3_ENDPOINT             S3 API endpoint for the bucket. Set from the Bucket in this project
                        rather than hardcoded, because it can differ per bucket.
S3_REGION               Region the bucket was created in. Set from the Bucket in this project.
                        A bucket cannot be moved to another region later.
S3_ACCESS_KEY_ID        Access key ID for the bucket. Set from the Bucket in this project.
S3_SECRET_ACCESS_KEY    Secret access key for the bucket. Set from the Bucket in this project.
S3_FILE_URL             Public base URL for uploaded files, which is the media proxy. Stored
                        on every product image, so it has to stay reachable.
```

storefront:

```text
NEXT_PUBLIC_MEDUSA_BACKEND_URL      Public URL of the Medusa server. Set for you. Baked into
                                    the storefront at build time.
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY  Publishable API key, taken from the Medusa server. Set for
                                    you.
NEXT_PUBLIC_DEFAULT_REGION          Country code the storefront falls back to, lowercase. The
                                    seeded region covers gb, de, dk, se, fr, es and it.
NEXT_PUBLIC_BASE_URL                Public URL of the storefront, used for canonical URLs, the
                                    sitemap and robots.txt. Set for you.
NEXT_PUBLIC_STRIPE_KEY              Stripe publishable key, the counterpart to medusa-backend's
                                    STRIPE_API_KEY. Leave it empty unless you use Stripe:
                                    checkout fails client side if a Stripe payment session is
                                    created and this is unset.
```

media-proxy: the five `S3_` descriptions above.

Expect to re-enter literal defaults by hand. Generating a template from a working
project keeps `${{ ... }}` expressions and **strips every literal value**, so
`MEDUSA_WORKER_MODE`, `SEED_DEMO_DATA` and the rest come back as required boxes
with no default, which quietly destroys the zero-configuration claim.

## Listing

Two listings from this one repository, sharing its Dockerfiles and docs:

- **MedusaJS 2 Production Ready**: medusa-backend, medusa-worker, Postgres, Redis.
  Four services, for someone building their own storefront.
- **MedusaJS 2 Full Stack Production Ready**: the above plus storefront,
  media-proxy and the bucket.

File both under **Starters**, not Other. Copy is in
[marketplace-listing.md](marketplace-listing.md).
