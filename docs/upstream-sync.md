# Staying in sync with Medusa's starter

This repository is a fork of [`medusajs/dtc-starter`](https://github.com/medusajs/dtc-starter),
with production infrastructure layered on top: Redis modules, S3 storage, three
Docker builds, an idempotent bootstrap, and the Railway wiring.

That starter is not an arbitrary choice. It is what `create-medusa-app` clones:
`DEFAULT_REPO` in
[`packages/cli/create-medusa-app/src/utils/clone-repo.ts`](https://github.com/medusajs/medusa/blob/develop/packages/cli/create-medusa-app/src/utils/clone-repo.ts)
points at it. The standalone `nextjs-starter-medusa` the older Railway templates
build on was archived on 2 July 2026.

**Baseline: `6834ac6b6455474b114ff269f36006a8d9fabccf`** (2026-11-08, Medusa
2.22.4). Update this line on every sync.

## The model

A branch, `upstream`, holds a faithful snapshot of dtc-starter at one commit, with
nothing of ours in it. Each sync adds one commit to it, so its history is a series
of upstream snapshots.

`main` shares its root commit with that branch: the first commit here is the
pristine starter, and everything this fork does sits in commits on top of it.

```text
upstream   4a1d53d ─── (next sync) ─── (the one after)
              |  \               \                  \
main          +──── (this fork)   merge              merge
```

So the merge base is genuine rather than declared, and merging applies only what
changed upstream between two snapshots instead of treating every file as new.

dtc-starter publishes no tags, so a sync is identified by a commit SHA. A bot
bumps `@medusajs/*` there, so `main` moves regularly and in small steps.

## Syncing

```bash
scripts/sync-upstream.sh main     # or a specific SHA
git merge upstream
```

Resolve the conflicts, then run the checks that matter:

```bash
pnpm install
docker compose --profile stack down -v
docker compose --profile stack up -d --build
node scripts/smoke-test.mjs
```

A Medusa upgrade that needs a schema change needs nothing extra here: migrations
ship inside the `@medusajs/*` packages and the entrypoint applies them on the next
deploy.

## What to watch for

These are the files this fork deliberately differs on. Expect them to conflict,
and resolve them by hand rather than taking either side wholesale.

- **`apps/backend/medusa-config.ts`** is substantially ours. Upstream ships a
  config with no `modules` at all; this one adds the Redis event bus, workflow
  engine, locking provider and cache, the S3 file provider, and optional Stripe
  and SendGrid. All of it is env gated, so a clone with only Postgres still boots.
- **`apps/storefront/next.config.js`** adds `output: "standalone"`, for the image.
- **`apps/storefront/src/app/sitemap.ts`** adds `export const dynamic =
  "force-dynamic"`. Without it Next prerenders the sitemap at build time, the
  build queries a backend that does not exist yet, and the Railway build fails.
  If upstream ever adds `generateStaticParams` or another prerendered page that
  queries, it needs the same treatment. Scenario 5 in
  [local-testing.md](local-testing.md) is the check.
- **`apps/backend/src/scripts/bootstrap.ts`** is entirely ours and should merge
  cleanly, but it depends on upstream behaviour in two places. It calls upstream's
  `seed-demo-products.ts` directly, and it writes the publishable key's token
  column. Both are covered by the smoke test.
- **`.gitignore`** adds `**/.medusa`.
- **`README.md`** is ours. Upstream's is kept nowhere: read it on GitHub if you
  need it, and take its side for nothing.

Everything else, including `package.json` and `pnpm-lock.yaml`, is upstream's.
Keeping it that way is deliberate: the infrastructure modules are reached through
`@medusajs/medusa/<module>` subpath exports rather than added as dependencies, so a
Medusa bump needs no changes here at all.

## If the upstream branch is lost

It is recoverable from `main`, because `main`'s root commit is the snapshot:

```bash
git branch upstream "$(git rev-list --max-parents=0 main)"
```

Then sync it forward. Do not rebuild it by running the sync script from scratch:
the tree would be identical but the commit would not (a commit hashes its
timestamp too), so the new branch would share no history with `main` and every
merge would come back as one giant unrelated-history conflict.

If that has already happened, declare the baseline instead of pretending:

```bash
scripts/sync-upstream.sh <the SHA this fork currently matches>
git merge -s ours --allow-unrelated-histories upstream \
  -m "Record the upstream starter baseline"
```

`-s ours` records the parent without changing a single file, which is what makes
later merges compute the right diff. Getting the SHA wrong poisons every sync
afterwards, so it must be the commit this tree actually came from.
