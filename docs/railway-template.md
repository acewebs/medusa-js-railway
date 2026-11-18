# Publishing this as a Railway template

Notes for whoever maintains the published template. Deploying the repo normally
needs none of this.

## Two ways in, and they do not share configuration

`.railway/railway.ts` describes everything, including the bucket, and is applied
with `railway config apply`. Verified on CLI **5.71.0**, where a `bucket()`
declaration genuinely creates the bucket and its `${{Bucket.*}}` variables
resolve to real credentials. On 5.49.2 it reported success and created nothing,
which is why older notes describe a separate bucket script; that script is gone,
so an older CLI is not supported here.

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
service, update every reference that mentions it. Publishing lowercases every
service name, and rewrites the references to match, so `${{Postgres.*}}` becomes
`${{postgres.*}}` on both sides and stays consistent.

Leave **Root Directory** empty on all four application services. The Dockerfiles
copy from the repository root, so a root directory of `apps/storefront` would cut
the build context down to a directory that cannot install its own dependencies.
The Dockerfile path is set separately and is independent of it.

## Variables

### medusa-backend

```text
RAILWAY_DOCKERFILE_PATH = docker/backend.Dockerfile
PORT                    = 9000
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

`RAILWAY_DOCKERFILE_PATH` is how a Dockerfile outside the repository root is
selected, and it has to be a variable rather than the service's build setting.
Template generation drops the build setting, so a template carrying only that
falls back to Railpack, builds the monorepo root, and fails. Both are set in
`.railway/railway.ts` from one constant each, for the two different paths in.

`PORT` is pinned rather than left to Railway's injected default. Medusa listens
on whatever `PORT` says, and medusa-worker's `MEDUSA_WAIT_FOR` gates on 9000;
without this the server comes up on 8080 and the worker waits forever on a port
nothing is bound to. Nothing fails visibly, because the worker has no
healthcheck, so the deploy is green with no jobs or subscribers running.

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

What the worker runs, and nothing more. Anything only
`src/scripts/bootstrap.ts` reads is absent, because bootstrap runs behind the
`MEDUSA_RUN_MIGRATIONS=true` branch of the entrypoint and that is the server
alone: `MEDUSA_ADMIN_EMAIL`, `MEDUSA_ADMIN_PASSWORD`, `MEDUSA_PUBLISHABLE_KEY`
and `SEED_DEMO_DATA` would never be read here. `MEDUSA_BACKEND_URL` is absent
too, for the same reason it is wrong rather than merely unused: it names the
current service's public domain, and this service has none.

```text
RAILWAY_DOCKERFILE_PATH = docker/backend.Dockerfile
DATABASE_URL            = ${{Postgres.DATABASE_URL}}
REDIS_URL               = ${{Redis.REDIS_URL}}
JWT_SECRET              = ${{medusa-backend.JWT_SECRET}}
COOKIE_SECRET           = ${{medusa-backend.COOKIE_SECRET}}
MEDUSA_WORKER_MODE      = worker
MEDUSA_RUN_MIGRATIONS   = false
DISABLE_MEDUSA_ADMIN    = true
MEDUSA_WAIT_FOR         = ${{medusa-backend.RAILWAY_PRIVATE_DOMAIN}}:9000
STORE_CORS              = https://${{storefront.RAILWAY_PUBLIC_DOMAIN}}
ADMIN_CORS              = ${{medusa-backend.ADMIN_CORS}}
AUTH_CORS               = ${{medusa-backend.AUTH_CORS}}
S3_BUCKET               = ${{Bucket.BUCKET}}
S3_ENDPOINT             = ${{Bucket.ENDPOINT}}
S3_REGION               = ${{Bucket.REGION}}
S3_ACCESS_KEY_ID        = ${{Bucket.ACCESS_KEY_ID}}
S3_SECRET_ACCESS_KEY    = ${{Bucket.SECRET_ACCESS_KEY}}
S3_FILE_URL             = https://${{media-proxy.RAILWAY_PUBLIC_DOMAIN}}
```

`JWT_SECRET` and `COOKIE_SECRET` are **references to medusa-backend, never their
own `secret()`**. A `secret()` expression materialises once per deploy, so
declaring one here would generate a different value and the two services would
disagree.

`ADMIN_CORS` and `AUTH_CORS` are references for a different reason: the
backend's versions are built from `${{RAILWAY_PUBLIC_DOMAIN}}`, which resolves
per service, so copying the expressions here would store `https://` and an empty
origin. `STORE_CORS` needs no reference, since it already names the storefront.

