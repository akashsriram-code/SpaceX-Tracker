import { ChevronLeft, ChevronRight, ExternalLink, MapPin, Search } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import {
  SHELLS,
  VERSION_ORDER,
  ageDays,
  displayName,
  isInOrbit,
  isOrbitStale,
  launchFor,
  launchGroup,
  lifecyclePhase,
  orbitOf,
  starlinkVersion,
  versionColor,
  type LaunchIndex,
  type LifecyclePhase,
  type StarlinkVersion,
} from '../lib/starlink'
import {
  filterSatellites,
  sortSatellites,
  type SatelliteSort,
  type SatelliteStatusFilter,
} from '../lib/starlinkStats'
import type { Launch, Satellite } from '../lib/types'
import { cn, formatInt } from '../lib/utils'
import { Badge } from './ui/Badge'

const PAGE_SIZE = 50

/** Badge tone per phase: green on station, blue/violet in transit, amber leaving, red failed. */
const PHASE_TONE: Record<LifecyclePhase, Parameters<typeof Badge>[0]['tone']> = {
  Operational: 'emerald',
  'Orbit raising': 'accent',
  'Plane drift': 'violet',
  Relocating: 'violet',
  'Out of constellation': 'amber',
  'Lowering to reentry': 'amber',
  'Special tests': 'violet',
  Anomalous: 'amber',
  'Failed, decaying': 'crimson',
  Screened: 'crimson',
  Graveyard: 'neutral',
  Unknown: 'neutral',
  Reentered: 'neutral',
}

const STATUS_OPTIONS: Array<[SatelliteStatusFilter, string]> = [
  ['', 'All statuses'],
  ['inOrbit', 'In orbit'],
  ['operational', 'In operational shell'],
  ['decaying', 'Decaying now'],
  ['reentered', 'Reentered'],
]

const SORT_OPTIONS: Array<[SatelliteSort, string]> = [
  ['newest', 'Newest'],
  ['oldest', 'Oldest'],
  ['altitude', 'Highest'],
  ['norad', 'NORAD'],
]

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: Array<[T, string]>
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label-caps">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="min-w-0 rounded-lg border border-white/10 bg-space px-3 py-2 text-xs text-white/80 outline-none transition-colors hover:border-white/20 focus:border-accent/50"
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  )
}

function formatAge(days: number | null): string {
  if (days == null) return '—'
  return days < 60 ? `${formatInt(days)} d` : `${(days / 365.25).toFixed(1)} y`
}

