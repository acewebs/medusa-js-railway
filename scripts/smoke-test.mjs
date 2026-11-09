#!/usr/bin/env node
/**
 * Proves a deployment is a working store, not just a running process.
 *
 *   node scripts/smoke-test.mjs
 *   MEDUSA_URL=https://my-store.up.railway.app node scripts/smoke-test.mjs
 *
 * It logs into the admin, uploads a file and reads it back through the media
 * proxy, then places a real order through the store API: cart, line item,
 * address, shipping method, payment session, complete. A deploy where every
 * service says "Online" can still fail most of this.
 *
 * Defaults match docker-compose.yml. Override with MEDUSA_URL, STOREFRONT_URL,
 * MEDUSA_PUBLISHABLE_KEY, MEDUSA_ADMIN_EMAIL, MEDUSA_ADMIN_PASSWORD.
 * SKIP_STOREFRONT=true checks the backend alone.
 */
const MEDUSA_URL = trimSlash(process.env.MEDUSA_URL || 'http://localhost:9000')
const STOREFRONT_URL = trimSlash(process.env.STOREFRONT_URL || 'http://localhost:8000')
const PUBLISHABLE_KEY =
  process.env.MEDUSA_PUBLISHABLE_KEY || 'pk_local_development_key_0000000000000000'
const ADMIN_EMAIL = process.env.MEDUSA_ADMIN_EMAIL || 'admin@example.com'
const ADMIN_PASSWORD = process.env.MEDUSA_ADMIN_PASSWORD || 'supersecret'
const SKIP_STOREFRONT = process.env.SKIP_STOREFRONT === 'true'

/** Smallest valid PNG, so the upload path is exercised with a real image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

function trimSlash(url) {
  return url.replace(/\/+$/, '')
}

const results = []
const steps = []

/** Registers a check. They run in order, and the run stops at the first failure. */
const step = (name, run) => steps.push({ name, run })

async function call(url, { expect = [200], ...init } = {}) {
  const response = await fetch(url, init)
  const text = await response.text()

  if (!expect.includes(response.status)) {
    throw new Error(`${init.method || 'GET'} ${url} returned ${response.status}: ${text.slice(0, 300)}`)
  }

  try {
    return { response, body: JSON.parse(text) }
  } catch {
    return { response, body: text }
  }
}