`MEDUSA_WAIT_FOR` is what keeps the worker from racing a half-migrated database,
but an open port is not sufficient proof on its own. Railway keeps the previous
deployment serving until the new one passes its healthcheck, so on every deploy
after the first the port is already open and answered by the _old_ backend while
the new one is still migrating. A worker gated on the port alone would start new
code against the old schema.

So `docker/wait-for-deploy.mjs` polls `/deploy-ready` on this host and port and
blocks until the backend reports the worker's own `RAILWAY_GIT_COMMIT_SHA`. The
backend opens its port only after migrations and bootstrap succeed, so a matching
build is proof the schema is current. Without that variable, which Railway sets
only for GitHub-triggered deploys, it falls back to waiting for the port, which
is still correct on a first deploy. Reference the private domain rather than
hardcoding `medusa-backend.railway.internal`, which freezes on rename.

### storefront

```text
RAILWAY_DOCKERFILE_PATH             = docker/storefront.Dockerfile
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

The five `${{Bucket.*}}` variables, plus
`RAILWAY_DOCKERFILE_PATH = docker/media-proxy.Dockerfile`. Nothing else:
`server.mjs` also reads `PORT`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX` and
`CACHE_CONTROL`, and each has a working default.

## Service settings

| Setting             | medusa-backend | medusa-worker  | storefront     | media-proxy    |
| ------------------- | -------------- | -------------- | -------------- | -------------- |
| Healthcheck path    | `/health`      | none           | `/`            | `/_health`     |
| Healthcheck timeout | 600            |                | 300            | 60             |
| Restart policy      | on failure, 5  | on failure, 10 | on failure, 10 | on failure, 10 |
| Public networking   | yes            | **no**         | yes            | yes            |
| Start command       | empty          | empty          | empty          | empty          |
| Pre-deploy command  | **empty**      | empty          | empty          | empty          |

The healthcheck timeouts apply to `railway config apply` only. A published
template cannot carry them, and the editor has no field for one, so a template
deploy runs on Railway's 300 second default throughout. That turned out not to
matter: on a cold deploy medusa-backend went from DEPLOYING to healthy in about
twenty seconds, migrations, bootstrap and seed included, so the 600 was
cautious rather than necessary.

Only medusa-backend pins a port, to 9000, via `PORT`. The storefront and
media-proxy ignore the `ENV PORT` in their Dockerfiles and listen on Railway's
injected `PORT` instead, which is harmless because nothing references their
ports.

Pre-deploy stays empty because a published template does not carry pre-deploy
commands, so migrations put there would never run on the deploy that needs them.
They run from the image's entrypoint instead, which works however the service was
created. A failed migration exits before the backend starts, the healthcheck never
passes, and Railway keeps the previous version live.

Config as Code (`railway.json` or `railway.toml`) would express both the
Dockerfile path and the healthcheck timeout, and is the obvious-looking fix for
both. It is not one: Railway deprecated it, and it keeps working only for
services created before **2026-12-01**. A template published today creates
services after that date, so a config committed to the repo would silently never
apply. The variable route is the one that survives. This repo describes the
project in `.railway/railway.ts`, which the Railway CLI evaluates; the template
editor reads neither.

## Deploying this repository directly

The services point at `acewebs/medusa-js-railway` (`REPO` in
`.railway/railway.ts`). Change that to your own fork before applying, or the
project deploys this repository rather than yours.

The IaC needs the Railway SDK, which is deliberately **not** a project
dependency: adding it would put our line in the `package.json` and `pnpm-lock.yaml`
that upstream owns, and conflict on every sync. It lives in its own package
instead, the same arrangement `media-proxy/` uses.

```bash
npm --prefix .railway install     # the SDK that evaluates railway.ts
railway login
railway init
railway config apply              # creates the six services and the bucket
railway domain --service medusa-backend
railway domain --service storefront
railway domain --service media-proxy
railway config apply              # again, now that the domains exist
```

