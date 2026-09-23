import { format } from 'date-fns'
import { Github, Radio } from 'lucide-react'
import { lazy, Suspense, useMemo, useState } from 'react'
import { FilterToolbar } from './components/FilterToolbar'
import { KpiBar } from './components/KpiBar'
import { LaunchCard } from './components/LaunchCard'
import { MissionDrawer } from './components/MissionDrawer'
import { NextLaunchHero } from './components/NextLaunchHero'
import { EmptyState, ErrorState, LoadingState } from './components/ui/States'
import { useSnapshot } from './hooks/useLaunches'
import {
  boosterLabel,
  hasKnownSerial,
  isStarlinkMission,
  isUpcoming,
  launchYear,
  primaryCustomer,
} from './lib/launch'
import { computeFilterOptions, computeKpis } from './lib/stats'
import type { Filters, Launch, TabId } from './lib/types'
import { vehiclesInUse } from './lib/vehicles'

/**
 * Recharts is ~60% of the bundle and only the chart tabs need it, so both
 * load on demand. Keeps the default Upcoming view light on first paint.
 */
const Analytics = lazy(() =>
  import('./components/Analytics').then((m) => ({ default: m.Analytics })),
)
const Boosters = lazy(() =>
  import('./components/Boosters').then((m) => ({ default: m.Boosters })),
)

const INITIAL_FILTERS: Filters = {
  search: '',
  starlink: 'all',
  rocket: '',
  pad: '',
  year: '',
  sort: 'newest',
}

/** Distinct identified boosters in a set, for the Boosters tab count. */
function countDistinctCores(launches: Launch[]): number {
  const serials = new Set<string>()
  for (const l of launches) {
    for (const b of l.boosters) {
      if (hasKnownSerial(b.serial)) serials.add(b.serial as string)
    }
  }
  return serials.size
}

/** Free-text match across the fields a user would plausibly search by. */
function matchesSearch(launch: Launch, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  const haystack = [
    launch.name,
    launch.missionName,
    launch.rocketName,
    launch.rocketFullName,
    launch.padName,
    launch.padLocation,
    launch.orbitName,
    launch.orbitAbbrev,
    launch.missionType,
    primaryCustomer(launch),
    ...launch.agencies.map((a) => a.name),
    ...launch.boosters.map((b) => boosterLabel(b.serial, b.flightNumber)),
  ]
  return haystack.some((f) => f != null && f.toLowerCase().includes(needle))
}

