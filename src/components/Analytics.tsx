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
import { formatInt } from '../lib/utils'

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

const tooltipStyle = {
  contentStyle: {
    background: '#131720',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 10,
    fontSize: 12,
  },
  labelStyle: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
  itemStyle: { fontSize: 12 },
} as const

function Panel({
  title,
  subtitle,
  children,
  height = 300,
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

export function Analytics({ launches }: { launches: Launch[] }) {
  const cadence = computeCadence(launches)
  const segments = computeCustomerSegments(launches)
  const pads = computePadUtilization(launches)
  const rockets = computeRocketUsage(launches)
  const reuse = computeReuseHistogram(launches)

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
          title="Launch cadence by year"
          subtitle="Starlink vs. customer & science missions. Current and future years are partial."
          height={320}
        >
          <BarChart data={cadence} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="year" tick={AXIS} axisLine={false} tickLine={false} />
            <YAxis tick={AXIS} axisLine={false} tickLine={false} />
            <Tooltip {...tooltipStyle} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
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
          <Tooltip {...tooltipStyle} formatter={(v: number) => [formatInt(v), 'launches']} />
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
        title="Booster reuse curve"
        subtitle="How many flights were a given core's Nth flight."
      >
        <BarChart data={reuse} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
          <XAxis dataKey="flight" tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} />
          <Tooltip
            {...tooltipStyle}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            formatter={(v: number) => [formatInt(v), 'flights']}
          />
          <Bar dataKey="count" fill="#f59e0b" radius={[3, 3, 0, 0]} />
        </BarChart>
      </Panel>

      <Panel
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
          <Tooltip
            {...tooltipStyle}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            formatter={(v: number) => [formatInt(v), 'launches']}
          />
          <Bar dataKey="count" fill="#38bdf8" radius={[0, 3, 3, 0]} />
        </BarChart>
      </Panel>

      <Panel title="Vehicle mix" subtitle="Flights per launch vehicle." height={280}>
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
          <Tooltip
            {...tooltipStyle}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            formatter={(v: number) => [formatInt(v), 'launches']}
          />
          <Bar dataKey="count" fill="#10b981" radius={[0, 3, 3, 0]} />
        </BarChart>
      </Panel>
    </div>
  )
}
