import { format } from 'date-fns'
import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  computeFleet,
  computeFleetSummary,
  computeLandingSites,
  computeRecoveryMethods,
  computeTurnaroundTrend,
  type FleetRow,
} from '../lib/stats'
import type { Launch } from '../lib/types'
import { cn, formatInt, formatPct } from '../lib/utils'
import { Badge } from './ui/Badge'
import { ChartTooltip } from './ui/ChartTooltip'

const AXIS = {
  stroke: 'rgba(255,255,255,0.25)',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
}
const CURSOR = { fill: 'rgba(255,255,255,0.04)' }

/**
 * Axis ticks only get ~150px, and LL2's recovery-method names are long
 * enough to be clipped ("Autonomous Spaceport Drone Ship" loses its first
 * letter). Abbreviate on the axis; the tooltip still shows the full name
 * because it reads the underlying category value.
 */
const METHOD_ABBREV: Record<string, string> = {
  'Autonomous Spaceport Drone Ship': 'ASDS (droneship)',
  'Return to Launch Site': 'RTLS (land pad)',
  'Parachute Landing': 'Parachute',
}
const abbreviateMethod = (v: string) => METHOD_ABBREV[v] ?? v

/** Keep long droneship / pad names on a single tick line. */
const truncateTick = (v: string) => (v.length > 24 ? `${v.slice(0, 23)}…` : v)

