/**
 * Launch-vehicle colour encoding.
 *
 * Single source of truth so the card spine, the vehicle legend and the
 * "Vehicle mix" chart all agree — a colour that means Falcon Heavy in one
 * place and something else in another is worse than no colour at all.
 *
 * Hues are drawn from the same family as the chart palette in
 * components/Analytics.tsx and stay distinguishable by lightness as well as
 * hue, so they survive greyscale and common colour-vision deficiencies.
 */

export const VEHICLE_COLORS: Record<string, string> = {
  'Falcon 9': '#38bdf8', // accent blue — the workhorse (802 flights)
  'Falcon Heavy': '#f59e0b', // amber
  Starship: '#a78bfa', // violet
  'Starship Prototype': '#f472b6', // pink
  'Falcon 1': '#64748b', // slate — historic
}

/** Fallback for any vehicle LL2 adds that we haven't assigned a colour. */
export const VEHICLE_FALLBACK_COLOR = '#94a3b8'

export function vehicleColor(rocketName: string | null | undefined): string {
  if (!rocketName) return VEHICLE_FALLBACK_COLOR
  return VEHICLE_COLORS[rocketName] ?? VEHICLE_FALLBACK_COLOR
}

/**
 * Vehicles present in a dataset, ordered by flight count, for the legend.
 * Derived from the data rather than hardcoded so the legend never advertises
 * a vehicle that isn't on screen.
 */
export function vehiclesInUse(
  rocketNames: Array<string | null>,
): Array<{ name: string; color: string; count: number }> {
  const counts = new Map<string, number>()
  for (const n of rocketNames) {
    if (!n) continue
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, color: vehicleColor(name), count }))
}