**Apply twice, with the domains in between.** The first apply creates the
services and their variables but deploys nothing. Every expression built on a
public domain (`MEDUSA_BACKEND_URL`, the three CORS variables,
`NEXT_PUBLIC_MEDUSA_BACKEND_URL`, `S3_FILE_URL`) resolves to an empty string
until that domain exists, and the storefront bakes its backend URL and
publishable key into the bundle at build time, so a build started before the
domains exist is wrong in a way no restart fixes. The second apply is what
triggers the first deploy, by which point everything resolves.

Verified end to end on 2026-11-09: six services from a cold apply, all SUCCESS in
about 3.5 minutes, and `scripts/smoke-test.mjs` passing 17/17 against the live
URLs.

`.railway/railway.ts` changed on 2026-11-15, to add `PORT`, the four
`RAILWAY_DOCKERFILE_PATH` variables and the worker's trimmed environment. Those
changes are **`railway config plan` verified only**: the plan evaluates and the
diff is exactly the five additions, two CORS corrections and five deletions, but
no cold `railway config apply` has been run since. The equivalent configuration
was proven through the template path instead, which is what the next section
covers.

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

## Using a different search provider

Search is the `@medusajs/search` module. `defineConfig` registers it with the
Postgres provider on its own, which is why `medusa-config.ts` configures no search
module at all and why the template runs no search service: the index is `tsvector`
and `pg_trgm` in the store's own PostgreSQL.

Two things keep the provider replaceable without touching application code.
`apps/backend/src/search/product.ts` declares its fields with `search.define` and
names no provider, and the storefront queries `/store/search` through
`@medusajs/instantsearch-adapter` rather than a vendor client. Neither changes
when the provider does.

Registering the module yourself replaces that default registration, so list
Postgres again unless you mean to drop it:

```ts
{
  resolve: '@medusajs/medusa/search',
  options: {
    providers: [
      { resolve: '@medusajs/medusa/search-postgres', id: 'postgres', options: { engine: 'native' } },
      { resolve: './src/modules/search-elsewhere', id: 'elsewhere' },
    ],
    default_provider: 'search-elsewhere',
  },
}
```

`default_provider`, and the optional `provider` on an index definition, take the
provider class's static `identifier`, not the `id` written here. One registered
provider needs no `default_provider`; two or more do, and an unregistered
identifier throws at boot rather than on the first query.

The swap itself runs as an index migration. Each index version records the
provider that built it, so changing it creates a new physical index, seeds it from
the graph and makes it active only once it is filled, leaving the old one serving
until then. On this template `medusa db:migrate` plans that from medusa-backend's
entrypoint, but **medusa-worker is what seeds it**, because seeding on boot runs
in worker mode only. A deployment cut down to the server alone migrates and then
serves an empty index.

What does not exist, as of Medusa 2.22, is an official Meilisearch or Algolia
provider. The three that do are `search-postgres`, `search-local` (Orama, last
published for 2.19) and the built-in `search-medusa`, which needs Medusa Cloud
credentials. Anything else is a provider you write and maintain against
`ISearchProvider`: index upsert, document upsert and delete, queries with filters,
sorting and facets, and the migration and reseed path above. That is worth doing
for a catalogue that has outgrown PostgreSQL, and not before. The first symptom of
outgrowing it is contention rather than bad results, since facet counts and fuzzy
matching compete with checkout writes for one database, so raise that service's
resources before concluding the engine is the problem.

## Before publishing

Deploy the template into a fresh, empty project and check all of it. A project
you already deployed from hides most of the failures that only happen cold.

Two of these are there because a deploy passed them by looking green. medusa-worker
has no healthcheck, so it reports SUCCESS whether it is draining the queue or
blocked forever in its wait loop; and a service built by the wrong builder also
reports SUCCESS, just running something other than our image. Read the logs, do
not read the status column.

- [ ] All seven resources reach Online, with no restart loops
- [ ] Every build succeeds without a reachable database or backend (Railway builds have no private networking)
- [ ] The medusa-backend log shows migrate, then bootstrap, then "Server is ready"
- [ ] The medusa-backend log says "Server is ready on port: 9000", not 8080
- [ ] The medusa-worker log shows it waiting for medusa-backend, then **getting past the wait** and processing subscribers
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
RAILWAY_DOCKERFILE_PATH Path to the Dockerfile this service builds from. The build context
                        stays at the repository root.
