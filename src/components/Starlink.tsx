import { ExternalLink } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { useStarlink, useStarlinkHistory } from '../hooks/useStarlink'
import {
  PHASE_COLORS,
  REENTRY_CAUSE_COLORS,
  REENTRY_CAUSE_ORDER,
  STALE_ORBIT_DAYS,
  VERSION_COLORS,
  daysBetween,
  indexStarlinkLaunches,
  versionColor,
  type VersionFamily,
} from '../lib/starlink'
import { STORM_EVENTS, TARGET_ALTITUDES } from '../lib/starlinkReference'
import {
  ageHistogram,
  altitudeHistogram,
  computeStarlinkKpis,
  constellationGrowth,
  decodeHistory,
  launchedPerPeriod,
  lifetimeByVersion,
  perLaunchHealth,
  phaseMix,
  reentriesPerPeriod,
  referenceDelta,
  shellGrid,
  survivalCurve,
  versionBreakdown,
  versionsPresent,
  type Granularity,
  type LaunchHealthRow,
  type ReentryGranularity,
} from '../lib/starlinkStats'
import type { Launch } from '../lib/types'
import { cn, formatInt, formatPct } from '../lib/utils'
import { StarlinkDownloadButton } from './DownloadButton'
import { StarlinkTable } from './StarlinkTable'
import { Badge } from './ui/Badge'
import { ChartTooltip } from './ui/ChartTooltip'
import { ErrorState, LoadingState } from './ui/States'

/**
 * The live map pulls in satellite.js and the SGP4 worker (and three.js on
 * the 3D toggle), so it is its own chunk on top of this one.
 */
const StarlinkMap = lazy(() =>
  import('./starlink/StarlinkMap').then((m) => ({ default: m.StarlinkMap })),
)

const AXIS = {
  stroke: 'rgba(255,255,255,0.25)',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
}
const CURSOR = { fill: 'rgba(255,255,255,0.04)' }
const GRID = 'rgba(255,255,255,0.06)'

const STATUS_COLORS = {
  operational: '#10b981',
  otherInOrbit: '#f59e0b',
  reentered: '#475569',
}

const FAMILY_COLORS: Record<VersionFamily, string> = {
  Prototype: VERSION_COLORS.Tintin,
  V1: VERSION_COLORS['v1.5'],
  'V2 Mini': VERSION_COLORS['v2 Mini'],
  V3: VERSION_COLORS.V3,
  Unclassified: VERSION_COLORS.Unclassified,
}

function Panel({
  id,
  title,
  subtitle,
  children,
  height,
  focused = false,
  actions,
}: {
  id?: string
  title: string
  subtitle?: string
  children: React.ReactNode
  /** Set for a single Recharts chart; omit for free-form content. */
  height?: number
  focused?: boolean
  actions?: React.ReactNode
}) {
  return (
    <section
      id={id}
      className={cn(
        'panel scroll-mt-6 p-4 transition-shadow duration-500 sm:p-5',
        focused && 'ring-2 ring-accent/60',
      )}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white/85">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[0.7rem] text-white/40">{subtitle}</p>}
        </div>
        {actions}
      </header>
      {height ? (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {children as React.ReactElement}
          </ResponsiveContainer>
        </div>
      ) : (
        children
      )}
    </section>
  )
}

type Tone = 'accent' | 'emerald' | 'amber' | 'violet' | 'crimson' | 'neutral'

function Stat({
  label,
  value,
  sub,
  tone = 'accent',
  definition,
}: {
  label: string
  value: string
  sub?: string
  tone?: Tone
  /** What exactly is counted; shown on hover since the "active" figures differ by definition. */
  definition?: string
}) {
  const toneClass = {
    accent: 'text-accent',
    emerald: 'text-emerald',
    amber: 'text-amber',
    violet: 'text-violet',
    crimson: 'text-crimson',
    neutral: 'text-white/80',
  }[tone]
  return (
    <div className="panel p-4" title={definition}>
      <p className="label-caps">{label}</p>
      <p className={cn('mt-2 font-mono text-2xl font-bold tnum', toneClass)}>{value}</p>
      {sub && <p className="mt-1 text-[0.7rem] leading-snug text-white/40">{sub}</p>}
    </div>
  )
}