export function StarlinkTable({
  satellites,
  asOf,
  launchIndex,
  onOpenLaunch,
  selectedNorad,
  onSelect,
}: {
  satellites: Satellite[]
  asOf: string
  launchIndex: LaunchIndex
  onOpenLaunch: (launch: Launch) => void
  selectedNorad: number | null
  /** Highlight a satellite on the live map. */
  onSelect: (norad: number | null) => void
}) {
  const [search, setSearch] = useState('')
  const [version, setVersion] = useState<StarlinkVersion | ''>('')
  const [status, setStatus] = useState<SatelliteStatusFilter>('')
  const [shell, setShell] = useState('')
  const [sort, setSort] = useState<SatelliteSort>('newest')
  const [page, setPage] = useState(0)

  // Filtering 13k rows on every keystroke is cheap but not free; deferring
  // keeps typing responsive while the list catches up.
  const deferredSearch = useDeferredValue(search)

  const rows = useMemo(
    () => sortSatellites(filterSatellites(satellites, { search: deferredSearch, version, status, shell }), sort),
    [satellites, deferredSearch, version, status, shell, sort],
  )

  // Any change to the query starts over at page 1.
  useEffect(() => setPage(0), [deferredSearch, version, status, shell, sort])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)

  const versionOptions: Array<[StarlinkVersion | '', string]> = [
    ['', 'All versions'],
    ...VERSION_ORDER.filter((v) => satellites.some((s) => starlinkVersion(s) === v)).map(
      (v) => [v, v] as [StarlinkVersion, string],
    ),
  ]
  const shellOptions: Array<[string, string]> = [
    ['', 'All shells'],
    ...SHELLS.map((s) => [s.id, s.label] as [string, string]),
    ['other', 'Other'],
  ]

  return (
    <section id="sl-table" className="panel scroll-mt-6 p-4 sm:p-5">
      <header className="mb-4">
        <h3 className="text-sm font-semibold text-white/85">
          Satellite catalogue — {formatInt(satellites.length)} satellites
        </h3>
        <p className="mt-0.5 text-[0.7rem] text-white/40">
          Every Starlink ever launched. Search by name, NORAD id, COSPAR id or launch group; the pin
          shows a satellite on the live map.
        </p>
      </header>

      <div className="mb-3 space-y-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-white/25"
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search Starlink-31412, 58123, 2026-160, Group 15-14…"
            aria-label="Search satellites"
            className="w-full rounded-lg border border-white/10 bg-space py-2 pl-9 pr-3 text-sm text-white/85 placeholder:text-white/25 outline-none transition-colors hover:border-white/20 focus:border-accent/50"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Select label="Version" value={version} onChange={setVersion} options={versionOptions} />
          <Select label="Status" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          <Select label="Shell" value={shell} onChange={setShell} options={shellOptions} />
          <Select label="Sort" value={sort} onChange={setSort} options={SORT_OPTIONS} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-white/[0.08]">
        <table className="w-full min-w-[64rem] text-left text-xs">
          <thead className="bg-surface-hi/95">
            <tr className="border-b border-white/10">
              <th className="label-caps px-3 py-2 font-medium">Satellite</th>
              <th className="label-caps px-3 py-2 text-right font-medium">NORAD</th>
              <th className="label-caps px-3 py-2 font-medium">COSPAR</th>
              <th className="label-caps px-3 py-2 font-medium">Version</th>
              <th className="label-caps px-3 py-2 font-medium">Launch group</th>
              <th className="label-caps px-3 py-2 font-medium">Launched</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Age</th>
              <th className="label-caps px-3 py-2 font-medium">Status</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Perigee × apogee</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Inc</th>
              <th className="label-caps px-3 py-2 font-medium">Orbit as of</th>
              <th className="label-caps px-3 py-2 font-medium">Reentered</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <SatelliteRow
                key={s.jcat}
                sat={s}
                asOf={asOf}
                launch={launchFor(s, launchIndex)}
                onOpenLaunch={onOpenLaunch}
                selected={s.norad != null && s.norad === selectedNorad}
                onSelect={onSelect}
              />
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-10 text-center text-white/40">
                  No satellites match — try clearing the search or widening the filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-[0.7rem] tnum text-white/35">
          {rows.length === 0
            ? '0 satellites'
            : `${formatInt(current * PAGE_SIZE + 1)}–${formatInt(Math.min(rows.length, (current + 1) * PAGE_SIZE))} of ${formatInt(rows.length)}`}
        </p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage(current - 1)}
            disabled={current === 0}
            aria-label="Previous page"
            className="rounded-lg border border-white/10 p-1.5 text-white/60 transition-colors hover:border-white/20 hover:text-white disabled:opacity-30"
          >
            <ChevronLeft className="size-3.5" aria-hidden />
          </button>
          <span className="px-2 font-mono text-[0.7rem] tnum text-white/45">
            {current + 1} / {pages}
          </span>
          <button
            onClick={() => setPage(current + 1)}
            disabled={current >= pages - 1}
            aria-label="Next page"
            className="rounded-lg border border-white/10 p-1.5 text-white/60 transition-colors hover:border-white/20 hover:text-white disabled:opacity-30"
          >
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <p className="mt-2 text-[0.65rem] leading-relaxed text-white/30">
        Version comes from GCAT's per-satellite Program field (v1.5 is inferred from launch group),
        not an official SpaceX label. Orbits are mean elements from CelesTrak, or GCAT's latest
        catalogued orbit, and can be days old (amber after 14 days) — not live telemetry. Satellites
        lost before the US catalogue assigned a number have no NORAD id. ≈ marks an approximate date.
      </p>
    </section>
  )
}

