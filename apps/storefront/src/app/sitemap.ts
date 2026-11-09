import { sdk } from "@lib/config"
import { listRegions } from "@lib/data/regions"
import { getSiteOrigin, listCountryCodes } from "@lib/util/site"
import type { MetadataRoute } from "next"

const STATIC_PATHS = [
  "",
  "/store",
  "/shipping",
  "/returns",
  "/terms",
  "/privacy",
  "/contact",
]
const PAGE_SIZE = 200

type Page<T> = { items: T[]; count: number }

async function listAll<T>(fetchPage: (offset: number) => Promise<Page<T>>) {
  const all: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { items, count } = await fetchPage(offset)
    all.push(...items)
    if (offset + PAGE_SIZE >= count || !items.length) {
      return all
    }
  }
}

type Entry = { handle?: string | null; updated_at?: string | Date | null }

/**
 * Rendered per request rather than at build time. Next prerenders a sitemap by
 * default, and this one queries the backend, which does not exist yet while the
 * storefront image is being built: on Railway every service builds in parallel,
 * and a build cannot reach the private network at all.
 */
export const dynamic = "force-dynamic"

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const query = { fields: "handle,updated_at", limit: PAGE_SIZE }

  const origin = await getSiteOrigin()

  /**
   * The catalogue half is allowed to fail. On a cold deploy the storefront
   * serves before the backend has finished migrating, and a crawler asking for
   * the sitemap in that window should get the static pages rather than a 500.
   */
  let regions: Awaited<ReturnType<typeof listRegions>> = []
  let products: Entry[] = []
  let categories: Entry[] = []
  let collections: Entry[] = []

  try {
    ;[regions, products, categories, collections] = await Promise.all([
      listRegions(),
      listAll<Entry>((offset) =>
        sdk.store.product
          .list({ ...query, offset })
          .then((res) => ({ items: res.products, count: res.count }))
      ),
      listAll<Entry>((offset) =>
        sdk.store.category
          .list({ ...query, offset })
          .then((res) => ({ items: res.product_categories, count: res.count }))
      ),
      listAll<Entry>((offset) =>
        sdk.store.collection
          .list({ ...query, offset })
          .then((res) => ({ items: res.collections, count: res.count }))
      ),
    ])
  } catch (error) {
    console.error("sitemap: the backend is unreachable, listing static paths only", error)
  }

  const toEntries = (base: string, prefix: string, items: Entry[]) =>
    items
      .filter((item) => item.handle)
      .map((item) => ({
        url: `${base}/${prefix}/${item.handle}`,
        lastModified: item.updated_at ? new Date(item.updated_at) : undefined,
      }))

  // listCountryCodes([]) is empty, so the default region still gets its pages
  // when regions could not be read.
  const countryCodes = listCountryCodes(regions)
  const fallbackCountry = process.env.NEXT_PUBLIC_DEFAULT_REGION || "dk"

  return (countryCodes.length ? countryCodes : [fallbackCountry]).flatMap((countryCode) => {
    const base = `${origin}/${countryCode}`
    return [
      ...STATIC_PATHS.map((path) => ({ url: `${base}${path}` })),
      ...toEntries(base, "products", products),
      ...toEntries(base, "categories", categories),
      ...toEntries(base, "collections", collections),
    ]
  })
}