PORT                    Port the Medusa server listens on. Pinned so the worker's
                        MEDUSA_WAIT_FOR target matches. medusa-backend only.
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
MEDUSA_WAIT_FOR         Host and port of the Medusa server. The worker polls it for a build
                        matching its own before starting, so it never runs against a schema
                        that has not been migrated yet.
MEDUSA_BACKEND_URL      Public URL of this service, which the admin dashboard calls. Set for you.
MEDUSA_ADMIN_EMAIL      Email of the admin account created on first boot. Change it before
                        deploying.
MEDUSA_ADMIN_PASSWORD   Password for that account, generated on deploy. Only used the first
                        time: changing it later does not reset the password. Recovering a lost
                        one means creating a second admin with `medusa user`, because Medusa
                        leaves the reset email to the application and this template ships no
                        subscriber for it. Copy it somewhere before the store is in use.
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
RAILWAY_DOCKERFILE_PATH             Path to the Dockerfile this service builds from. The build
                                    context stays at the repository root.
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

media-proxy: the five `S3_` descriptions above, plus `RAILWAY_DOCKERFILE_PATH`.

Postgres and Redis descriptions are Railway's own, and reading them from the CLI
beats rewriting them: an inherited service should read like the one people
already know.

## Generating the draft, and the exact fields to fill afterwards

```bash
railway templates create --project <project> --environment production --json
```

Verified 2026-11-14: **a stopped project serializes completely**, as far as
services go. All six, the bucket, both database volumes, every source, and each
service's healthcheck path, restart policy and public-networking setting came
through from a project whose deployments had all been removed. So there is no
need to pay for a running project just to regenerate.

What generation strips is every **literal** value, while keeping every
`${{ ... }}` expression. It also drops two service settings outright, which is
the part worth knowing before trusting a generated draft:

- **`dockerfilePath`**. Gone, and there is no field for it in the editor. Express
  it as a `RAILWAY_DOCKERFILE_PATH` variable instead, which is why
  `.railway/railway.ts` sets both. Without it Railway falls back to Railpack and
  builds the monorepo root, where `pnpm run build` builds every workspace at once
  and dies on the storefront's missing publishable key.
- **`healthcheckTimeout`**. Also gone, also no field. Deploys run on Railway's
  300 second default, which measurement showed is enough.

Verified the hard way on 2026-11-14: a cold deploy of a draft missing the first
of those failed three of four application services, and the fourth built green
with the wrong builder, which is worse.

**Fill these in the template editor, not on the live services.** There is no API
to edit a stored draft (the schema has no `templateUpdate`, and the only input
accepting a `serializedConfig` is the deploy-time override), so the editor is the
only way in. Setting them on the project first and regenerating would mean typing
them twice. Editing a template that is already **published applies to the live
listing immediately**, with no second publish step and no staging copy.

`railway deploy -t <code> -v "service.KEY=value"` cannot stand in for any of
this. It only fills variables the template already declares, so it will not
inject a missing one.

### medusa-backend, 10 fields

```text
RAILWAY_DOCKERFILE_PATH = docker/backend.Dockerfile
PORT                    = 9000
JWT_SECRET              = ${{secret(48)}}
COOKIE_SECRET           = ${{secret(48)}}
MEDUSA_ADMIN_PASSWORD   = ${{secret(18)}}
MEDUSA_PUBLISHABLE_KEY  = pk_${{secret(48)}}
MEDUSA_ADMIN_EMAIL      = admin@example.com
MEDUSA_WORKER_MODE      = server
MEDUSA_RUN_MIGRATIONS   = true
SEED_DEMO_DATA          = true
```

### medusa-worker, 6 fields, 2 corrections and 5 deletions

The secrets are **references to medusa-backend, never their own `secret()`**. A
`secret()` expression materialises once per deploy, so declaring one separately
here would generate a different value and the two services would disagree.

```text
RAILWAY_DOCKERFILE_PATH = docker/backend.Dockerfile
JWT_SECRET              = ${{medusa-backend.JWT_SECRET}}
COOKIE_SECRET           = ${{medusa-backend.COOKIE_SECRET}}
MEDUSA_WORKER_MODE      = worker
MEDUSA_RUN_MIGRATIONS   = false
DISABLE_MEDUSA_ADMIN    = true
```