export default function App() {
  const { data, isPending, isError, error, refetch } = useSnapshot()
  const [tab, setTab] = useState<TabId>('upcoming')
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS)
  const [selected, setSelected] = useState<Launch | null>(null)
  /** DOM id of a chart to scroll to, set when a KPI tile is clicked. */
  const [focusChart, setFocusChart] = useState<string | null>(null)

  const launches = data?.launches ?? []

  // Mission-scope filter is applied before everything else so the KPI bar,
  // the lists and the charts all describe the same set of launches.
  const scoped = useMemo(() => {
    if (filters.starlink === 'all') return launches
    const wantStarlink = filters.starlink === 'starlink'
    return launches.filter((l) => isStarlinkMission(l) === wantStarlink)
  }, [launches, filters.starlink])

  const kpis = useMemo(() => computeKpis(scoped), [scoped])
  const options = useMemo(() => computeFilterOptions(launches), [launches])

  const nextLaunch = useMemo(() => {
    // Soonest upcoming launch by NET. `scoped` respects the Starlink filter,
    // so toggling to "Starlink Only" also retargets the countdown.
    const upcoming = scoped.filter((l) => isUpcoming(l) && l.net)
    if (upcoming.length === 0) return null
    return upcoming.reduce((soonest, l) =>
      l.net.localeCompare(soonest.net) < 0 ? l : soonest,
    )
  }, [scoped])

  const tabCounts = useMemo(
    () => ({
      upcoming: scoped.filter(isUpcoming).length,
      past: scoped.filter((l) => !isUpcoming(l)).length,
      boosters: countDistinctCores(scoped),
    }),
    [scoped],
  )

  const visible = useMemo(() => {
    const wantUpcoming = tab === 'upcoming'
    const list = scoped.filter((l) => {
      if (tab !== 'analytics' && isUpcoming(l) !== wantUpcoming) return false
      if (filters.rocket && l.rocketName !== filters.rocket) return false
      if (filters.pad && l.padName !== filters.pad) return false
      if (filters.year && String(launchYear(l) ?? '') !== filters.year) return false
      return matchesSearch(l, filters.search)
    })

    // Upcoming reads best soonest-first, so "newest" means ascending NET
    // there and descending for past flights.
    const dir = filters.sort === 'newest' ? 1 : -1
    return list.sort((a, b) =>
      wantUpcoming
        ? dir * a.net.localeCompare(b.net)
        : dir * b.net.localeCompare(a.net),
    )
  }, [scoped, tab, filters])

  // Vehicles present in the visible list, so the spine legend only advertises
  // colours actually on screen.
  const vehicleLegend = useMemo(
    () => vehiclesInUse(visible.map((l) => l.rocketName)),
    [visible],
  )

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-white sm:text-2xl">
            <Radio className="size-5 text-accent" aria-hidden />
            SpaceX Launch Telemetry
          </h1>
          <p className="mt-1 text-xs text-white/40">
            Mission history, booster recovery, and constellation tracking.
          </p>
        </div>

        {data?.meta && (
          <div className="text-right">
            <p className="label-caps">Snapshot</p>
            <p className="font-mono text-[0.7rem] tnum text-white/50">
              {format(new Date(data.meta.generatedAt), 'd MMM yyyy HH:mm')} UTC
            </p>
            <p className="font-mono text-[0.65rem] tnum text-white/25">
              {data.meta.launchCount} launches · Launch Library 2
            </p>
          </div>
        )}
      </header>

      {isPending && <LoadingState />}

      {isError && <ErrorState error={error} onRetry={() => refetch()} />}

      {data && (
        <div className="space-y-6">
          <KpiBar
            kpis={kpis}
            onShowStarlinkChart={() => {
              setTab('analytics')
              setFocusChart('chart-cadence')
            }}
          />

          <NextLaunchHero launch={nextLaunch} onOpen={setSelected} />

          <FilterToolbar
            tab={tab}
            onTabChange={setTab}
            filters={filters}
            onFiltersChange={setFilters}
            options={options}
            counts={tabCounts}
          />

          {tab === 'analytics' ? (
            <Suspense fallback={<LoadingState label="Loading charts…" />}>
              <Analytics
                launches={scoped}
                focusChart={focusChart}
                onFocusHandled={() => setFocusChart(null)}
              />
            </Suspense>
          ) : tab === 'boosters' ? (
            <Suspense fallback={<LoadingState label="Loading fleet telemetry…" />}>
              <Boosters launches={scoped} />
            </Suspense>
          ) : visible.length === 0 ? (
            <EmptyState
              title="No missions match these filters"
              hint="Try clearing the search box or widening the rocket, site, and year filters."
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-[0.7rem] tnum text-white/30">
                  {visible.length} mission{visible.length === 1 ? '' : 's'}
                </p>
                {/* Legend for the card spine colours */}
                <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {vehicleLegend.map((v) => (
                    <li
                      key={v.name}
                      className="flex items-center gap-1.5 text-[0.7rem] text-white/45"
                    >
                      <span
                        aria-hidden
                        className="h-2.5 w-[3px] rounded-full"
                        style={{ background: v.color }}
                      />
                      {v.name}
                      <span className="font-mono tnum text-white/25">{v.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {visible.map((l) => (
                  <LaunchCard key={l.id} launch={l} onOpen={setSelected} />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <MissionDrawer launch={selected} onClose={() => setSelected(null)} />

      <footer className="mt-12 border-t border-white/[0.07] pt-6 pb-4">
        <p className="text-[0.7rem] leading-relaxed text-white/35">
          Data from{' '}
          <a
            href="https://thespacedevs.com/llapi"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent/70 hover:text-accent"
          >
            Launch Library 2
          </a>{' '}
          by The Space Devs, snapshotted at build time. The legacy r/SpaceX API
          (api.spacexdata.com) was archived in June 2026 and is no longer
          reachable. Customer attribution is derived, not authoritative.
        </p>
        <p className="mt-2 flex items-center gap-1.5 text-[0.65rem] text-white/25">
          <Github className="size-3" aria-hidden />
          Static site · no API keys in the client · refreshed by scheduled CI
        </p>
      </footer>
    </div>
  )
}
