import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { CACHE_TTL_MS } from '../lib/api'
import type { StarlinkSnapshot } from '../lib/types'

/**
 * The two things App needs from the Starlink catalogue without pulling the
 * catalogue code into the main bundle:
 *
 * - `inOrbit`: the tab badge. A disabled (skipToken) observer on the same
 *   query key never fetches; it just shows the count once the tab has loaded
 *   the data, and stays null before that.
 * - `prefetch`: on hover/focus of the tab button, dynamically import the
 *   loader and warm the query so the tab usually opens with data in hand.
 */
export function useStarlinkBadge() {
  const client = useQueryClient()
  const { data } = useQuery<StarlinkSnapshot>({ queryKey: ['starlink'], queryFn: skipToken })

  const prefetch = useCallback(() => {
    void import('../lib/starlinkApi')
      .then(({ loadStarlink }) =>
        client.prefetchQuery({ queryKey: ['starlink'], queryFn: loadStarlink, staleTime: CACHE_TTL_MS }),
      )
      .catch(() => {}) // the tab's own load reports failures
  }, [client])

  return { inOrbit: data?.meta.inOrbitCount ?? null, prefetch }
}
