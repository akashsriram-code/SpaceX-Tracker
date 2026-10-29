import { ArrowDownWideNarrow, Search, X } from 'lucide-react'
import type { FilterOptions } from '../lib/stats'
import type { Filters, StarlinkFilter, TabId } from '../lib/types'
import { cn } from '../lib/utils'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'past', label: 'Past' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'boosters', label: 'Boosters' },
  { id: 'starlink', label: 'Starlink' },
]

const STARLINK_OPTIONS: Array<{ id: StarlinkFilter; label: string; hint: string }> = [
  { id: 'all', label: 'All Missions', hint: 'Starlink and customer flights' },
  { id: 'customer', label: 'Commercial & Science', hint: 'Exclude Starlink' },
  { id: 'starlink', label: 'Starlink Only', hint: 'Constellation flights only' },
]

function Select({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: string[]
  allLabel: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label-caps">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 rounded-lg border border-white/10 bg-space px-3 py-2 text-xs text-white/80 outline-none transition-colors hover:border-white/20 focus:border-accent/50"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

export function FilterToolbar({
  tab,
  onTabChange,
  filters,
  onFiltersChange,
  options,
  counts,
  onTabIntent,
}: {
  tab: TabId
  onTabChange: (t: TabId) => void
  filters: Filters
  onFiltersChange: (f: Filters) => void
  options: FilterOptions
  /** `starlink` is null until the satellite catalogue has loaded once. */
  counts: { upcoming: number; past: number; boosters: number; starlink: number | null }
  /** Hover/focus on a tab button, so a tab can start loading its data early. */
  onTabIntent?: (t: TabId) => void
}) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onFiltersChange({ ...filters, [key]: value })

  // Chart tabs aggregate over the whole scoped set, so the per-launch
  // search/rocket/site/year controls don't apply — only the Starlink scope does.
  const isChartTab = tab === 'analytics' || tab === 'boosters'
  // The Starlink tab is about satellites, not launches: none of the launch
  // filters (mission scope included) mean anything there.
  const isSatelliteTab = tab === 'starlink'
  const hasActiveFilters =
    filters.search !== '' ||
    filters.starlink !== 'all' ||
    filters.rocket !== '' ||
    filters.pad !== '' ||
    filters.year !== ''

  return (
    <section className="space-y-4" aria-label="Launch filters">
      {/* Primary tabs */}
      <div
        role="tablist"
        aria-label="View"
        className="panel flex gap-1 overflow-x-auto p-1"
      >
        {TABS.map((t) => {
          const active = t.id === tab
          const count =
            t.id === 'upcoming'
              ? counts.upcoming
              : t.id === 'past'
                ? counts.past
                : t.id === 'boosters'
                  ? counts.boosters
                  : t.id === 'starlink'
                    ? counts.starlink
                    : null
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              onClick={() => onTabChange(t.id)}
              onPointerEnter={() => onTabIntent?.(t.id)}
              onFocus={() => onTabIntent?.(t.id)}
              title={t.id === 'starlink' ? 'Starlink satellites currently in orbit' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold whitespace-nowrap transition-all',
                active
                  ? 'bg-accent/15 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.25)]'
                  : 'text-white/50 hover:bg-white/5 hover:text-white/80',
              )}
            >
              {t.label}
              {count != null && (
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5 font-mono text-[0.65rem] tnum',
                    active ? 'bg-accent/20' : 'bg-white/5 text-white/40',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Starlink segmented control — applies to analytics too, since the
          charts should respect the same mission scope as the lists. */}
      <div className={cn('panel flex flex-col gap-3 p-3 sm:p-4', isSatelliteTab && 'hidden')}>
        <div
          role="radiogroup"
          aria-label="Mission scope"
          className="flex flex-wrap gap-1"
        >
          {STARLINK_OPTIONS.map((o) => {
            const active = filters.starlink === o.id
            return (
              <button
                key={o.id}
                role="radio"
                aria-checked={active}
                title={o.hint}
                onClick={() => set('starlink', o.id)}
                className={cn(
                  'rounded-lg px-3 py-1.5 text-xs font-medium transition-all',
                  active
                    ? 'bg-violet/15 text-violet shadow-[inset_0_0_0_1px_rgba(167,139,250,0.3)]'
                    : 'text-white/45 hover:bg-white/5 hover:text-white/75',
                )}
              >
                {o.label}
              </button>
            )
          })}
        </div>

        {!isChartTab && (
          <>
            {/* Search */}
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/25"
                aria-hidden
              />
              <input
                type="search"
                value={filters.search}
                onChange={(e) => set('search', e.target.value)}
                placeholder="Search mission, customer, rocket, pad, or booster…"
                aria-label="Search launches"
                className="w-full rounded-lg border border-white/10 bg-space py-2 pl-9 pr-3 text-sm text-white/85 placeholder:text-white/25 outline-none transition-colors hover:border-white/20 focus:border-accent/50"
              />
            </div>

            {/* Secondary filters */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Select
                label="Rocket"
                value={filters.rocket}
                onChange={(v) => set('rocket', v)}
                options={options.rockets}
                allLabel="All rockets"
              />
              <Select
                label="Launch site"
                value={filters.pad}
                onChange={(v) => set('pad', v)}
                options={options.pads}
                allLabel="All sites"
              />
              <Select
                label="Year"
                value={filters.year}
                onChange={(v) => set('year', v)}
                options={options.years}
                allLabel="All years"
              />
              <label className="flex flex-col gap-1">
                <span className="label-caps">Sort</span>
                <button
                  onClick={() =>
                    set('sort', filters.sort === 'newest' ? 'oldest' : 'newest')
                  }
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-space px-3 py-2 text-xs text-white/80 transition-colors hover:border-white/20"
                >
                  {filters.sort === 'newest' ? 'Newest first' : 'Oldest first'}
                  <ArrowDownWideNarrow
                    className={cn(
                      'size-3.5 shrink-0 text-white/30 transition-transform',
                      filters.sort === 'oldest' && 'rotate-180',
                    )}
                    aria-hidden
                  />
                </button>
              </label>
            </div>

            {hasActiveFilters && (
              <button
                onClick={() =>
                  onFiltersChange({
                    search: '',
                    starlink: 'all',
                    rocket: '',
                    pad: '',
                    year: '',
                    sort: filters.sort,
                  })
                }
                className="flex items-center gap-1.5 self-start text-[0.7rem] text-white/40 transition-colors hover:text-accent"
              >
                <X className="size-3" aria-hidden />
                Clear filters
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}
