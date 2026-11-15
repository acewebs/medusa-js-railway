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

## Quick Start

1. Click **Deploy** and pick a region for the storage bucket.
2. Wait for the services to go green. Around four minutes in our test.
3. Open the **storefront** URL. It already has a catalogue, regions and search.
4. Open the **medusa-backend** URL at `/app` for the admin dashboard.
5. Sign in with `MEDUSA_ADMIN_EMAIL` and `MEDUSA_ADMIN_PASSWORD` from medusa-backend's **Variables** tab.

That is the whole setup. Copy the generated password somewhere first: it is applied on the first boot only, so changing the variable afterwards does not reset the account.

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
wait_for_build "$MEDUSA_WAIT_FOR"  # worker only, polls /deploy-ready
exec medusa start
```

Both Medusa services run the same image and differ only in `MEDUSA_WORKER_MODE`. The API instance's port opens only after migrations and bootstrap succeed, and a failed migration exits before anything serves traffic: the healthcheck never passes and Railway keeps the previous version live.

The worker waits for a _build_, not just an open port, and the difference matters on every deploy after the first. Railway keeps the previous deployment serving until the new one is healthy, so the port is already open, answered by the old backend, while the new one is still migrating. A worker gated on the port would start new code against the old schema. Instead the backend reports its commit at `/deploy-ready`, and the worker blocks until that matches its own.

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

`MEDUSA_ADMIN_PASSWORD` is generated for you and used only on the first boot, so copy it out of the variables before the store is in use. Recovering a lost one means creating a second admin, which the FAQ below covers.

`S3_FILE_URL` is written onto every product image as it is uploaded. Changing it later does not rewrite rows that already exist, so if you plan to serve media from a custom domain or a CDN, set that address before building the catalogue.

`SEED_DEMO_DATA` is true by default so the storefront has something to render. Set it to false for an empty store. Deleting the demo products later works too, and they do not come back on redeploy.

### Questions people ask before deploying

**What does it cost to run?** Six services plus a bucket, on Railway's usage-based pricing. There is no separate search service to pay for, which is the main structural saving against templates that run Meilisearch. We have not published a measured monthly figure yet, so size it on your own traffic rather than taking a number on trust.

**I lost the admin password.** `railway ssh` into medusa-backend and run `medusa user` to create a second admin under a different address. The dashboard's "forgot password" link will not help: Medusa leaves sending that mail to the application, and this template ships no subscriber for it.

**Does it do Stripe?** Yes, and it is off until you set a key. `STRIPE_API_KEY` on medusa-backend and `NEXT_PUBLIC_STRIPE_KEY` on the storefront, both or neither: setting one half breaks checkout client side.

**Will my data survive a redeploy?** Yes. Postgres and the bucket are on volumes, and the demo catalogue is seeded once rather than on every boot, so deleting the demo products does not bring them back.

**Can I use a custom domain?** Yes, and several variables embed a URL, so update `MEDUSA_BACKEND_URL`, the three CORS variables, and the storefront's `NEXT_PUBLIC_MEDUSA_BACKEND_URL` and `NEXT_PUBLIC_BASE_URL`. The storefront has to rebuild, because Next inlines those at build time.

**How do I customise it?** Fork the repository and point the services at your fork. It is a normal Medusa project built on the current `create-medusa-app` monorepo, not a wrapper, so `apps/backend/src` and `apps/storefront/src` are where your code goes.

**How do I update Medusa?** The repository ships an upstream sync script and keeps its own changes as commits on top of a clean upstream snapshot, so an upgrade is a three-way merge rather than a hand diff. Migrations then run from the entrypoint on the next deploy.

**Can I deploy just the backend?** Yes, see below.

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