/** Two-to-four way toggle in the style of the Boosters sort control. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: Array<[T, string]>
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1">
      {options.map(([key, text]) => (
        <button
          key={key}
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={cn(
            'rounded-lg px-3 py-1 text-xs font-medium transition-all',
            value === key
              ? 'bg-accent/15 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.25)]'
              : 'text-white/45 hover:bg-white/5 hover:text-white/75',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** "45 d" under two months, "2.3 y" beyond — ages span days to seven years. */
function formatAge(days: number | null): string {
  if (days == null) return '—'
  return days < 60 ? `${formatInt(days)} d` : `${(days / 365.25).toFixed(1)} y`
}

const LEGEND = { wrapperStyle: { fontSize: 11, paddingTop: 8 }, iconType: 'circle' as const, iconSize: 8 }

export function Starlink({
  launches,
  onOpenLaunch,
  focusChart,
  onFocusHandled,
}: {
  launches: Launch[]
  onOpenLaunch: (launch: Launch) => void
  focusChart?: string | null
  onFocusHandled?: () => void
}) {
  const { data, isPending, isError, error, refetch } = useStarlink()
  const history = useStarlinkHistory()
  const [launchedBy, setLaunchedBy] = useState<Granularity>('year')
  const [reentriesBy, setReentriesBy] = useState<ReentryGranularity>('month')
  const [selectedNorad, setSelectedNorad] = useState<number | null>(null)
  const mapRef = useRef<HTMLDivElement>(null)

  const satellites = useMemo(() => data?.satellites ?? [], [data])
  // Every "how old / how current" figure is measured against the snapshot,
  // never the viewer's clock, so the tab and the spreadsheet agree.
  const asOf = data?.meta.generatedAt ?? ''

  const launchIndex = useMemo(() => indexStarlinkLaunches(launches), [launches])
  const versions = useMemo(() => versionsPresent(satellites), [satellites])
  const kpis = useMemo(() => computeStarlinkKpis(satellites, asOf), [satellites, asOf])
  const byVersion = useMemo(() => versionBreakdown(satellites), [satellites])
  const altitude = useMemo(() => altitudeHistogram(satellites, asOf), [satellites, asOf])
  const shells = useMemo(() => shellGrid(satellites, asOf), [satellites, asOf])
  const phases = useMemo(() => phaseMix(satellites), [satellites])
  const launched = useMemo(() => launchedPerPeriod(satellites, launchedBy), [satellites, launchedBy])
  const reentries = useMemo(
    () => reentriesPerPeriod(satellites, reentriesBy, asOf),
    [satellites, reentriesBy, asOf],
  )
  const growth = useMemo(() => constellationGrowth(satellites, asOf), [satellites, asOf])
  const ages = useMemo(() => ageHistogram(satellites, asOf), [satellites, asOf])
  const lifetimes = useMemo(() => lifetimeByVersion(satellites), [satellites])
  const survival = useMemo(() => survivalCurve(satellites, asOf), [satellites, asOf])
  const health = useMemo(() => perLaunchHealth(satellites, launchIndex), [satellites, launchIndex])
  const historyRows = useMemo(() => {
    if (!history.data) return []
    return decodeHistory(history.data).map((r) => ({
      date: r.date,
      Operational: r.O as number,
      'Orbit raising': r.A as number,
      'Plane drift': r.D as number,
      Relocating: r.T as number,
      'Out of constellation': r.L as number,
      'Lowering to reentry': r.R as number,
      Failed: (Number(r.F) || 0) + (Number(r.M) || 0) + (Number(r.G) || 0),
    }))
  }, [history.data])

  // Lazy-loaded, so the deep-link scroll has to happen here (see Analytics.tsx).
  useEffect(() => {
    if (!focusChart || !data) return
    const el = document.getElementById(focusChart)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const timer = window.setTimeout(() => onFocusHandled?.(), 2600)
    return () => window.clearTimeout(timer)
  }, [focusChart, onFocusHandled, data])

  if (isPending) return <LoadingState label="Loading constellation catalogue…" />
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />
  if (satellites.length === 0) {
    return (
      <div className="panel px-6 py-16 text-center text-sm text-white/45">
        The satellite catalogue is empty — the last data refresh may have failed.
      </div>
    )
  }

  const meta = data.meta
  const delta = referenceDelta(kpis, meta)
  // Display-only staleness hint; everything else is relative to the snapshot.
  const ageOfSnapshot = daysBetween(meta.generatedAt, new Date().toISOString())

  // Target altitudes as reference lines on the 10 km histogram bins. Labels
  // are just the inclinations ("DTC" marked) because neighbouring targets sit
  // one bin apart and full names collide; the subtitle carries the meaning.
  const targetBins = new Map<string, string[]>()
  for (const t of TARGET_ALTITUDES.shells) {
    const bin = String(Math.floor(t.altitudeKm / 10) * 10)
    const short = `${t.label.startsWith('DTC') ? 'DTC ' : ''}${t.incDeg}°`
    if (altitude.some((b) => b.label === bin)) targetBins.set(bin, [...(targetBins.get(bin) ?? []), short])
  }
  const storms = STORM_EVENTS.filter((s) =>
    reentriesBy === 'month' ? reentries.some((r) => r.period === s.date.slice(0, 7)) : false,
  )

  const selectSatellite = (norad: number | null) => {
    setSelectedNorad(norad)
    if (norad != null) mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="space-y-4">
      {/* Provenance + export */}
      <div className="panel flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-white/85">Starlink constellation</h2>
          <p className="font-mono text-[0.7rem] tnum text-white/45">
            Catalogue as of {(meta.gcatUpdated ?? meta.generatedAt).slice(0, 16).replace('T', ' ')} UTC
            {' · '}GCAT (J. McDowell){meta.gp && ` · elements to ${meta.gp.maxEpoch.slice(0, 16).replace('T', ' ')} UTC (CelesTrak)`}
          </p>
          {delta && (
            <p className="text-[0.7rem] text-white/40">
              McDowell publishes{' '}
              <span className="font-mono tnum text-white/60">
                {formatInt(delta.launched.theirs)} launched · {formatInt(delta.inOrbit.theirs)} in orbit
              </span>
              ; this catalogue counts{' '}
              <span className="font-mono tnum text-white/60">
                {formatInt(delta.launched.ours)} · {formatInt(delta.inOrbit.ours)}
              </span>
              {delta.asOf && <span className="text-white/30"> (his page as of {delta.asOf.slice(0, 10)})</span>}.
            </p>
          )}
          {ageOfSnapshot > 3 && (
            <Badge tone="amber" className="mt-1">
              Catalogue snapshot is {ageOfSnapshot} days old
            </Badge>
          )}
        </div>
        <StarlinkDownloadButton snapshot={data} launches={launches} />
      </div>

      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Launched"
          value={formatInt(kpis.launched)}
          sub="Every Starlink ever launched, incl. losses"
          definition="All production Starlink satellites launched, including launch failures and satellites lost before cataloguing. Excludes Starship mass simulators and test articles."
        />
        <Stat
          label="In orbit"
          value={formatInt(kpis.inOrbit)}
          tone="violet"
          sub={`${formatPct(kpis.inOrbit / kpis.launched)} of launched`}
          definition="Not yet reentered, whatever their condition."
        />
        <Stat
          label="Working"
          value={formatInt(kpis.working)}
          tone="emerald"
          sub="In orbit and not failed"
          definition="McDowell's definition: in orbit, excluding satellites screened as failed, failed and decaying, or in a graveyard orbit. Satellites being raised, drifted or lowered still count."
        />
        <Stat
          label="In operational shell"
          value={formatInt(kpis.operational)}
          tone="emerald"
          sub={`${formatPct(kpis.operational / kpis.inOrbit)} of those in orbit`}
          definition="In orbit and on station in an operational shell (GCAT lifecycle flag O). The strictest 'active' count."
        />
        <Stat
          label="Reentered"
          value={formatInt(kpis.reentered)}
          tone="neutral"
          sub="Disposal, failures and launch losses"
          definition="Satellites no longer in orbit: deliberate disposal, early deorbit, reentry after failure, and launch failures."
        />
        <Stat
          label="Decaying now"
          value={formatInt(kpis.decaying)}
          tone="amber"
          sub="Lowering to reentry or failed"
          definition="In orbit and coming down: controlled lowering for disposal (flag R) or uncontrolled decay after failure (flag M)."
        />
        <Stat
          label="Median age"
          value={formatAge(kpis.medianAgeDays)}
          sub="Of satellites in orbit"
          definition="Median days since launch for satellites in orbit, measured to the snapshot time."
        />
        <Stat
          label="Median altitude"
          value={kpis.medianAltitudeKm != null ? `${Math.round(kpis.medianAltitudeKm)} km` : '—'}
          sub="Mean orbital height, in orbit"
          definition={`Median of semi-major axis minus Earth's radius, from CelesTrak elements (or GCAT's latest catalogued orbit). Orbits older than ${STALE_ORBIT_DAYS} days are left out.`}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Mass on orbit"
          value={`${formatInt(kpis.massOnOrbitT)} t`}
          tone="neutral"
          sub="GCAT estimates, summed"
          definition="Sum of GCAT's per-satellite mass estimates for satellites in orbit. Estimates, not manufacturer figures."
        />
        <Stat
          label="Direct to cell"
          value={formatInt(kpis.dtcInOrbit)}
          tone="violet"
          sub="v2 Mini DTC in orbit"
          definition="V2 Mini direct-to-cell satellites in orbit (GCAT Program 2M D1/D2)."
        />
        <Stat
          label="V3 in orbit"
          value={formatInt(kpis.v3InOrbit)}
          tone="violet"
          sub="Starship-launched V3 satellites"
          definition="V3 satellites in orbit (GCAT Program 'Starlink 3')."
        />
        <Stat
          label="Stale or missing orbits"
          value={formatInt(kpis.staleOrbits)}
          tone={kpis.staleOrbits > 100 ? 'amber' : 'neutral'}
          sub={`No orbit newer than ${STALE_ORBIT_DAYS} days`}
          definition="In orbit, but neither CelesTrak nor GCAT has an orbit for them from the last two weeks — usually satellites launched days ago and not yet catalogued. Left out of altitude charts."
        />
      </div>

      {/* Live map */}
      <div ref={mapRef} className="scroll-mt-6">
        <Suspense fallback={<LoadingState label="Loading orbit propagator…" />}>
          <StarlinkMap
            satellites={satellites}
            asOf={asOf}
            selectedNorad={selectedNorad}
            onSelect={setSelectedNorad}
          />
        </Suspense>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          id="sl-versions"
          focused={focusChart === 'sl-versions'}
          title="Satellites by version"
          subtitle="Hardware version from GCAT's per-satellite Program field. v1.5 is inferred from launch group."
          height={300}
        >
          <BarChart data={byVersion} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <CartesianGrid stroke={GRID} horizontal={false} />
            <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="version"
              tick={{ ...AXIS, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              width={110}
            />
            <Tooltip cursor={CURSOR} content={<ChartTooltip showTotal valueSuffix="sats" />} />
            <Legend {...LEGEND} />
            <Bar dataKey="operational" name="In operational shell" stackId="v" fill={STATUS_COLORS.operational} />
            <Bar dataKey="otherInOrbit" name="Other in orbit" stackId="v" fill={STATUS_COLORS.otherInOrbit} />
            <Bar
              dataKey="reentered"
              name="Reentered"
              stackId="v"
              fill={STATUS_COLORS.reentered}
              radius={[0, 3, 3, 0]}
            />
          </BarChart>
        </Panel>

        <Panel
          id="sl-phase"
          focused={focusChart === 'sl-phase'}
          title="Lifecycle phase, in orbit"
          subtitle="GCAT's Starlink status flag: on station, raising, drifting between planes, moved out of the shell, or coming down."
          height={300}
        >
          <PieChart>
            <Pie
              data={phases}
              dataKey="count"
              nameKey="phase"
              innerRadius="45%"
              outerRadius="72%"
              paddingAngle={1}
              stroke="#0e1117"
              strokeWidth={2}
            >
              {phases.map((p) => (
                <Cell key={p.phase} fill={p.color} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip valueSuffix="sats" />} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} layout="horizontal" verticalAlign="bottom" />
          </PieChart>
        </Panel>
      </div>

      <Panel
        id="sl-altitude"
        focused={focusChart === 'sl-altitude'}
        title="Altitude distribution"
        subtitle={`Satellites in orbit by mean altitude, 10 km bins. Dashed lines: SpaceX's published end-of-2026 target heights per shell inclination (broadband ${TARGET_ALTITUDES.shells.filter((t) => !t.label.startsWith('DTC')).map((t) => `${t.incDeg}° ${t.altitudeKm} km`).join(', ')}; direct-to-cell ${TARGET_ALTITUDES.shells.filter((t) => t.label.startsWith('DTC')).map((t) => `${t.incDeg}° ${t.altitudeKm} km`).join(', ')}). Mean elements a few hours old, not live telemetry; orbits older than ${STALE_ORBIT_DAYS} days are left out.`}
        height={320}
      >
        <BarChart data={altitude} margin={{ top: 32, right: 8, bottom: 4, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} minTickGap={12} unit=" km" />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={CURSOR}
            content={<ChartTooltip showTotal valueSuffix="sats" />}
            labelFormatter={(l) => `${l}–${Number(l) + 10} km`}
          />
          <Legend {...LEGEND} />
          {[...targetBins].map(([bin, labels], i) => (
            <ReferenceLine
              key={bin}
              x={bin}
              stroke="rgba(255,255,255,0.35)"
              strokeDasharray="3 3"
              // Alternate label heights so adjacent bins' labels don't overlap.
              label={{
                value: labels.join(' / '),
                position: 'top',
                offset: i % 2 === 0 ? 4 : 16,
                fill: 'rgba(255,255,255,0.45)',
                fontSize: 9,
              }}
            />
          ))}
          {versions.map((v, i) => (
            <Bar
              key={v}
              dataKey={v}
              name={v}
              stackId="a"
              fill={versionColor(v)}
              radius={i === versions.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
            />
          ))}
        </BarChart>
      </Panel>

      <Panel
        id="sl-shells"
        focused={focusChart === 'sl-shells'}
        title="Orbital shells"
        subtitle="Inclination against altitude for satellites in orbit; bubble size is the number of satellites, colour the most common version. Gen1's 97.6° and Gen2's 97.3° polar shells are separate populations."
        height={340}
      >
        <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: -4 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis
            type="number"
            dataKey="incDeg"
            name="Inclination"
            unit="°"
            domain={[25, 100]}
            ticks={[30, 43, 53, 70, 97]}
            tick={AXIS}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="number"
            dataKey="altitudeKm"
            name="Altitude"
            unit=" km"
            domain={['dataMin - 20', 'dataMax + 20']}
            tick={AXIS}
            axisLine={false}
            tickLine={false}
          />
          <ZAxis type="number" dataKey="count" name="Satellites" range={[16, 700]} />
          <Tooltip
            cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }}
            content={
              <ChartTooltip
                formatValue={(v, entry) =>
                  entry.name === 'Inclination' ? `${v.toFixed(1)}°` : entry.name === 'Altitude' ? `${Math.round(v)} km` : formatInt(v)
                }
              />
            }
          />
          <Legend {...LEGEND} />
          {versions.map((v) => {
            const pts = shells.filter((p) => p.version === v)
            return pts.length ? (
              <Scatter key={v} name={v} data={pts} fill={versionColor(v)} fillOpacity={0.75} />
            ) : null
          })}
        </ScatterChart>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          id="sl-launched"
          focused={focusChart === 'sl-launched'}
          title="Satellites launched"
          subtitle="By launch date and version, including launch losses. The current period is partial."
          height={300}
          actions={
            <Segmented
              label="Granularity"
              value={launchedBy}
              onChange={setLaunchedBy}
              options={[
                ['year', 'Year'],
                ['quarter', 'Quarter'],
              ]}
            />
          }
        >
          <BarChart data={launched} margin={{ top: 4, right: 8, bottom: 4, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="period" tick={AXIS} axisLine={false} tickLine={false} minTickGap={8} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip cursor={CURSOR} content={<ChartTooltip showTotal valueSuffix="sats" />} />
            <Legend {...LEGEND} />
            {versions.map((v, i) => (
              <Bar
                key={v}
                dataKey={v}
                name={v}
                stackId="l"
                fill={versionColor(v)}
                radius={i === versions.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </Panel>

        <Panel
          id="sl-reentries"
          focused={focusChart === 'sl-reentries'}
          title="Reentries"
          subtitle={
            reentriesBy === 'month'
              ? 'Last 36 months, by cause. Dashed lines mark geomagnetic storms (context only).'
              : 'By year and cause. The Feb 2022 storm took 38 of one batch of 49.'
          }
          height={300}
          actions={
            <Segmented
              label="Granularity"
              value={reentriesBy}
              onChange={setReentriesBy}
              options={[
                ['month', 'Month'],
                ['year', 'Year'],
              ]}
            />
          }
        >
          <BarChart data={reentries} margin={{ top: 32, right: 8, bottom: 4, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="period" tick={AXIS} axisLine={false} tickLine={false} minTickGap={12} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip cursor={CURSOR} content={<ChartTooltip showTotal valueSuffix="sats" />} />
            <Legend {...LEGEND} />
            {storms.map((s, i) => (
              <ReferenceLine
                key={s.date}
                x={s.date.slice(0, 7)}
                stroke="rgba(239,68,68,0.5)"
                strokeDasharray="3 3"
                label={{
                  value: s.label,
                  position: 'top',
                  offset: i % 2 === 0 ? 4 : 16,
                  fill: 'rgba(255,255,255,0.45)',
                  fontSize: 9,
                }}
              />
            ))}
            {REENTRY_CAUSE_ORDER.map((c, i) => (
              <Bar
                key={c}
                dataKey={c}
                name={c}
                stackId="r"
                fill={REENTRY_CAUSE_COLORS[c]}
                radius={i === REENTRY_CAUSE_ORDER.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </Panel>
      </div>

      <Panel
        id="sl-growth"
        focused={focusChart === 'sl-growth'}
        title="Constellation growth"
        subtitle="Cumulative satellites launched and reentered, and the number in orbit, at the end of each month."
        height={300}
      >
        <LineChart data={growth} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="month" tick={AXIS} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ stroke: 'rgba(255,255,255,0.15)' }} content={<ChartTooltip valueSuffix="sats" />} />
          <Legend {...LEGEND} />
          <Line type="monotone" dataKey="launched" name="Launched" stroke="#38bdf8" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="inOrbit" name="In orbit" stroke="#a78bfa" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="reentered" name="Reentered" stroke="#64748b" strokeWidth={2} dot={false} />
        </LineChart>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          id="sl-age"
          focused={focusChart === 'sl-age'}
          title="Age of satellites in orbit"
          subtitle="Time since launch, six-month bins, by version."
          height={300}
        >
          <BarChart data={ages} margin={{ top: 4, right: 8, bottom: 4, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="label" tick={{ ...AXIS, fontSize: 9 }} axisLine={false} tickLine={false} minTickGap={4} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip cursor={CURSOR} content={<ChartTooltip showTotal valueSuffix="sats" />} />
            <Legend {...LEGEND} />
            {versions.map((v, i) => (
              <Bar
                key={v}
                dataKey={v}
                name={v}
                stackId="g"
                fill={versionColor(v)}
                radius={i === versions.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </Panel>

        <Panel
          id="sl-lifetime"
          focused={focusChart === 'sl-lifetime'}
          title="Lifetime of reentered satellites"
          subtitle="Median years from launch to reentry. Young versions look short-lived because only their early failures have come down yet; see the survival curve."
          height={300}
        >
          <BarChart data={lifetimes} margin={{ top: 4, right: 8, bottom: 4, left: -12 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="version" tick={{ ...AXIS, fontSize: 9 }} axisLine={false} tickLine={false} interval={0} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} unit=" y" />
            <Tooltip
              cursor={CURSOR}
              content={
                <ChartTooltip
                  valueSuffix="years"
                  formatValue={(v, entry) => {
                    const row = entry.payload as { samples?: number } | undefined
                    return `${v.toFixed(1)}${row?.samples ? ` (n=${formatInt(row.samples)})` : ''}`
                  }}
                />
              }
            />
            <Bar dataKey="medianYears" name="Median lifetime" radius={[3, 3, 0, 0]}>
              {lifetimes.map((r) => (
                <Cell key={r.version} fill={versionColor(r.version)} />
              ))}
            </Bar>
          </BarChart>
        </Panel>
      </div>

      <Panel
        id="sl-survival"
        focused={focusChart === 'sl-survival'}
        title="Orbital survival by hardware family"
        subtitle="Kaplan–Meier probability of still being in orbit N years after launch. Satellites still up count as censored; the event is reentry, deliberate disposal included, so this is orbital survival, not hardware reliability. Curves stop when fewer than 25 satellites remain at risk."
        height={300}
      >
        <LineChart data={survival} margin={{ top: 4, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="years" type="number" domain={[0, 'dataMax']} tick={AXIS} axisLine={false} tickLine={false} unit=" y" />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} domain={[0, 1]} tickFormatter={(v: number) => formatPct(v, 0)} />
          <Tooltip
            cursor={{ stroke: 'rgba(255,255,255,0.15)' }}
            labelFormatter={(l) => `${l} years after launch`}
            content={<ChartTooltip formatValue={(v) => formatPct(v, 1)} />}
          />
          <Legend {...LEGEND} />
          {(['V1', 'V2 Mini', 'V3'] as VersionFamily[]).map((f) => (
            <Line
              key={f}
              type="stepAfter"
              dataKey={f}
              name={f}
              stroke={FAMILY_COLORS[f]}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </Panel>

      {historyRows.length > 0 && (
        <Panel
          id="sl-history"
          focused={focusChart === 'sl-history'}
          title="Constellation status over time"
          subtitle="Satellites in orbit by state, weekly. From McDowell's daily status log (his orbital-status heuristic), which counts slightly differently from the per-satellite figures above — so these numbers are not mixed into the KPIs."
          height={300}
        >
          <AreaChart data={historyRows} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="date" tick={AXIS} axisLine={false} tickLine={false} minTickGap={32} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip cursor={{ stroke: 'rgba(255,255,255,0.15)' }} content={<ChartTooltip showTotal valueSuffix="sats" />} />
            <Legend {...LEGEND} />
            {(
              [
                ['Operational', PHASE_COLORS.Operational],
                ['Orbit raising', PHASE_COLORS['Orbit raising']],
                ['Plane drift', PHASE_COLORS['Plane drift']],
                ['Relocating', PHASE_COLORS.Relocating],
                ['Out of constellation', PHASE_COLORS['Out of constellation']],
                ['Lowering to reentry', PHASE_COLORS['Lowering to reentry']],
                ['Failed', PHASE_COLORS['Failed, decaying']],
              ] as const
            ).map(([key, color]) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stackId="h"
                stroke={color}
                fill={color}
                fillOpacity={0.55}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </Panel>
      )}

      <LaunchHealthTable rows={health} onOpenLaunch={onOpenLaunch} />

      <StarlinkTable
        satellites={satellites}
        asOf={asOf}
        launchIndex={launchIndex}
        onOpenLaunch={onOpenLaunch}
        selectedNorad={selectedNorad}
        onSelect={selectSatellite}
      />
    </div>
  )
}

function LaunchHealthTable({
  rows,
  onOpenLaunch,
}: {
  rows: LaunchHealthRow[]
  onOpenLaunch: (launch: Launch) => void
}) {
  return (
    <Panel
      id="sl-launches"
      title={`Batch health by launch — ${formatInt(rows.length)} launches`}
      subtitle="How each launch's satellites have fared. Open a launch for its mission details."
    >
      <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-white/[0.08]">
        <table className="w-full min-w-[48rem] text-left text-xs">
          <thead className="sticky top-0 z-10 bg-surface-hi/95 backdrop-blur-sm">
            <tr className="border-b border-white/10">
              <th className="label-caps px-3 py-2 font-medium">Launch</th>
              <th className="label-caps px-3 py-2 font-medium">Date</th>
              <th className="label-caps px-3 py-2 font-medium">Version</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Deployed</th>
              <th className="label-caps px-3 py-2 text-right font-medium">In orbit</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Operational</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Reentered</th>
              <th className="label-caps px-3 py-2 text-right font-medium">Still up</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const up = r.deployed > 0 ? r.inOrbit / r.deployed : 0
              return (
                <tr
                  key={r.launchTag}
                  className="border-b border-white/[0.05] transition-colors last:border-0 hover:bg-white/[0.03]"
                >
                  <td className="px-3 py-2">
                    {r.launch ? (
                      <button
                        onClick={() => onOpenLaunch(r.launch as Launch)}
                        className="inline-flex items-center gap-1 text-left font-medium text-white/80 hover:text-accent"
                      >
                        {r.group ?? r.launchTag}
                        <ExternalLink className="size-3 text-white/30" aria-hidden />
                      </button>
                    ) : (
                      <span className="font-medium text-white/70">{r.group ?? r.launchTag}</span>
                    )}
                    <span className="ml-2 font-mono text-[0.65rem] tnum text-white/30">{r.launchTag}</span>
                  </td>
                  <td className="px-3 py-2 font-mono tnum text-white/55">{r.date ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5 text-white/65">
                      <span aria-hidden className="size-2 rounded-full" style={{ background: versionColor(r.version) }} />
                      {r.version}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tnum text-white/70">{r.deployed}</td>
                  <td className="px-3 py-2 text-right font-mono tnum text-white/70">{r.inOrbit}</td>
                  <td className="px-3 py-2 text-right font-mono tnum text-emerald/80">{r.operational}</td>
                  <td className="px-3 py-2 text-right font-mono tnum text-white/45">{r.reentered}</td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right font-mono font-semibold tnum',
                      up >= 0.9 ? 'text-emerald' : up >= 0.5 ? 'text-amber' : 'text-white/40',
                    )}
                  >
                    {formatPct(up, 0)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
