/**
 * Everything a fresh deploy needs that `medusa db:migrate` does not do, run
 * from the container entrypoint on every boot.
 *
 *   npx medusa exec ./src/scripts/bootstrap.ts
 *
 * It runs from the entrypoint rather than a pre-deploy command because a
 * published Railway template does not carry pre-deploy commands, so anything
 * put there never runs on the deploy that actually needs it.
 *
 * Every step reads before it writes. A boot interrupted halfway through is
 * repaired by the next one instead of leaving a store with no admin account.
 */
import { MedusaModule } from '@medusajs/framework/modules-sdk'
import type { ExecArgs } from '@medusajs/framework/types'
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  RBAC_SUPER_ADMIN_ROLE_ID,
} from '@medusajs/framework/utils'
import {
  createUsersWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
} from '@medusajs/medusa/core-flows'

import seedDemoProducts from './seed-demo-products'

const DEMO_SEEDED_AT = 'demo_seeded_at'

/** Held for the whole run, so two instances cannot bootstrap the same store at once. */
const LOCK_KEY = 'medusa-railway:bootstrap'
/** Long enough for a first boot that seeds a demo catalogue. */
const LOCK_SECONDS = 600

/** Matches the api_key module's own redaction, so the admin UI reads normally. */
const redactKey = (key: string) => [key.slice(0, 6), key.slice(-3)].join('***')

