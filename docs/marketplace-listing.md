# Marketplace copy

Two listings, one repository. Railway's required section structure, filled in.

The card description is **25 to 75 characters**. The overview must keep every
heading of Railway's required structure, with the template's name interpolated
into each one, or publishing is refused for whichever section it cannot match.

## MedusaJS 2 Full Stack Production Ready

Published at
<https://railway.com/deploy/medusajs-2-full-stack-production-ready>.

Name, 38 characters:

```text
MedusaJS 2 Full Stack Production Ready
```

Short description, 71 of the 75 characters available:

```text
Server + worker, Next.js storefront, search, persistent media, no setup
```

Category: **Starters**. Icon:
`https://user-images.githubusercontent.com/59018053/229103275-b5e482bb-4601-46e6-8142-244f531cebdb.svg`

### Overview, as published

Verbatim, between the rules below, so it can be pasted straight back into the
listing editor. Its own headings are part of the content.

---

# Deploy and Host MedusaJS 2 Full Stack Production Ready on Railway

MedusaJS 2 Full Stack Production Ready is a complete commerce stack deployed the way Medusa's own guide specifies: the API with its admin dashboard, a separate worker for background jobs, a Next.js storefront, PostgreSQL, Redis, and persistent object storage behind a read-only proxy. Seven resources, wired to each other, with no variables to fill in: the deploy form asks only for the bucket's region.

## About Hosting MedusaJS 2 Full Stack Production Ready

Medusa's deployment guide asks for two instances of the application, one serving the API in server mode and one running jobs and subscribers in worker mode, with Redis behind the event bus, workflow engine, locking and cache. Most one-click Medusa templates run a single process and skip some of those modules, which works until a long workflow starts competing with checkout requests. This template deploys the documented topology instead. Migrations, the first admin account, regions, a sales channel, the storefront's publishable key and a demo catalogue are all created on the first deploy, so what finishes building is a working store rather than an empty one waiting to be configured.

## Common Use Cases

- **A production store on your own infrastructure**, with no per-sale fee and no platform lock-in
- **A commerce backend for a storefront you are building yourself**, on Railway or anywhere else
- **A B2B or marketplace build** that starts from a correct deployment instead of a single-process demo
- **Migrating off a hosted platform** onto a stack you can read, change and move

## Dependencies for MedusaJS 2 Full Stack Production Ready Hosting

- **PostgreSQL**, provisioned automatically, connected over Railway's private network rather than the TCP proxy
- **Redis**, provisioned automatically, backing the event bus, workflow engine, locking and cache
- **Railway Storage Bucket**, provisioned automatically, for uploads that survive every redeploy

All three are created and wired with Railway variable references, and every secret is generated at deploy time. Stripe and SendGrid are optional: set a key and the provider is configured, leave it unset and it is absent rather than half configured.

### Deployment Dependencies

- [Source repository](https://github.com/acewebs/medusa-js-railway)
- [Medusa documentation](https://docs.medusajs.com)
- [Medusa's production deployment guide](https://docs.medusajs.com/learn/deployment)

### Implementation Details

#### The server owns migrations, the worker waits for it

```sh
wait_for "$DATABASE_URL"
wait_for "$REDIS_URL"
medusa db:migrate            # server only
medusa exec ./src/scripts/bootstrap.js
wait_for "$MEDUSA_WAIT_FOR"  # worker only
exec medusa start
```

Both Medusa services run the same image and differ only in `MEDUSA_WORKER_MODE`. The API instance's port opens only after migrations and bootstrap succeed, which makes a reachable port the schema's readiness signal for the worker, so the worker never races a database that is still being migrated. A failed migration exits before anything serves traffic: the healthcheck never passes and Railway keeps the previous version live.

Setup lives in the container entrypoint rather than a deploy-time hook, because a published Railway template does not carry pre-deploy commands and anything put there would never run on the deploy that needs it. Bootstrap is idempotent, so a boot interrupted halfway through is repaired by the next one instead of leaving a store with no admin account.

#### A publishable key the storefront can be built with

Next.js inlines its publishable API key into the browser bundle while the image is built, and Railway builds every service in parallel, before the backend has run once. A key the backend generated would therefore never reach the storefront. Here the key is one value both services share, and bootstrap writes it onto the publishable key in the database.

#### Persistent media without a public bucket

Railway Storage Buckets are private and have no public URL, and a presigned URL expires while the URL Medusa stores on a product image has to keep working. A small read-only proxy serves objects from the bucket with cache headers. It can only read: it cannot list, write or delete, so the bucket credentials never leave the server side.

#### Search without another service

Search is Medusa's own index on PostgreSQL. There is no separate search service to pay for, scale or keep in sync.

#### Verified end to end, not just started

```bash
MEDUSA_URL=https://… STOREFRONT_URL=https://… node scripts/smoke-test.mjs
```

The repository ships the smoke test used to check it: admin login, a file upload read back through the proxy, product search, then a real order placed through the store API. 17 checks, because a deploy where every service reads "Online" can still fail most of them.

#### Three things to do before you go live

`MEDUSA_ADMIN_PASSWORD` is generated for you and used only on the first boot. Changing it afterwards does not reset the account, and recovering a lost one needs either `SENDGRID_API_KEY` configured for the admin's own reset email or a manual change in the database. Copy it out of the variables before the store is in use.

`S3_FILE_URL` is written onto every product image as it is uploaded. Changing it later does not rewrite rows that already exist, so if you plan to serve media from a custom domain or a CDN, set that address before building the catalogue.

`SEED_DEMO_DATA` is true by default so the storefront has something to render. Set it to false for an empty store. Deleting the demo products later works too, and they do not come back on redeploy.

#### If you do not need the storefront

A second listing, MedusaJS 2 Production Ready, deploys the backend half only: server, worker, PostgreSQL and Redis, with no storefront, media proxy or bucket. Same repository and same entrypoint, for anyone pointing their own front end at the API.

## Why Deploy MedusaJS 2 Full Stack Production Ready on Railway?

Medusa wants long-lived processes, a database, Redis and object storage in one place, which is exactly what Railway provisions in a single project on a single bill.

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying MedusaJS 2 Full Stack Production Ready on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.

---

## MedusaJS 2 Production Ready

The backend half: medusa-backend, medusa-worker, Postgres, Redis. Four services, no
storefront and no bucket.

Name, 27 characters:

```text
MedusaJS 2 Production Ready
```

Short description, 68 of the 75 characters available:

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
