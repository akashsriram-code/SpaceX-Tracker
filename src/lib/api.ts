/**
 * Snapshot loading with a stale-while-revalidate cache.
 *
 * The app reads static JSON published alongside itself (see
 * scripts/fetch-data.mjs for why it isn't hitting Launch Library 2 from the
 * browser). Even so, we cache in sessionStorage with a TTL so tab switches
 * and reloads are instant and don't re-parse a ~1 MB document, and so a
 * transient network blip on a soft reload still renders.
 */

import type { Launch, Snapshot, SnapshotMeta } from './types'

const CACHE_KEY = 'spacex-tracker:snapshot:v1'
export const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Vite rewrites BASE_URL to the deploy subpath (e.g. "/spacex-tracker/"),
 * so data URLs stay correct on GitHub Pages project sites without any
 * hand-maintained path constants.
 */
export function dataUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${base.replace(/\/$/, '')}/data/${file}`
}

interface CacheEnvelope {
  storedAt: number
  snapshot: Snapshot
}

function readCache(): CacheEnvelope | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEnvelope
    if (!parsed?.snapshot?.launches?.length) return null
    return parsed
  } catch {
    // Quota errors, private-mode restrictions, or a schema change from an
    // older deploy — treat any unreadable cache as simply absent.
    return null
  }
}

function writeCache(snapshot: Snapshot): void {
  try {
    sessionStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ storedAt: Date.now(), snapshot } satisfies CacheEnvelope),
    )
  } catch {
    // Snapshot can exceed the sessionStorage quota on some browsers; the app
    // works fine without the cache, so this is deliberately non-fatal.
  }
}

export function isCacheFresh(envelope: CacheEnvelope | null): boolean {
  if (!envelope) return false
  return Date.now() - envelope.storedAt < CACHE_TTL_MS
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`Failed to load ${url} (HTTP ${res.status})`)
  }
  return (await res.json()) as T
}

/**
 * Loads the snapshot, preferring a fresh sessionStorage copy.
 *
 * On a network failure we fall back to a *stale* cache if one exists, so a
 * flaky connection degrades to slightly-old data rather than an error page.
 */
export async function loadSnapshot(): Promise<Snapshot> {
  const cached = readCache()
  if (isCacheFresh(cached)) return cached!.snapshot

  try {
    const [launches, meta] = await Promise.all([
      fetchJson<Launch[]>(dataUrl('launches.json')),
      fetchJson<SnapshotMeta>(dataUrl('meta.json')),
    ])

    if (!Array.isArray(launches)) {
      throw new Error('launches.json did not contain an array')
    }

    const snapshot: Snapshot = { meta, launches }
    writeCache(snapshot)
    return snapshot
  } catch (err) {
    if (cached) {
      console.warn('Snapshot refresh failed; serving stale cache.', err)
      return cached.snapshot
    }
    throw err
  }
}