export default async function bootstrap({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const locking = container.resolve(Modules.LOCKING)

  /**
   * Every step reads before it writes, which makes a second run a no-op but not a
   * safe concurrent one: two instances can both read "no admin user" and both try
   * to create one, and the loser dies on the unique email. Only one server is
   * supposed to run this, and nothing stops someone raising the replica count on
   * the dashboard, so the lock is what actually enforces it. The expiry is what
   * releases it when an instance is killed mid-bootstrap.
   */
  await locking.execute(
    LOCK_KEY,
    async () => {
      await ensureAdminUser(container, logger)
      await ensurePublishableKey(container, logger)
      await ensureSearchIndexes(container, logger)
      await ensureDemoProducts(container, logger)
    },
    { timeout: LOCK_SECONDS, expire: LOCK_SECONDS }
  )
}

/**
 * Fills the search indexes `db:migrate` created.
 *
 * The search module seeds on boot in worker and shared mode only, never in
 * server mode, so on this topology nothing would fill them until the worker
 * starts. The worker starts after the server, and the demo catalogue's ingestion
 * fails against an index with no active version, so it is done here first.
 *
 * Only indexes that are not serving are rebuilt. An unconditional reindex seeds
 * a whole new physical index version on every boot, so a restart loop would
 * leave a trail of them behind.
 */
async function ensureSearchIndexes(
  container: ExecArgs['container'],
  logger: { info: (m: string) => void; warn: (m: string) => void }
) {
  try {
    const searchService = container.resolve(Modules.SEARCH)
    const indexes = await searchService.listIndexes()
    const unseeded = indexes
      .filter((index) => index.status === 'pending' || index.status === 'error')
      .map((index) => index.name)

    if (!unseeded.length) {
      return
    }

    await searchService.reindex({ index: unseeded })
    logger.info(`Seeded search index(es): ${unseeded.join(', ')}.`)
  } catch (error) {
    // Search is not on the path that serves a cart or an order, so a failure
    // here must not take the store down with it.
    logger.warn(`Could not seed the search indexes: ${error}`)
  }
}

/**
 * The same sequence the `medusa user` CLI command performs: create the user,
 * register an emailpass identity, then point that identity at the user. Done
 * here so a deploy needs no shell.
 *
 * An existing account is never touched, so changing MEDUSA_ADMIN_PASSWORD after
 * the first boot does not reset the password. Use the admin's own password reset
 * for that.
 */
async function ensureAdminUser(
  container: ExecArgs['container'],
  logger: { info: (m: string) => void; warn: (m: string) => void }
) {
  const email = process.env.MEDUSA_ADMIN_EMAIL
  const password = process.env.MEDUSA_ADMIN_PASSWORD

  if (!email || !password) {
    logger.warn(
      'MEDUSA_ADMIN_EMAIL or MEDUSA_ADMIN_PASSWORD is not set, so no admin account was created. Create one with `medusa user -e <email> -p <password>`.'
    )
    return
  }

  const userService = container.resolve(Modules.USER)
  const authService = container.resolve(Modules.AUTH)

  const [user] = await userService.listUsers({ email })
  const [identity] = await authService.listAuthIdentities({
    provider_identities: { entity_id: email },
  })

  if (user && identity?.app_metadata?.user_id === user.id) {
    logger.info(`Admin user ${email} already exists.`)
    return
  }

  // Super admin exists only when RBAC is installed. Without it every user is
  // effectively unrestricted, which is what the CLI relies on too.
  let roles: { role_id: string }[] = []
  if (MedusaModule.isInstalled(Modules.RBAC)) {
    const rbacService = container.resolve(Modules.RBAC)
    const [superAdmin] = await rbacService.listRbacRoles({
      id: RBAC_SUPER_ADMIN_ROLE_ID,
    })
    if (superAdmin) {
      roles = [{ role_id: superAdmin.id }]
    }
  }

  const adminUser =
    user ??
    (
      await createUsersWorkflow(container).run({
        input: { users: [{ email, roles }] },
      })
    ).result[0]

  // Reached when a previous boot created the user but died before the identity
  // was registered, which is the failure that otherwise locks a store out of
  // its own admin panel permanently.
  const authIdentity =
    identity ??
    (await (async () => {
      const { authIdentity, error } = await authService.register('emailpass', {
        body: { email, password },
      })
      if (error || !authIdentity) {
        throw new MedusaError(
          MedusaError.Types.UNEXPECTED_STATE,
          `Could not register an admin identity for ${email}: ${error}`
        )
      }
      return authIdentity
    })())

  await authService.updateAuthIdentities({
    id: authIdentity.id,
    app_metadata: { user_id: adminUser.id },
  })

  logger.info(`Created admin user ${email}.`)
}

/**
 * Forces the publishable key to the value in MEDUSA_PUBLISHABLE_KEY.
 *
 * The storefront inlines its publishable key at build time, and on Railway every
 * service builds in parallel, before this backend has ever run. So the key
 * cannot be something the backend generates and the storefront discovers later:
 * it has to be an input both sides already share.
 *
 * Publishable keys are stored unhashed by design (the api_key module says as
 * much: "These are public keys, so there is no point hashing them") and
 * authentication is an equality check on the token, so setting it is safe. The
 * column is written directly because the module deliberately exposes no way to
 * choose a token.
 */
async function ensurePublishableKey(
  container: ExecArgs['container'],
  logger: { info: (m: string) => void; warn: (m: string) => void }
) {
  const token = process.env.MEDUSA_PUBLISHABLE_KEY

  if (!token) {
    logger.warn(
      'MEDUSA_PUBLISHABLE_KEY is not set, so the publishable key keeps its generated value. The storefront needs that value in NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY.'
    )
    return
  }

  const apiKeyService = container.resolve(Modules.API_KEY)
  const keys = await apiKeyService.listApiKeys({ type: 'publishable' })
  const key =
    keys.find((candidate) => candidate.title === 'Default Publishable API Key') ?? keys[0]

  if (!key) {
    logger.warn(
      'No publishable key exists yet. Expected one from the initial data seed; skipping.'
    )
    return
  }

  if (key.token !== token) {
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
    await pg.raw('update api_key set token = ?, redacted = ? where id = ?', [
      token,
      redactKey(token),
      key.id,
    ])
    logger.info(`Publishable key ${key.id} set from MEDUSA_PUBLISHABLE_KEY.`)
  }

  await ensureKeyHasSalesChannel(container, logger, key.id)
}

/**
 * A publishable key with no sales channel answers every store request with an
 * empty catalogue, which looks like a broken storefront rather than a
 * configuration gap. The initial data seed links one; this covers a seed that
 * died between the two steps.
 */
async function ensureKeyHasSalesChannel(
  container: ExecArgs['container'],
  logger: { info: (m: string) => void; warn: (m: string) => void },
  keyId: string
) {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  const { data: keys } = await query.graph({
    entity: 'api_key',
    fields: ['id', 'sales_channels.id'],
    filters: { id: keyId },
  })

  if (keys[0]?.sales_channels?.length) {
    return
  }

  const salesChannelService = container.resolve(Modules.SALES_CHANNEL)
  const [salesChannel] = await salesChannelService.listSalesChannels({})

  if (!salesChannel) {
    logger.warn('No sales channel to link the publishable key to.')
    return
  }

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: keyId, add: [salesChannel.id] },
  })

  logger.info(`Linked sales channel ${salesChannel.id} to publishable key ${keyId}.`)
}

/**
 * Demo catalogue, once. The marker lives on the store rather than being inferred
 * from the products themselves, so deleting the demo products does not bring
 * them back on the next restart, and a seed that failed partway through is
 * retried because the marker is only written after it succeeds.
 */
async function ensureDemoProducts(
  container: ExecArgs['container'],
  logger: { info: (m: string) => void; warn: (m: string) => void }
) {
  if (process.env.SEED_DEMO_DATA !== 'true') {
    return
  }

  const storeService = container.resolve(Modules.STORE)
  const [store] = await storeService.listStores({})

  if (!store) {
    logger.warn('No store exists yet, so the demo catalogue was not seeded.')
    return
  }

  if (store.metadata?.[DEMO_SEEDED_AT]) {
    return
  }

  try {
    await seedDemoProducts({ container } as ExecArgs)
    await storeService.updateStores(store.id, {
      metadata: { ...(store.metadata ?? {}), [DEMO_SEEDED_AT]: new Date().toISOString() },
    })
    logger.info('Seeded the demo catalogue.')
  } catch (error) {
    // A missing demo catalogue is cosmetic. Failing the boot over it would take
    // a working store offline, and the next boot retries anyway.
    logger.warn(`Could not seed the demo catalogue: ${error}`)
  }
}
