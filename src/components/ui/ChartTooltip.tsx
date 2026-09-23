import { formatInt } from '../../lib/utils'

interface TooltipEntry {
  name?: string | number
  value?: number | string | Array<number | string>
  color?: string
  payload?: Record<string, unknown> & { fill?: string }
}

/**
 * Shared recharts tooltip.
 *
 * Replaces recharts' default content for two reasons:
 *
 *  1. The default derives item text colour from the series entry. Pie slices
 *     don't supply one, so donut tooltips rendered near-black on the dark
 *     panel and were unreadable. Here the text colour is set explicitly and
 *     the series colour moves to a dot, which works for every chart type.
 *  2. Stacked charts need a total. `showTotal` appends a summed row, so the
 *     launch-cadence tooltip can answer "how many launches that year" without
 *     making the reader add the segments themselves.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  showTotal = false,
  valueSuffix,
  formatValue,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  showTotal?: boolean
  valueSuffix?: string
  formatValue?: (value: number, entry: TooltipEntry) => string
}) {
  if (!active || !payload?.length) return null

  const rows = payload.filter((p) => p.value != null)
  if (rows.length === 0) return null

  const toNumber = (v: TooltipEntry['value']): number =>
    typeof v === 'number' ? v : Number(Array.isArray(v) ? v[0] : v) || 0

  const total = rows.reduce((sum, r) => sum + toNumber(r.value), 0)

  return (
    <div className="rounded-lg border border-white/15 bg-space/95 px-3 py-2 shadow-xl backdrop-blur-sm">
      {label != null && label !== '' && (
        <p className="mb-1.5 font-mono text-[0.7rem] tnum text-white/50">{label}</p>
      )}

      <ul className="space-y-1">
        {rows.map((r, i) => {
          const n = toNumber(r.value)
          return (
            <li
              key={`${r.name}-${i}`}
              className="flex items-center justify-between gap-4 text-xs"
            >
              <span className="flex items-center gap-1.5 text-white/70">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  // Pie entries carry their colour on payload.fill rather
                  // than entry.color.
                  style={{ background: r.color ?? r.payload?.fill ?? '#94a3b8' }}
                />
                {r.name}
              </span>
              <span className="font-mono tnum font-semibold text-white">
                {formatValue ? formatValue(n, r) : formatInt(n)}
                {valueSuffix && (
                  <span className="ml-1 font-normal text-white/40">{valueSuffix}</span>
                )}
              </span>
            </li>
          )
        })}
      </ul>

      {showTotal && rows.length > 1 && (
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-white/10 pt-1.5 text-xs">
          <span className="font-semibold text-white/60">Total</span>
          <span className="font-mono tnum font-bold text-accent">
            {formatInt(total)}
            {valueSuffix && (
              <span className="ml-1 font-normal text-white/40">{valueSuffix}</span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