const store = (path, init = {}) =>
  call(`${MEDUSA_URL}${path}`, {
    ...init,
    headers: {
      'x-publishable-api-key': PUBLISHABLE_KEY,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

function plan() {
  step('backend /health', async () => {
    await call(`${MEDUSA_URL}/health`)
    return 'ok'
  })

  step('admin dashboard /app', async () => {
    const { response } = await call(`${MEDUSA_URL}/app`)
    const type = response.headers.get('content-type') || ''
    if (!type.includes('text/html')) {
      throw new Error(`expected HTML, got ${type}`)
    }
    return 'serves the dashboard'
  })

  let token
  step('admin login', async () => {
    const { body } = await call(`${MEDUSA_URL}/auth/user/emailpass`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    })
    token = body.token
    if (!token) {
      throw new Error('no token returned')
    }
    return ADMIN_EMAIL
  })

  step('admin session cookie', async () => {
    // The dashboard does not use the bearer token: it exchanges it for a session
    // cookie and sends that. Medusa marks the cookie Secure whenever NODE_ENV is
    // production, and express-session then silently declines to set it over
    // plain HTTP, so login succeeds and every request after it is a 401. Only a
    // check that follows the cookie can see that.
    const session = await fetch(`${MEDUSA_URL}/auth/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })
    const cookie = session.headers.get('set-cookie')
    if (!cookie) {
      throw new Error(
        'no Set-Cookie from /auth/session, so the admin dashboard cannot stay logged in'
      )
    }

    const me = await fetch(`${MEDUSA_URL}/admin/users/me`, {
      headers: { cookie: cookie.split(';')[0] },
    })
    if (!me.ok) {
      throw new Error(`/admin/users/me returned ${me.status} with the session cookie`)
    }
    return 'dashboard can stay logged in'
  })

  step('admin API reachable', async () => {
    const { body } = await call(`${MEDUSA_URL}/admin/products?limit=1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    return `${body.count} products`
  })

  step('file upload and public read', async () => {
    const form = new FormData()
    form.append('files', new Blob([PNG], { type: 'image/png' }), 'smoke-test.png')

    const { body } = await call(`${MEDUSA_URL}/admin/uploads`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    })

    const file = body.files?.[0]
    if (!file?.url) {
      throw new Error(`no file URL in ${JSON.stringify(body).slice(0, 200)}`)
    }

    // The URL Medusa persists onto products, fetched the way a browser would.
    const read = await fetch(file.url)
    if (!read.ok) {
      throw new Error(`${file.url} returned ${read.status}`)
    }
    const bytes = Buffer.from(await read.arrayBuffer())
    if (!bytes.equals(PNG)) {
      throw new Error(`${file.url} served ${bytes.length} bytes, expected ${PNG.length}`)
    }
    return file.url
  })

  let regionId
  step('store regions', async () => {
    const { body } = await store('/store/regions')
    regionId = body.regions?.[0]?.id
    if (!regionId) {
      throw new Error('no regions, so no storefront can price anything')
    }
    return `${body.regions.length} region(s)`
  })

  step('product search', async () => {
    const { body } = await store('/store/search', {
      method: 'POST',
      body: JSON.stringify({
        queries: [
          {
            entity: 'product',
            fields: ['id', 'title', 'handle'],
            filters: { q: 'tee' },
            pagination: { take: 3 },
          },
        ],
      }),
    })
    const hits = body.results?.[0]?.hits?.length ?? 0
    if (!hits) {
      throw new Error('the search index returned nothing, so it is empty or not active')
    }
    return `${hits} hit(s)`
  })

  let variantId
  step('store products priced', async () => {
    const { body } = await store(
      `/store/products?limit=1&region_id=${regionId}&fields=*variants.calculated_price`
    )
    const product = body.products?.[0]
    variantId = product?.variants?.[0]?.id
    if (!variantId) {
      throw new Error('no purchasable variant')
    }
    if (product.variants[0].calculated_price == null) {
      throw new Error(`${product.handle} has no price in this region`)
    }
    return product.handle
  })

  let cartId
  step('cart with a line item', async () => {
    const { body: created } = await store('/store/carts', {
      method: 'POST',
      body: JSON.stringify({ region_id: regionId, email: 'smoke-test@example.com' }),
    })
    cartId = created.cart?.id
    if (!cartId) {
      throw new Error('no cart created')
    }

    const { body: withItem } = await store(`/store/carts/${cartId}/line-items`, {
      method: 'POST',
      body: JSON.stringify({ variant_id: variantId, quantity: 1 }),
    })
    if (!withItem.cart?.items?.length) {
      throw new Error('line item was not added')
    }
    return cartId
  })

  step('shipping address and method', async () => {
    await store(`/store/carts/${cartId}`, {
      method: 'POST',
      body: JSON.stringify({
        shipping_address: {
          first_name: 'Smoke',
          last_name: 'Test',
          address_1: 'Testvej 1',
          city: 'Copenhagen',
          country_code: 'dk',
          postal_code: '1050',
        },
      }),
    })

    const { body: options } = await store(`/store/shipping-options?cart_id=${cartId}`)
    const option = options.shipping_options?.[0]
    if (!option) {
      throw new Error('no shipping option for this cart, so checkout cannot complete')
    }

    await store(`/store/carts/${cartId}/shipping-methods`, {
      method: 'POST',
      body: JSON.stringify({ option_id: option.id }),
    })
    return option.name
  })

  step('payment session', async () => {
    const { body: collection } = await store('/store/payment-collections', {
      method: 'POST',
      body: JSON.stringify({ cart_id: cartId }),
    })
    const collectionId = collection.payment_collection?.id
    if (!collectionId) {
      throw new Error('no payment collection')
    }

    await store(`/store/payment-collections/${collectionId}/payment-sessions`, {
      method: 'POST',
      body: JSON.stringify({ provider_id: 'pp_system_default' }),
    })
    return 'pp_system_default'
  })

  step('order placed', async () => {
    const { body } = await store(`/store/carts/${cartId}/complete`, { method: 'POST' })
    if (body.type !== 'order' || !body.order?.id) {
      throw new Error(`cart did not become an order: ${JSON.stringify(body).slice(0, 300)}`)
    }
    return body.order.id
  })

  if (SKIP_STOREFRONT) {
    return
  }

  step('storefront home', async () => {
    const { response } = await call(`${STOREFRONT_URL}/`, { expect: [200] })
    return `${response.status} at ${response.url}`
  })

  step('storefront store listing', async () => {
    await call(`${STOREFRONT_URL}/dk/store`)
    return 'ok'
  })

  step('storefront product page', async () => {
    const { body: products } = await store('/store/products?limit=1')
    const handle = products.products?.[0]?.handle
    if (!handle) {
      throw new Error('no product to open')
    }
    // Server rendered, so the title in the HTML proves the storefront's own
    // server reached the backend, not just that Next answered.
    const { body: html } = await call(`${STOREFRONT_URL}/dk/products/${handle}`)
    if (!String(html).includes('<title>')) {
      throw new Error(`/dk/products/${handle} rendered no title`)
    }
    return handle
  })

  step('storefront sitemap', async () => {
    const { body } = await call(`${STOREFRONT_URL}/sitemap.xml`)
    const urls = String(body).match(/<loc>/g)?.length ?? 0
    if (!urls) {
      throw new Error('the sitemap is empty')
    }
    return `${urls} URLs`
  })
}

plan()

let failed = 0

for (const { name, run } of steps) {
  const started = Date.now()
  try {
    results.push({ ok: true, name, detail: await run(), ms: Date.now() - started })
  } catch (error) {
    results.push({ ok: false, name, detail: error.message, ms: Date.now() - started })
    failed += 1
    // Everything after a failure depends on what just broke, so carrying on
    // would only produce noise.
    break
  }
}

for (const { ok, name, detail, ms } of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${detail} (${ms}ms)`)
}

const passed = results.length - failed
console.log(`\n${passed}/${steps.length} checks passed`)

if (passed < steps.length) {
  process.exit(1)
}
