import { useQuery } from '@tanstack/react-query'
import { CACHE_TTL_MS } from '../lib/api'
import { loadStarlink, loadStarlinkGp, loadStarlinkHistory } from '../lib/starlinkApi'

/**
 * Data hooks for the Starlink tab. Imported only by the lazy Starlink
 * components, so starlinkApi (and the decoder) stay out of the main bundle.
 * Same cache settings as useSnapshot so React Query and sessionStorage agree
 * on what "fresh" means.
 */

const COMMON = {
  staleTime: CACHE_TTL_MS,
  gcTime: 60 * 60 * 1000,
  refetchOnWindowFocus: false,
  retry: 1,
} as const

export function useStarlink() {
  return useQuery({ queryKey: ['starlink'], queryFn: loadStarlink, ...COMMON })
}

/** SGP4 elements for the live map; only requested once the map mounts. */
export function useStarlinkGp() {
  return useQuery({ queryKey: ['starlink-gp'], queryFn: loadStarlinkGp, ...COMMON })
}

export function useStarlinkHistory() {
  return useQuery({ queryKey: ['starlink-history'], queryFn: loadStarlinkHistory, ...COMMON })
}
