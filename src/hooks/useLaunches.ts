import { useQuery } from '@tanstack/react-query'
import { CACHE_TTL_MS, loadSnapshot } from '../lib/api'
import type { Snapshot } from '../lib/types'

export function useSnapshot() {
  return useQuery<Snapshot>({
    queryKey: ['snapshot'],
    queryFn: loadSnapshot,
    // Matches the sessionStorage TTL so React Query and the storage layer
    // agree on what "fresh" means.
    staleTime: CACHE_TTL_MS,
    gcTime: 60 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}
