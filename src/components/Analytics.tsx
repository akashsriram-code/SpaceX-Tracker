import { useEffect } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  computeCadence,
  computeCustomerSegments,
  computePadUtilization,
  computeReuseHistogram,
  computeRocketUsage,
} from '../lib/stats'
import type { Launch } from '../lib/types'
import { cn } from '../lib/utils'
import { vehicleColor } from '../lib/vehicles'
import { ChartTooltip } from './ui/ChartTooltip'

/**
 * Categorical palette. Ordered so adjacent series stay distinguishable in
 * both hue and lightness (important for the pie, and for anyone with a
 * colour-vision deficiency reading the bars).
 */
const SERIES = {
  starlink: '#a78bfa',
  customer: '#38bdf8',
}

const SEGMENT_COLORS = [
  '#a78bfa', // Starlink
  '#38bdf8', // NASA
  '#f59e0b', // US Military
  '#10b981', // Commercial
  '#f472b6', // International / Government
  '#64748b', // SpaceX Internal
]

const AXIS = {
  stroke: 'rgba(255,255,255,0.25)',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
}

const CURSOR = { fill: 'rgba(255,255,255,0.04)' }

function Panel({
  id,
  title,
  subtitle,
  children,
  height = 300,
  focused = false,
}: {
  id?: string
  title: string
  subtitle?: string
  children: React.ReactNode
  height?: number
  focused?: boolean
}) {
  return (
    <section
      id={id}
      className={cn(
        'panel scroll-mt-6 p-4 transition-shadow duration-500 sm:p-5',
        // Brief ring so a deep-link from a KPI card makes it obvious which
        // chart answered the click.
        focused && 'ring-2 ring-accent/60',
      )}
    >
      <header className="mb-4">
        <h3 className="text-sm font-semibold text-white/85">{title}</h3>
        {subtitle && (
          <p className="mt-0.5 text-[0.7rem] text-white/40">{subtitle}</p>
        )}
      </header>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </section>
  )
}

export function Analytics({
  launches,
  focusChart,
  onFocusHandled,
}: {
  launches: Launch[]
  /** DOM id of a chart to scroll to on mount (set by a KPI deep-link). */
  focusChart?: string | null
  onFocusHandled?: () => void
}) {
  const cadence = computeCadence(launches)
  const segments = computeCustomerSegments(launches)
  const pads = computePadUtilization(launches)
  const rockets = computeRocketUsage(launches)
  const reuse = computeReuseHistogram(launches)

  // This component is lazy-loaded, so the scroll has to happen here on mount
  // rather than in App — from there it would fire before the chunk renders
  // and there would be nothing to scroll to.
  useEffect(() => {
    if (!focusChart) return
    const el = document.getElementById(focusChart)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    // Long enough for the smooth scroll to land and the ring to register as
    // a deliberate "this is the chart you asked for" cue.
    const timer = window.setTimeout(() => onFocusHandled?.(), 2600)
    return () => window.clearTimeout(timer)
  }, [focusChart, onFocusHandled])

  if (launches.length === 0) {
    return (
      <div className="panel px-6 py-16 text-center text-sm text-white/45">
        No launches in scope — widen the mission filter to see analytics.
      </div>
    )
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <Panel
          id="chart-cadence"
          focused={focusChart === 'chart-cadence'}
          title="Launch cadence by year"
          subtitle="Starlink vs. customer & science missions. Hover a bar for the yearly total. Current and future years are partial."
          height={320}
        >
          <BarChart data={cadence} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="year" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={CURSOR}
              content={<ChartTooltip showTotal valueSuffix="launches" />}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              iconType="circle"
              iconSize={8}
            />
            <Bar
              dataKey="customer"
              name="Customer & science"
              stackId="a"
              fill={SERIES.customer}
              radius={[0, 0, 0, 0]}
            />
            <Bar
              dataKey="starlink"
              name="Starlink"
              stackId="a"
              fill={SERIES.starlink}
              radius={[3, 3, 0, 0]}
            />
          </BarChart>
        </Panel>
      </div>

      <Panel
        id="chart-customers"
        focused={focusChart === 'chart-customers'}
        title="Customer breakdown"
        subtitle="Derived segments — see a mission's detail panel for its attribution."
      >
        <PieChart>
          <Pie
            data={segments}
            dataKey="count"
            nameKey="segment"
            innerRadius="45%"
            outerRadius="72%"
            paddingAngle={2}
            stroke="#0e1117"
            strokeWidth={2}
          >
            {segments.map((_, i) => (
              <Cell key={i} fill={SEGMENT_COLORS[i % SEGMENT_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip valueSuffix="launches" />} />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            iconType="circle"
            iconSize={8}
            layout="horizontal"
            verticalAlign="bottom"
          />
        </PieChart>
      </Panel>

      <Panel
        id="chart-reuse"
        focused={focusChart === 'chart-reuse'}
        title="Booster reuse curve"
        subtitle="How many flights were a given core's Nth flight. See the Boosters tab for per-core detail."
      >
        <BarChart data={reuse} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="flight" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} />
          <Tooltip cursor={CURSOR} content={<ChartTooltip valueSuffix="flights" />} />
          <Bar dataKey="count" name="Flights" fill="#f59e0b" radius={[3, 3, 0, 0]} />
        </BarChart>
      </Panel>

      <Panel
        id="chart-pads"
        focused={focusChart === 'chart-pads'}
        title="Launch site utilisation"
        subtitle="Flights per pad."
        height={280}
      >
        <BarChart
          data={pads}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        >
          <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
          <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="pad"
            tick={{ ...AXIS, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={150}
          />
          <Tooltip cursor={CURSOR} content={<ChartTooltip valueSuffix="launches" />} />
          <Bar dataKey="count" name="Launches" fill="#38bdf8" radius={[0, 3, 3, 0]} />
        </BarChart>
      </Panel>

      <Panel
        id="chart-vehicles"
        focused={focusChart === 'chart-vehicles'}
        title="Vehicle mix"
        subtitle="Flights per launch vehicle. Colours match the card spines in the mission list."
        height={280}
      >
        <BarChart
          data={rockets}
          layout="vertical"
          margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
        >
          <CartesianGrid stroke="rgba(255,255,255,0.06)" horizontal={false} />
          <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="rocket"
            tick={{ ...AXIS, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            width={150}
          />
          <Tooltip cursor={CURSOR} content={<ChartTooltip valueSuffix="launches" />} />
          {/* Per-vehicle colour, shared with the launch-card spines. */}
          <Bar dataKey="count" name="Launches" radius={[0, 3, 3, 0]}>
            {rockets.map((r) => (
              <Cell key={r.rocket} fill={vehicleColor(r.rocket)} />
            ))}
          </Bar>
        </BarChart>
      </Panel>
    </div>
  )
}