function Panel({
  title,
  subtitle,
  children,
  height,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  height?: number
}) {
  return (
    <section className="panel p-4 sm:p-5">
      <header className="mb-4">
        <h3 className="text-sm font-semibold text-white/85">{title}</h3>
        {subtitle && <p className="mt-0.5 text-[0.7rem] text-white/40">{subtitle}</p>}
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

function Stat({
  label,
  value,
  sub,
  tone = 'accent',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'accent' | 'emerald' | 'amber'
}) {
  const toneClass = { accent: 'text-accent', emerald: 'text-emerald', amber: 'text-amber' }[
    tone
  ]
  return (
    <div className="panel p-4">
      <p className="label-caps">{label}</p>
      <p className={cn('mt-2 font-mono text-2xl font-bold tnum', toneClass)}>{value}</p>
      {sub && <p className="mt-1 text-[0.7rem] leading-snug text-white/40">{sub}</p>}
    </div>
  )
}

type SortKey = 'flights' | 'recent'

export function Boosters({ launches }: { launches: Launch[] }) {
  const [sort, setSort] = useState<SortKey>('flights')

  const trend = useMemo(() => computeTurnaroundTrend(launches), [launches])
  const recovery = useMemo(() => computeRecoveryMethods(launches), [launches])
  const sites = useMemo(() => computeLandingSites(launches), [launches])
  const summary = useMemo(() => computeFleetSummary(launches), [launches])
  const fleet = useMemo(() => computeFleet(launches), [launches])

  const sortedFleet = useMemo(() => {
    const rows = [...fleet]
    return sort === 'flights'
      ? rows.sort((a, b) => b.maxFlightNumber - a.maxFlightNumber)
      : rows.sort((a, b) => b.lastFlown.localeCompare(a.lastFlown))
  }, [fleet, sort])

  if (fleet.length === 0) {
    return (
      <div className="panel px-6 py-16 text-center text-sm text-white/45">
        No identified boosters in scope — widen the mission filter.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Headline numbers */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Cores tracked"
          value={formatInt(summary.cores)}
          sub="Distinct identified boosters"
        />
        <Stat
          label="Successful landings"
          value={formatInt(summary.totalLandings)}
          tone="emerald"
          sub="Across all recovery methods"
        />
        <Stat
          label="Record turnaround"
          value={summary.recordTurnaround != null ? `${summary.recordTurnaround}d` : '—'}
          tone="amber"
          sub="Fastest reflight of a single core"
        />
        <Stat
          label={summary.latestYear ? `Median turnaround ${summary.latestYear}` : 'Median turnaround'}
          value={
            summary.latestMedianTurnaround != null
              ? `${summary.latestMedianTurnaround}d`
              : '—'
          }
          tone="amber"
          sub="Half of reflights were faster than this"
        />
      </div>

      {/* Turnaround trend */}
      <Panel
        title="Booster turnaround over time"
        subtitle={`Days between a core's previous flight and the next. Based on ${formatInt(summary.turnaroundSamples)} reflights of ${formatInt(summary.boosterRecords)} booster records — first flights have no turnaround to measure.`}
        height={320}
      >
        <LineChart data={trend} margin={{ top: 4, right: 12, bottom: 4, left: -12 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="year" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            label={{
              value: 'days',
              angle: -90,
              position: 'insideLeft',
              style: { fill: 'rgba(255,255,255,0.3)', fontSize: 10 },
            }}
          />
          <Tooltip cursor={CURSOR} content={<ChartTooltip valueSuffix="days" />} />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={8} />
          <Line
            type="monotone"
            dataKey="median"
            name="Median"
            stroke="#38bdf8"
            strokeWidth={2}
            dot={{ r: 3, fill: '#38bdf8' }}
            connectNulls
          />
          <Line
            type="monotone"
            dataKey="fastest"
            name="Fastest"
            stroke="#10b981"
            strokeWidth={2}
            strokeDasharray="4 3"
            dot={{ r: 3, fill: '#10b981' }}
            connectNulls
          />
        </LineChart>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Recovery method */}
        <Panel
          title="Recovery method"
          subtitle="How each landing was attempted, and how often it worked."
          height={280}
        >
          <BarChart
            data={recovery}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
            <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="method"
              tick={{ ...AXIS, fontSize: 10 }}
              tickFormatter={abbreviateMethod}
              axisLine={false}
              tickLine={false}
              width={120}
            />
            <Tooltip cursor={CURSOR} content={<ChartTooltip showTotal />} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
            <Bar dataKey="successes" name="Recovered" stackId="r" fill="#10b981" />
            <Bar dataKey="failures" name="Lost" stackId="r" fill="#ef4444" />
            {/* Expended cores and pending landings — without this the
                "Expended" row would be an empty bar despite 45 records. */}
            <Bar
              dataKey="other"
              name="Expended / pending"
              stackId="r"
              fill="#64748b"
              radius={[0, 3, 3, 0]}
            />
          </BarChart>
        </Panel>

        {/* Landing sites */}
        <Panel
          title="Landing sites"
          subtitle="Droneships, landing zones and splashdown areas."
          height={280}
        >
          <BarChart
            data={sites.slice(0, 10)}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
            <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis
              type="category"
              dataKey="site"
              tick={{ ...AXIS, fontSize: 9 }}
              tickFormatter={truncateTick}
              axisLine={false}
              tickLine={false}
              width={150}
            />
            <Tooltip cursor={CURSOR} content={<ChartTooltip showTotal />} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconType="circle" iconSize={8} />
            <Bar dataKey="successes" name="Recovered" stackId="s" fill="#38bdf8" />
            <Bar
              dataKey="failures"
              name="Lost"
              stackId="s"
              fill="#ef4444"
              radius={[0, 3, 3, 0]}
            />
          </BarChart>
        </Panel>
      </div>

      {/* Recovery-rate readout, which a stacked bar alone doesn't convey */}
      <Panel
        title="Recovery rate by method"
        subtitle="Share of decided attempts that ended with the core recovered."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {recovery.map((r) => (
            <div
              key={r.method}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.08] bg-surface/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-white/80">{r.method}</p>
                <p className="font-mono text-[0.65rem] tnum text-white/35">
                  {formatInt(r.attempts)} attempt{r.attempts === 1 ? '' : 's'}
                </p>
              </div>
              <span
                className={cn(
                  'shrink-0 font-mono text-sm font-bold tnum',
                  r.successRate == null
                    ? 'text-white/30'
                    : r.successRate >= 0.9
                      ? 'text-emerald'
                      : r.successRate >= 0.6
                        ? 'text-amber'
                        : 'text-crimson',
                )}
              >
                {r.successRate != null ? formatPct(r.successRate, 0) : 'n/a'}
              </span>
            </div>
          ))}
        </div>
      </Panel>

      {/* Fleet table */}
      <Panel
        title={`Booster fleet — ${formatInt(fleet.length)} cores`}
        subtitle="Every identified core, when it last flew, and how its most recent landing ended."
      >
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <span className="label-caps mr-1">Sort</span>
          {(
            [
              ['flights', 'Most flights'],
              ['recent', 'Most recent'],
            ] as Array<[SortKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={cn(
                'rounded-lg px-3 py-1 text-xs font-medium transition-all',
                sort === key
                  ? 'bg-accent/15 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.25)]'
                  : 'text-white/45 hover:bg-white/5 hover:text-white/75',
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Fixed-height scroll region: all 129 cores stay reachable without
            pushing the rest of the page off screen. */}
        <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-white/[0.08]">
          <table className="w-full min-w-[46rem] text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface-hi/95 backdrop-blur-sm">
              <tr className="border-b border-white/10">
                <th className="label-caps px-3 py-2 font-medium">Core</th>
                <th className="label-caps px-3 py-2 text-right font-medium">Flights</th>
                <th className="label-caps px-3 py-2 font-medium">Last flown</th>
                <th className="label-caps px-3 py-2 text-right font-medium">Days since</th>
                <th className="label-caps px-3 py-2 text-right font-medium">Landings</th>
                <th className="label-caps px-3 py-2 text-right font-medium">Best turnaround</th>
                <th className="label-caps px-3 py-2 font-medium">Last landing</th>
              </tr>
            </thead>
            <tbody>
              {sortedFleet.map((row) => (
                <FleetTableRow key={row.serial} row={row} />
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-[0.65rem] leading-relaxed text-white/30">
          "Last landing" reports the outcome of the core's most recent flight as
          recorded upstream. It is not a service status — a recovered core may
          still have been retired, and the data can't distinguish that.
        </p>
      </Panel>
    </div>
  )
}

function FleetTableRow({ row }: { row: FleetRow }) {
  const lastFlownDate = new Date(row.lastFlown)
  const validDate = !Number.isNaN(lastFlownDate.getTime())

  return (
    <tr className="border-b border-white/[0.05] transition-colors last:border-0 hover:bg-white/[0.03]">
      <td className="px-3 py-2 font-mono font-semibold tnum text-white/85">
        {row.serial}
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-white/70">
        {row.maxFlightNumber || row.flights}
      </td>
      <td className="px-3 py-2 font-mono tnum text-white/60">
        {validDate ? format(lastFlownDate, 'd MMM yyyy') : '—'}
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-white/45">
        {formatInt(row.daysSinceLastFlight)}
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-emerald/80">
        {formatInt(row.landings)}
      </td>
      <td className="px-3 py-2 text-right font-mono tnum text-white/60">
        {row.fastestTurnaround != null ? `${row.fastestTurnaround}d` : '—'}
      </td>
      <td className="px-3 py-2">
        {row.lastOutcome === 'recovered' ? (
          <Badge tone="emerald">Recovered</Badge>
        ) : row.lastOutcome === 'expended' ? (
          <Badge tone="crimson">Expended</Badge>
        ) : (
          <Badge>Pending</Badge>
        )}
      </td>
    </tr>
  )
}