Correct these two, which generation carries through unchanged and wrong, because
they are built from the _current_ service's public domain and this service has
none:

```text
ADMIN_CORS              = ${{medusa-backend.ADMIN_CORS}}
AUTH_CORS               = ${{medusa-backend.AUTH_CORS}}
```

Delete these four. Only `src/scripts/bootstrap.ts` reads them, and bootstrap runs
behind the `MEDUSA_RUN_MIGRATIONS=true` branch of the entrypoint, which is the
server alone:

```text
MEDUSA_ADMIN_EMAIL
MEDUSA_ADMIN_PASSWORD
MEDUSA_PUBLISHABLE_KEY
SEED_DEMO_DATA
```

Delete `MEDUSA_BACKEND_URL` too, but for the other reason. `medusa-config.ts`
does read it on both services, so the rule above does not cover it; it is built
from `${{RAILWAY_PUBLIC_DOMAIN}}`, which this service does not have, so it stores
`https://`. Harmless in practice, since it only feeds `admin.backendUrl` on a
service running `DISABLE_MEDUSA_ADMIN=true` and a `secureCookies` fallback that
lands on the same answer either way, but a wrong value is worth removing rather
than keeping.

### storefront, 4 fields

```text
RAILWAY_DOCKERFILE_PATH            = docker/storefront.Dockerfile
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY = ${{medusa-backend.MEDUSA_PUBLISHABLE_KEY}}
NEXT_PUBLIC_DEFAULT_REGION         = dk
NEXT_PUBLIC_STRIPE_KEY             = (empty, and mark it Optional)
```

The publishable key is the one that cannot be left blank: the storefront's build
fails outright without it, so an empty box here is a template that cannot deploy.
`NEXT_PUBLIC_STRIPE_KEY` is the opposite case, and needs the Optional flag as
well as the empty value, or the deploy form demands a Stripe key from everyone.

### media-proxy, 1 field

```text
RAILWAY_DOCKERFILE_PATH = docker/media-proxy.Dockerfile
```

Its five `${{Bucket.*}}` variables survive generation untouched.

### Postgres, 6 fields, and Redis, 2

Easy to miss, because they are inherited rather than ours, and their literals are
stripped exactly like everything else. Empty `REDISPORT` and `REDISUSER` leave
`REDIS_URL` as `redis://:pass@host:`, which nothing connects to.

```text
Postgres  PGDATA                              = /var/lib/postgresql/data/pgdata
Postgres  PGPORT                              = 5432
Postgres  POSTGRES_DB                         = railway
Postgres  POSTGRES_USER                       = postgres
Postgres  RAILWAY_DEPLOYMENT_DRAINING_SECONDS = 60
Postgres  SSL_CERT_DAYS                       = 820   (mark it Optional)
Redis     REDISPORT                           = 6379
Redis     REDISUSER                           = default
```

`PGDATA` is the mount path plus a `pgdata` subdirectory, not the mount path
itself: initdb refuses a directory holding `lost+found`.

### Bucket

Nothing, and nothing available. The editor shows the region as "Selected by the
user": a template cannot set it, and the deployer picks it on the deploy form.

### Then the descriptions

Every required variable needs one before the marketplace will publish, inherited
Postgres and Redis ones included. That is 33 fields in total across the six
services. The wording is in the section above.

## Listing

Two listings from this one repository, sharing its Dockerfiles and docs:

- **MedusaJS 2 Production Ready**: medusa-backend, medusa-worker, Postgres, Redis.
  Four services, for someone building their own storefront. Not published yet.
- **[MedusaJS 2 Full Stack Production Ready](https://railway.com/deploy/medusajs-2-full-stack-production-ready)**:
  the above plus storefront, media-proxy and the bucket. Published 2026-11-14,
  verified cold on 2026-11-15.

File both under **Starters**, not Other. Copy is in
[marketplace-listing.md](marketplace-listing.md).

Two things about the listing form that are not obvious. The card description is
**25 to 75 characters**, and the overview has to keep every heading of Railway's
required structure with the template's name interpolated into each, or publishing
is refused for the section it cannot find. An icon must be a URL ending in an
image extension or a `devicons.railway.app` path; `devicons` has no Medusa entry,
and an unknown name redirects to Railway's own logo rather than failing, so check
what a devicon URL actually resolves to before trusting it.
