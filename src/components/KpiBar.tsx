import {
  ArrowRight,
  CheckCircle2,
  RefreshCw,
  Rocket,
  Satellite,
  type LucideIcon,
} from 'lucide-react'
import type { Kpis } from '../lib/stats'
import { cn, formatInt, formatPct } from '../lib/utils'

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
  onClick,
  actionLabel,
}: {
  icon: LucideIcon
  label: string
  value: string
  sub: string
  tone: 'accent' | 'emerald' | 'amber' | 'violet'
  /** When set the tile becomes a button that deep-links to a chart. */
  onClick?: () => void
  actionLabel?: string
}) {
  const toneClasses = {
    accent: 'text-accent',
    emerald: 'text-emerald',
    amber: 'text-amber',
    violet: 'text-violet',
  }[tone]

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="label-caps">{label}</span>
        <Icon className={cn('size-4 shrink-0', toneClasses)} aria-hidden />
      </div>
      <p
        className={cn(
          'mt-3 font-mono text-2xl font-bold tnum sm:text-3xl',
          toneClasses,
        )}
      >
        {value}
      </p>
      <p className="mt-1 text-[0.7rem] leading-snug text-white/40">{sub}</p>
    </>
  )

  if (!onClick) {
    return <div className="panel panel-hover p-4 sm:p-5">{body}</div>
  }

  return (
    <button
      onClick={onClick}
      aria-label={actionLabel ?? `${label}: ${value}`}
      className="panel panel-hover group cursor-pointer p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 sm:p-5"
    >
      {body}
      <span
        className={cn(
          'mt-2 flex items-center gap-1 text-[0.65rem] font-medium opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
          toneClasses,
        )}
      >
        {actionLabel ?? 'View chart'}
        <ArrowRight className="size-3" aria-hidden />
      </span>
    </button>
  )
}

export function KpiBar({
  kpis,
  onShowStarlinkChart,
}: {
  kpis: Kpis
  onShowStarlinkChart?: () => void
}) {
  const starlinkPct =
    kpis.starlinkShare != null ? formatPct(kpis.starlinkShare, 0) : '—'

  return (
    <section
      aria-label="Program telemetry summary"
      className="grid grid-cols-2 gap-3 lg:grid-cols-4"
    >
      <KpiCard
        icon={Rocket}
        tone="accent"
        label="Total Launches"
        value={formatInt(kpis.totalLaunches)}
        sub={`${formatInt(kpis.concludedLaunches)} flown · ${formatInt(kpis.upcomingCount)} scheduled`}
      />
      <KpiCard
        icon={CheckCircle2}
        tone="emerald"
        label="Success Rate"
        value={kpis.successRate != null ? formatPct(kpis.successRate) : '—'}
        sub={`${formatInt(kpis.successes)} success · ${formatInt(kpis.failures + kpis.partialFailures)} anomaly`}
      />
      <KpiCard
        icon={RefreshCw}
        tone="amber"
        label="Booster Landings"
        value={formatInt(kpis.landingSuccesses)}
        sub={`${kpis.landingRate != null ? formatPct(kpis.landingRate, 0) : '—'} of ${formatInt(kpis.landingAttempts)} attempts · ${formatInt(kpis.distinctBoosters)} cores`}
      />
      <KpiCard
        icon={Satellite}
        tone="violet"
        label="Starlink Share"
        value={starlinkPct}
        sub={`${formatInt(kpis.starlinkLaunches)} Starlink · ${formatInt(kpis.customerLaunches)} customer`}
        onClick={onShowStarlinkChart}
        actionLabel="See yearly split"
      />
    </section>
  )
}
