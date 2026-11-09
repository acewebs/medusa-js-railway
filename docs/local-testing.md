# Running and testing the stack locally

`docker-compose.yml` mirrors the Railway topology rather than being a convenience
dev stack. It builds the same three images Railway builds, runs the same
entrypoints, and includes the media proxy, so the things that only break on a
cold deploy break here first.

Nothing should reach Railway until this is green.

## Start it

```bash
docker compose --profile stack up -d --build
node scripts/smoke-test.mjs
```

The first build takes a few minutes (the admin dashboard and the Next.js
storefront are both compiled). Afterwards:

| Where | What |
| --- | --- |
| <http://localhost:9000/health> | backend health, what Railway's healthcheck hits |
| <http://localhost:9000/app> | admin dashboard, `admin@example.com` / `supersecret` |
| <http://localhost:8000> | storefront |
| <http://localhost:9300> | media proxy, serving uploads out of MinIO |
| <http://localhost:9101> | MinIO console, `medusa` / `medusamedusa` |

`docker compose up -d` without the profile starts only Postgres, Redis and MinIO,
which is what you want when running the apps from the host instead.

Copy `.env.example` to `.env` to change ports or credentials. Every value in it is
already the compose default, so an empty `.env` changes nothing.

## Two local decisions worth knowing

**Postgres is Railway's image, not the stock one.** Medusa enables SSL for any
database URL that is not localhost, so against a plain `postgres:18` container
every connection hangs for ten seconds and then fails, while the same code works
on Railway. `ghcr.io/railwayapp-templates/postgres-ssl:18` serves TLS, so the path
under test is the deployed one.

**The storefront uses host networking.** The starter reads a single backend URL
and Next bakes it into the client bundle, so the browser and the storefront's own
server have to agree on it. On Railway they do, because the backend has a public
domain. Locally only the host does, so the storefront container shares the host's
network stack and `http://localhost:9000` means the same thing in both places.
This is Linux only; on Docker Desktop either enable host networking or point
`NEXT_PUBLIC_MEDUSA_BACKEND_URL` at your machine's LAN address and remove
`network_mode: host`.

## The smoke test

```bash
node scripts/smoke-test.mjs                  # the whole stack
SKIP_STOREFRONT=true node scripts/smoke-test.mjs
MEDUSA_URL=https://… STOREFRONT_URL=https://… node scripts/smoke-test.mjs
```

Seventeen checks, and they are the point of the exercise: a deploy where every
service reads "Online" can still fail most of them. It logs into the admin,
uploads a file and reads the bytes back through the media proxy, places a real
order (cart, line item, address, shipping method, payment session, complete), and
renders a storefront product page and the sitemap. It stops at the first failure,
because everything after one depends on it.

## Scenarios to run before Railway

These are the failures that do not show up on the project you built the template
from, only on a cold deploy into someone else's empty project.

**1. Cold start.** `docker compose --profile stack down -v`, then up. Every service
reaches running with no restarts, and the smoke test passes.

**2. Interrupted first boot.** Start medusa-backend and kill it while the log says
`==> bootstrap`:

```bash
docker compose --profile stack down -v && docker compose up -d --wait
docker compose --profile stack up -d medusa-backend
docker compose logs -f medusa-backend     # wait for "==> bootstrap", then:
docker kill medusa-railway-medusa-backend-1
docker compose --profile stack up -d medusa-backend
```

The database is left with no admin user and a publishable key that is not the one
the storefront was built with. The next boot has to repair both. This is the
failure a competing Railway template documents as permanent ("seeding is skipped
forever and no admin exists"), and the reason every step in
`apps/backend/src/scripts/bootstrap.ts` reads before it writes.

**3. Restart.** `docker compose --profile stack restart`. Orders still exist and
uploaded files still load, because neither lives in a container.

**4. Second boot.** Restart with no schema change: migrations are a no-op, the
admin is left alone, and nothing is reseeded.

**5. A build that cannot reach the backend.** This is the Railway cold-build
condition, where every service builds in parallel and the build has no private
network:

```bash
docker build -f docker/storefront.Dockerfile \
  --build-arg NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://unreachable-backend:9000 \
  --build-arg NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_test \
  --build-arg NEXT_PUBLIC_DEFAULT_REGION=dk \
  --build-arg NEXT_PUBLIC_BASE_URL=http://localhost:8000 .
```

It has to succeed. Anything prerendered that queries the backend fails here, which
is why `apps/storefront/src/app/sitemap.ts` is marked `force-dynamic`.

**6. Worker ordering.** Start the worker before medusa-backend: it waits on that
service's port instead of racing a half-migrated database.

**7. Still a normal Medusa project.** With only the infrastructure containers
running, `pnpm --filter @dtc/backend dev` and `pnpm --filter @dtc/storefront dev`
both start from the host against the same database. If a change here breaks the
ordinary development loop, it has broken the thing anyone deploying this will go
on to use.

**8. Media proxy under failure.** Upload something large, read it slowly, and
break it from both ends:

```bash
curl --limit-rate 200k --max-time 3 -o /dev/null http://localhost:9300/<key>   # client leaves
curl --limit-rate 200k -o /dev/null http://localhost:9300/<key> &              # then, mid-stream:
docker kill medusa-railway-minio-1
```

The proxy has to survive both with `restarts=0` and keep answering `/_health`.
An interrupted response throws with the HTTP response already open, and writing a
status at that point takes the whole process down, which on Railway means a
crash-loop that drops every other image request on the instance.

## Working on the apps from the host

For an edit-and-reload loop, run the infrastructure in Docker and the apps on the
host:

```bash
docker compose up -d --wait            # Postgres, Redis, MinIO
pnpm install
pnpm --filter @dtc/backend dev         # :9000
pnpm --filter @dtc/storefront dev      # :8000
```

Both apps read their own dotenv files, which are gitignored:

- `apps/backend/.env`, with `localhost` hostnames and the ports above. A URL
  containing `localhost` is also what keeps Medusa from requiring SSL.
- `apps/storefront/.env.local`, at minimum `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`
  and `NEXT_PUBLIC_MEDUSA_BACKEND_URL`. The build fails without the key rather
  than starting a storefront that cannot talk to anything.

Bootstrap can be run by hand against a host server:

```bash
cd apps/backend
npx medusa db:migrate
npx medusa exec ./src/scripts/bootstrap.ts
```
