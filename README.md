# MedusaJS 2 on Railway

**Medusa server + worker, Next.js storefront, PostgreSQL, Redis and persistent
media, wired together and verified end to end.**

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/medusajs-2-full-stack-production-ready?referralCode=aceweb&utm_medium=integration&utm_source=template&utm_campaign=generic)

A fork of [`medusajs/dtc-starter`](https://github.com/medusajs/dtc-starter), the
monorepo `create-medusa-app` scaffolds today, with the infrastructure a real
deployment needs layered on top. Deploy it to Railway in one click and you get a
store that already has an admin account, regions, a sales channel, a publishable
API key, working search and a demo catalogue. Then keep developing it as a normal
Medusa project.

Published on the Railway marketplace as
[MedusaJS 2 Full Stack Production Ready](https://railway.com/deploy/medusajs-2-full-stack-production-ready?referralCode=aceweb&utm_medium=integration&utm_source=template&utm_campaign=generic).
The listing copy is mirrored in
[docs/marketplace-listing.md](docs/marketplace-listing.md).

## What is included

|                           |                                                                              |
| ------------------------- | ---------------------------------------------------------------------------- |
| Medusa 2.22               | API, admin dashboard at `/app`, store and admin REST APIs                    |
| Server and worker         | The documented production topology, same image, different mode               |
| PostgreSQL                | Provisioned by the template, over Railway's private network                  |
| Redis                     | Event bus, workflow engine, locking provider and cache                       |
| Next.js storefront        | Medusa's own DTC starter, product pages, cart, multi-step checkout           |
| Search                    | Medusa's index on PostgreSQL, with facets. No separate search service        |
| Persistent media          | Uploads go to a Railway bucket, served by a read-only proxy                  |
| Idempotent bootstrap      | Migrations, admin account and publishable key, from the container entrypoint |
| Optional Stripe, SendGrid | Configured when you set a key, absent when you do not                        |
| Smoke test                | Places a real order against a deployment, so "Online" is not the bar         |

## Why this exists

Medusa's [deployment guide](https://docs.medusajs.com/learn/deployment/general)
asks for two instances of the application, one in server mode and one in worker
mode, with Redis behind the event bus, the workflow engine, locking and the cache.
Most one-click Medusa templates run a single process and skip some of those
modules. That works until a long-running workflow starts competing with checkout
requests, or a second replica takes a lock that is only held in memory.

The other half is cold-start behaviour. A stack that works in the project you
built it in is not the same as a template that works in a stranger's empty
project, where every service builds and boots in parallel and nothing has been set
up by hand. The specific things that break, and what this does about them, are in
[docs/local-testing.md](docs/local-testing.md) and
[docs/railway-template.md](docs/railway-template.md).

## Deploy to Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/medusajs-2-full-stack-production-ready?referralCode=aceweb&utm_medium=integration&utm_source=template&utm_campaign=generic)

Railway creates seven resources: the Medusa server, the worker, the storefront,
the media proxy, PostgreSQL, Redis and a storage bucket. Every variable is filled
in from those, and every secret is generated at deploy time, so **there are no
variables to fill in**. The deploy form asks you for one thing, the bucket's
region, which a template is not allowed to set. The first deploy then builds the
four images, migrates, bootstraps and seeds a demo catalogue.

Verified cold on 2026-11-15: all six services green in about four minutes, and
`scripts/smoke-test.mjs` passing 17/17 against the deployed URLs, order included.

### Deploying this repository directly

The button above deploys a published Railway template. To deploy your own copy of
this repository instead, use the Railway CLI:

```bash
npm --prefix .railway install   # the SDK that evaluates railway.ts
railway login
railway init
railway config apply            # six services and the bucket
railway domain --service medusa-backend
railway domain --service storefront
railway domain --service media-proxy
railway config apply            # again, now that the domains exist
```

Apply twice, with the domains in between: every expression built on a public
domain resolves to an empty string until that domain exists, and the storefront
bakes its backend URL and publishable key into the bundle at build time.

`.railway/railway.ts` describes the whole project, including the bucket. Applying
it owns the environment, so anything not described in it is deleted: point it at
a new project rather than one that already has other things in it. Change `REPO`
to your own fork first, or you will deploy this repository rather than yours. The
rest, including the exact variables and the template editor's quirks, is in
[docs/railway-template.md](docs/railway-template.md).

## Run it locally

```bash
docker compose --profile stack up -d --build
node scripts/smoke-test.mjs
```

That brings up the whole topology from the same three Dockerfiles Railway builds,
including the media proxy, so the failures that only happen on a cold deploy
happen here first. Details, and the scenarios worth running before touching
Railway, are in [docs/local-testing.md](docs/local-testing.md).

Admin at <http://localhost:9000/app>, storefront at <http://localhost:8000>,
`admin@example.com` / `supersecret`.

## Layout

```text
apps/backend/        Medusa, upstream, plus medusa-config.ts and src/scripts/bootstrap.ts
apps/storefront/     Next.js, upstream, plus two small production fixes
media-proxy/         read-only public reads of the bucket, outside the workspace on purpose
docker/              the three images and the backend entrypoint
scripts/             smoke test and upstream sync
.railway/railway.ts  the project, applied with the Railway CLI
docs/                local testing, Railway template, upstream sync, listing copy
```

## Keeping up with Medusa

```bash
scripts/sync-upstream.sh main
git merge upstream
```

The `upstream` branch holds a faithful snapshot of dtc-starter, and this fork's
work sits in commits on top of it, so a sync is a real three-way merge rather than
a hand diff. The files that deliberately differ, and what to expect from each, are
listed in [docs/upstream-sync.md](docs/upstream-sync.md).

Dependencies are untouched: the Redis, S3 and payment modules are reached through
`@medusajs/medusa/<module>` subpath exports rather than added to `package.json`, so
a Medusa version bump needs no changes here.

## Licence

MIT, as the upstream starter is. See [LICENSE](LICENSE).
