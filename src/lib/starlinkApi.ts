/**
 * Loading for the Starlink tab's three static files. Kept out of api.ts so
 * the decoder and every interpretation rule it pulls in (starlink.ts) stay in
 * the lazily loaded Starlink chunk — visitors who never open the tab don't
 * download any of it. App reaches this module only through dynamic imports
 * (see hooks/useStarlinkBadge.ts).
 */

import { CACHE_TTL_MS, dataUrl, fetchJson } from './api'
import { decodeGp, decodeStarlink } from './starlink'
import type { GpElements, GpFile, StarlinkFile, StarlinkHistoryFile, StarlinkSnapshot } from './types'

const STARLINK_CACHE_KEY = 'spacex-tracker:starlink:v1'

interface StarlinkCacheEnvelope {
  storedAt: number
  /** The raw columnar file: smaller than the decoded objects. */
  file: StarlinkFile
}

function readStarlinkCache(): StarlinkCacheEnvelope | null {
  try {
    const raw = sessionStorage.getItem(STARLINK_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StarlinkCacheEnvelope
    return parsed?.file?.rows?.length ? parsed : null
  } catch {
    return null
  }
}

/**
 * Loads the satellite catalogue, with the same fresh-cache / stale-fallback
 * behaviour as loadSnapshot. The cache write often fails quietly once the
 * launch snapshot is stored too — together they approach some browsers'
 * sessionStorage quota — and the tab works fine without it.
 */
export async function loadStarlink(): Promise<StarlinkSnapshot> {
  const cached = readStarlinkCache()
  if (cached && Date.now() - cached.storedAt < CACHE_TTL_MS) return decodeStarlink(cached.file)

  try {
    const file = await fetchJson<StarlinkFile>(dataUrl('starlink.json'))
    const snapshot = decodeStarlink(file) // validates before it can be cached
    try {
      sessionStorage.setItem(
        STARLINK_CACHE_KEY,
        JSON.stringify({ storedAt: Date.now(), file } satisfies StarlinkCacheEnvelope),
      )
    } catch {
      // Quota or private mode; non-fatal by design.
    }
    return snapshot
  } catch (err) {
    if (cached) {
      console.warn('Starlink refresh failed; serving stale cache.', err)
      return decodeStarlink(cached.file)
    }
    throw err
  }
}

/**
 * SGP4 element sets for the live map, loaded only when the map mounts.
 * Not mirrored into sessionStorage: at ~1.3 MB it would only crowd out the
 * catalogue, and the browser's HTTP cache already covers reloads.
 */
export async function loadStarlinkGp(): Promise<{ generatedAt: string; elements: GpElements[] }> {
  const file = await fetchJson<GpFile>(dataUrl('starlink-gp.json'))
  return { generatedAt: file.generatedAt, elements: decodeGp(file) }
}

/** McDowell's weekly constellation-status series, for the history chart. */
export function loadStarlinkHistory(): Promise<StarlinkHistoryFile> {
  return fetchJson<StarlinkHistoryFile>(dataUrl('starlink-history.json'))
}