function SatelliteRow({
  sat,
  asOf,
  launch,
  onOpenLaunch,
  selected,
  onSelect,
}: {
  sat: Satellite
  asOf: string
  launch: Launch | null
  onOpenLaunch: (launch: Launch) => void
  selected: boolean
  onSelect: (norad: number | null) => void
}) {
  const version = starlinkVersion(sat)
  const phase = lifecyclePhase(sat)
  const orbit = orbitOf(sat)
  const stale = isOrbitStale(sat, asOf)
  const group = launchGroup(sat)
  // Only satellites the map can actually draw: in orbit, with a CelesTrak
  // element set (the newest launches go days without one).
  const canLocate = sat.norad != null && isInOrbit(sat) && sat.gpEpoch != null

  return (
    <tr
      className={cn(
        'border-b border-white/[0.05] transition-colors last:border-0 hover:bg-white/[0.03]',
        selected && 'bg-accent/[0.07]',
      )}
    >
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          {canLocate ? (
            <button
              onClick={() => onSelect(selected ? null : sat.norad)}
              aria-pressed={selected}
              title={selected ? 'Clear map selection' : 'Show on the live map'}
              className={cn('rounded p-0.5 transition-colors hover:text-accent', selected ? 'text-accent' : 'text-white/30')}
            >
              <MapPin className="size-3.5" aria-hidden />
              <span className="sr-only">{selected ? 'Clear map selection' : `Show ${displayName(sat)} on the map`}</span>
            </button>
          ) : (
            <span className="inline-block w-[1.125rem]" aria-hidden />
          )}
          <span className="font-mono font-semibold tnum text-white/85">{displayName(sat)}</span>
        </span>
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-white/60">{sat.norad ?? '—'}</td>
      <td className="px-3 py-2 font-mono tnum text-white/50">{sat.piece ?? '—'}</td>
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-white/70">
          <span aria-hidden className="size-2 rounded-full" style={{ background: versionColor(version) }} />
          {version}
        </span>
      </td>
      <td className="px-3 py-2">
        {launch ? (
          <button
            onClick={() => onOpenLaunch(launch)}
            className="inline-flex items-center gap-1 whitespace-nowrap text-white/65 hover:text-accent"
            title={launch.name}
          >
            {group ?? sat.launchTag}
            <ExternalLink className="size-3 text-white/30" aria-hidden />
          </button>
        ) : (
          <span className="whitespace-nowrap text-white/45">{group ?? sat.launchTag ?? '—'}</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono tnum whitespace-nowrap text-white/55">
        {sat.launchDate ? `${sat.launchDateApprox ? '≈ ' : ''}${sat.launchDate}` : '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-white/55">{formatAge(ageDays(sat, asOf))}</td>
      <td className="px-3 py-2">
        <Badge tone={PHASE_TONE[phase]}>{phase}</Badge>
      </td>
      <td className="px-3 py-2 text-right font-mono tnum whitespace-nowrap text-white/60">
        {orbit ? `${Math.round(orbit.perigeeKm)} × ${Math.round(orbit.apogeeKm)} km` : '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-white/50">
        {sat.incDeg != null ? `${sat.incDeg.toFixed(1)}°` : '—'}
      </td>
      <td className={cn('px-3 py-2 font-mono tnum whitespace-nowrap', stale ? 'text-amber' : 'text-white/45')}>
        {orbit ? `${orbit.epoch}${orbit.source === 'gcat' ? ' (GCAT)' : ''}` : '—'}
      </td>
      <td className="px-3 py-2 font-mono tnum whitespace-nowrap text-white/45">
        {sat.decayDate ? `${sat.decayDateApprox ? '≈ ' : ''}${sat.decayDate}` : '—'}
      </td>
    </tr>
  )
}
