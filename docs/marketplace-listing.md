# Marketplace copy

Two listings, one repository. Railway's required section structure, filled in.

## MedusaJS 2 Full Stack Production Ready

Name, 38 characters:

```text
MedusaJS 2 Full Stack Production Ready
```

Short description, 71 of the 72 characters available:

```text
Server + worker, Next.js storefront, search, persistent media, no setup
```

### Deploy and Host MedusaJS 2 Full Stack Production Ready on Railway

MedusaJS 2 Full Stack Production Ready deploys a complete commerce stack: the
Medusa API with its admin dashboard, a separate worker for background jobs, a
Next.js storefront, PostgreSQL, Redis, and persistent object storage with a
read-only proxy in front of it. It is built on the monorepo `create-medusa-app`
scaffolds today, so it is a normal Medusa project you can keep developing, not a
fork that has drifted from upstream.

Migrations, the first admin account, regions, a sales channel, the storefront's
publishable API key and a demo catalogue are all created on the first deploy.
There is nothing to fill in and no shell to open.

### About Hosting MedusaJS 2 Full Stack Production Ready

Medusa's own deployment guide asks for two instances of the application, one
serving the API in server mode and one running jobs and subscribers in worker
mode, with Redis behind the event bus, the workflow engine, locking and the cache.
Most one-click Medusa templates run a single process and skip some of those
modules, which works until a long workflow starts competing with checkout
requests.

This template deploys the documented topology. Both Medusa services run the same
image and differ only in `MEDUSA_WORKER_MODE`, the worker waits for the API
instance before starting so it never races a database that is still being
migrated, and only that instance applies migrations.

Setup is part of the image rather than a deploy-time hook, because a published
Railway template does not carry pre-deploy commands: anything put there never runs
on the deploy that needs it. So the container entrypoint waits for Postgres and
Redis, applies migrations, runs an idempotent bootstrap, and only then starts
listening. A boot interrupted halfway through is repaired by the next one instead
of leaving a store with no admin account.

Search is Medusa's own index on PostgreSQL. There is no separate search service to
pay for or keep in sync.

### Common Use Cases

- **A production store on your own infrastructure**, with no per-sale fee and no platform lock-in
- **A commerce backend** for a storefront you are building yourself, on Railway or anywhere else
- **A B2B or marketplace build** that starts from a correct deployment instead of a single-process demo
- **Migrating off a hosted platform** onto a stack you can read, change and move

### Dependencies for MedusaJS 2 Full Stack Production Ready Hosting

- **PostgreSQL**, provisioned automatically, connected over Railway's private network
- **Redis**, provisioned automatically, backing the event bus, workflow engine, locking and cache
- **Railway Storage Bucket**, provisioned automatically, for uploads that survive every redeploy

All three are created and wired with Railway variable references. Secrets are
generated at deploy time. Stripe and SendGrid are optional: set a key and the
provider is configured, leave it unset and it is absent rather than half
configured.

#### Implementation Details

**The server owns migrations, the worker waits for it**

```sh
wait_for "$DATABASE_URL"
wait_for "$REDIS_URL"
medusa db:migrate            # server only
medusa exec ./src/scripts/bootstrap.js
wait_for "$MEDUSA_WAIT_FOR"  # worker only
exec medusa start
```

The API instance's port opens only after migrations and bootstrap succeed, which makes a
reachable port the schema's readiness signal for the worker. A failed migration
exits before anything serves traffic, so the healthcheck never passes and Railway
keeps the previous version live.

**A publishable key the storefront can be built with**

Next.js inlines its publishable API key into the browser bundle while the image is
built, and Railway builds every service in parallel, before the backend has run
once. A key the backend generates would therefore never reach the storefront. Here
the key is one value both services share, and bootstrap writes it onto the
publishable key in the database.

**Persistent media without a public bucket**

Railway Storage Buckets are private and have no public URL, and a presigned URL
expires while the URL Medusa stores on a product image has to keep working. A
small read-only proxy serves objects from the bucket with cache headers. It can
only read: it cannot list, write or delete, so the bucket credentials never leave
the server side.

**Verified end to end, not just started**

```bash
MEDUSA_URL=https://… STOREFRONT_URL=https://… node scripts/smoke-test.mjs
```

The repository ships the smoke test used to check it: admin login, a file upload
read back through the proxy, product search, then a real order placed through the
store API. A deploy where every service reads "Online" can still fail most of it.

### Why Deploy MedusaJS 2 Full Stack Production Ready on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will
host your infrastructure so you don't have to deal with configuration, while
allowing you to vertically and horizontally scale it.

Medusa wants long-lived processes, a database, Redis and object storage in one
place, which is exactly what Railway provisions in a single project on a single
bill. By deploying MedusaJS 2 Full Stack Production Ready on Railway, you are one
step closer to supporting a complete full-stack application with minimal burden.

## MedusaJS 2 Production Ready

The backend half: medusa-backend, medusa-worker, Postgres, Redis. Four services, no
storefront and no bucket.

Name, 27 characters:

```text
MedusaJS 2 Production Ready
```

Short description, 68 of the 72 characters available:

```text
Server + worker, Redis modules, migrations and admin on first deploy
```

The body is the full-stack copy with the storefront, media proxy and bucket
sections removed, and this paragraph in place of the storefront use case:

> It deploys the commerce engine and its admin dashboard, not a storefront. Point
> your own front end at the API with the publishable key the first deploy creates,
> and add the storefront later from the full-stack template if you want one.

The two names are written to divide the work: the shared prefix wins the search,
and each short description spends its budget on what the name cannot say. Neither
repeats "Medusa" or "Railway", which the listing already says twice.
