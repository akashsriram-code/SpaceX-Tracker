/**
 * KPI and chart aggregation for the Starlink tab. Pure functions over decoded
 * satellites — no fetching, no React — mirroring stats.ts for launches.
 *
 * Every function that involves time takes `asOf` (the snapshot's
 * generatedAt) instead of reading the clock, so the tab, the export and the
 * audit all agree on ages and "current" counts.
 */

import {
  FAMILY_ORDER,
  PHASE_COLORS,
  PHASE_ORDER,
  VERSION_ORDER,
  ageDays,
  daysBetween,
  displayName,
  isDecaying,
  isDirectToCell,
  isInOrbit,
  isOperationalShell,
  isOrbitStale,
  isUncatalogued,
  isWorking,
  launchFor,
  launchGroup,
  launchYearOf,
  lifecyclePhase,
  lifetimeDays,
  meanAltitudeKm,
  orbitOf,
  reentryCause,
  shellOf,
  starlinkVersion,
  versionFamily,
  type LaunchIndex,
  type LifecyclePhase,
  type ReentryCause,
  type StarlinkVersion,
  type VersionFamily,
} from './starlink'
import type { Launch, Satellite, StarlinkHistoryFile, StarlinkMeta } from './types'

/* -------------------------------- helpers --------------------------------- */

/** Linear-interpolated quantile of an ascending array; null when empty. */
function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const ascending = (xs: number[]) => [...xs].sort((a, b) => a - b)

/** Versions that actually occur, in chronological order — so charts don't list empty series. */
export function versionsPresent(sats: Satellite[]): StarlinkVersion[] {
  const seen = new Set(sats.map(starlinkVersion))
  return VERSION_ORDER.filter((v) => seen.has(v))
}

function emptyVersionCounts(): Record<StarlinkVersion, number> {
  return Object.fromEntries(VERSION_ORDER.map((v) => [v, 0])) as Record<StarlinkVersion, number>
}

/* ---------------------------------- KPIs ---------------------------------- */

export interface StarlinkKpis {
  launched: number
  inOrbit: number
  working: number
  operational: number
  reentered: number
  /** In orbit and coming down: controlled lowering or uncontrolled decay. */
  decaying: number
  medianAgeDays: number | null
  /** Median mean altitude of in-orbit satellites with a fresh orbit. */
  medianAltitudeKm: number | null
  /** Sum of GCAT mass estimates for satellites in orbit, tonnes. */
  massOnOrbitT: number
  dtcInOrbit: number
  v3InOrbit: number
  /** In orbit with an orbit older than STALE_ORBIT_DAYS, or none at all. */
  staleOrbits: number
  uncatalogued: number
}

export function computeStarlinkKpis(sats: Satellite[], asOf: string): StarlinkKpis {
  let inOrbit = 0
  let working = 0
  let operational = 0
  let decaying = 0
  let massKg = 0
  let dtc = 0
  let v3 = 0
  let stale = 0
  let uncatalogued = 0
  const ages: number[] = []
  const alts: number[] = []

  for (const s of sats) {
    if (isUncatalogued(s)) uncatalogued += 1
    if (!isInOrbit(s)) continue
    inOrbit += 1
    if (isWorking(s)) working += 1
    if (isOperationalShell(s)) operational += 1
    if (isDecaying(s)) decaying += 1
    if (s.massKg != null) massKg += s.massKg
    if (isDirectToCell(s)) dtc += 1
    if (starlinkVersion(s) === 'V3') v3 += 1
    const age = ageDays(s, asOf)
    if (age != null) ages.push(age)
    const alt = meanAltitudeKm(s)
    if (alt == null || isOrbitStale(s, asOf)) stale += 1
    else alts.push(alt)
  }

  return {
    launched: sats.length,
    inOrbit,
    working,
    operational,
    reentered: sats.length - inOrbit,
    decaying,
    medianAgeDays: quantile(ascending(ages), 0.5),
    medianAltitudeKm: quantile(ascending(alts), 0.5),
    massOnOrbitT: massKg / 1000,
    dtcInOrbit: dtc,
    v3InOrbit: v3,
    staleOrbits: stale,
    uncatalogued,
  }
}

/** Our count minus McDowell's published one, for the reconciliation line. */
export function referenceDelta(kpis: StarlinkKpis, meta: StarlinkMeta) {
  const t = meta.reference?.total
  if (!t) return null
  return {
    asOf: meta.reference?.asOf ?? null,
    launched: { ours: kpis.launched, theirs: t.launched },
    inOrbit: { ours: kpis.inOrbit, theirs: t.inOrbit },
    working: { ours: kpis.working, theirs: t.working },
    operational: { ours: kpis.operational, theirs: t.operational },
  }
}

/* ------------------------------- by version ------------------------------- */

export interface VersionRow {
  version: StarlinkVersion
  launched: number
  inOrbit: number
  working: number
  operational: number
  /** In orbit but not in the operational shell (raising, drifting, lowering, failed…). */
  otherInOrbit: number
  reentered: number
}

export function versionBreakdown(sats: Satellite[]): VersionRow[] {
  const rows = new Map<StarlinkVersion, VersionRow>()
  for (const s of sats) {
    const v = starlinkVersion(s)
    let r = rows.get(v)
    if (!r) {
      r = { version: v, launched: 0, inOrbit: 0, working: 0, operational: 0, otherInOrbit: 0, reentered: 0 }
      rows.set(v, r)
    }
    r.launched += 1
    if (isInOrbit(s)) {
      r.inOrbit += 1
      if (isWorking(s)) r.working += 1
      if (isOperationalShell(s)) r.operational += 1
      else r.otherInOrbit += 1
    } else {
      r.reentered += 1
    }
  }
  return VERSION_ORDER.filter((v) => rows.has(v)).map((v) => rows.get(v) as VersionRow)
}

/* -------------------------------- altitude -------------------------------- */

export type VersionCountRow = { [K in StarlinkVersion]?: number } & { total: number }

export interface AltitudeBin extends VersionCountRow {
  /** Lower edge, km. */
  bin: number
  label: string
}

/**
 * In-orbit satellites with a fresh orbit, binned by mean altitude and
 * stacked by version. Range follows the data, clamped to 150–700 km so a
 * single odd orbit can't stretch the axis.
 */
export function altitudeHistogram(sats: Satellite[], asOf: string, binKm = 10): AltitudeBin[] {
  const counts = new Map<number, Record<StarlinkVersion, number>>()
  let lo = Infinity
  let hi = -Infinity
  for (const s of sats) {
    if (!isInOrbit(s) || isOrbitStale(s, asOf)) continue
    const alt = meanAltitudeKm(s)
    if (alt == null) continue
    const bin = Math.min(700, Math.max(150, Math.floor(alt / binKm) * binKm))
    lo = Math.min(lo, bin)
    hi = Math.max(hi, bin)
    const row = counts.get(bin) ?? emptyVersionCounts()
    row[starlinkVersion(s)] += 1
    counts.set(bin, row)
  }
  if (!Number.isFinite(lo)) return []
  const out: AltitudeBin[] = []
  for (let bin = lo; bin <= hi; bin += binKm) {
    const row = counts.get(bin) ?? emptyVersionCounts()
    const total = Object.values(row).reduce((a, b) => a + b, 0)
    out.push({ ...row, bin, label: `${bin}`, total })
  }
  return out
}

export interface ShellPoint {
  incDeg: number
  altitudeKm: number
  count: number
  /** Most common version in the cell, for colouring. */
  version: StarlinkVersion
  shell: string
}

/**
 * Inclination × altitude cells for a bubble chart. Plotting ~11k raw points
 * in SVG would be slow and unreadable; clustering to 0.1° × binKm keeps the
 * shells visible as distinct bubbles sized by population.
 */
export function shellGrid(sats: Satellite[], asOf: string, binKm = 10): ShellPoint[] {
  const cells = new Map<string, { inc: number; alt: number; byVersion: Record<StarlinkVersion, number>; shell: string }>()
  for (const s of sats) {
    if (!isInOrbit(s) || s.incDeg == null || isOrbitStale(s, asOf)) continue
    const alt = meanAltitudeKm(s)
    if (alt == null) continue
    const inc = Math.round(s.incDeg * 10) / 10
    const altBin = Math.floor(alt / binKm) * binKm + binKm / 2
    const key = `${inc}|${altBin}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { inc, alt: altBin, byVersion: emptyVersionCounts(), shell: shellOf(s)?.label ?? 'Other' }
      cells.set(key, cell)
    }
    cell.byVersion[starlinkVersion(s)] += 1
  }
  return [...cells.values()].map((c) => {
    const entries = Object.entries(c.byVersion) as [StarlinkVersion, number][]
    const [version] = entries.reduce((best, e) => (e[1] > best[1] ? e : best))
    const count = entries.reduce((n, [, k]) => n + k, 0)
    return { incDeg: c.inc, altitudeKm: c.alt, count, version, shell: c.shell }
  })
}

/* --------------------------------- phases --------------------------------- */

export interface PhaseRow {
  phase: LifecyclePhase
  count: number
  color: string
}

export function phaseMix(sats: Satellite[]): PhaseRow[] {
  const counts = new Map<LifecyclePhase, number>()
  for (const s of sats) {
    if (!isInOrbit(s)) continue
    const p = lifecyclePhase(s)
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return PHASE_ORDER.filter((p) => counts.has(p)).map((phase) => ({
    phase,
    count: counts.get(phase) as number,
    color: PHASE_COLORS[phase],
  }))
}

/* ------------------------------ time series ------------------------------- */

export type Granularity = 'year' | 'quarter'

export interface PeriodVersionRow extends VersionCountRow {
  period: string
}

function periodOf(date: string, g: Granularity): string {
  const y = date.slice(0, 4)
  if (g === 'year') return y
  const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1
  return `${y} Q${q}`
}

/** Satellites launched per year (or quarter), stacked by version. Includes launch failures. */
export function launchedPerPeriod(sats: Satellite[], g: Granularity): PeriodVersionRow[] {
  const rows = new Map<string, PeriodVersionRow>()
  for (const s of sats) {
    if (!s.launchDate) continue
    const period = periodOf(s.launchDate, g)
    const row = rows.get(period) ?? { period, total: 0 }
    const v = starlinkVersion(s)
    row[v] = (row[v] ?? 0) + 1
    row.total += 1
    rows.set(period, row)
  }
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period))
}

export type ReentryGranularity = 'year' | 'month'

export type PeriodCauseRow = { [K in ReentryCause]?: number } & { period: string; total: number }

/**
 * Reentries per month (the last `months`, up to asOf, zero-filled) or per
 * year, stacked by cause.
 */
export function reentriesPerPeriod(
  sats: Satellite[],
  g: ReentryGranularity,
  asOf: string,
  months = 36,
): PeriodCauseRow[] {
  const rows = new Map<string, PeriodCauseRow>()
  for (const s of sats) {
    const cause = reentryCause(s)
    if (!cause || !s.decayDate) continue
    const period = g === 'year' ? s.decayDate.slice(0, 4) : s.decayDate.slice(0, 7)
    const row = rows.get(period) ?? { period, total: 0 }
    row[cause] = (row[cause] ?? 0) + 1
    row.total += 1
    rows.set(period, row)
  }
  if (g === 'year') return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period))

  const out: PeriodCauseRow[] = []
  const end = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`)
  // No usable snapshot time (e.g. the render before data arrives): an
  // invalid Date would throw in toISOString() below and take the page down.
  if (Number.isNaN(end.getTime())) return []
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1))
    const period = d.toISOString().slice(0, 7)
    out.push(rows.get(period) ?? { period, total: 0 })
  }
  return out
}

export interface GrowthRow {
  month: string
  launched: number
  inOrbit: number
  reentered: number
}

/** Cumulative launched / reentered / in-orbit at the end of each month, first launch to asOf. */
export function constellationGrowth(sats: Satellite[], asOf: string): GrowthRow[] {
  const launchedBy = new Map<string, number>()
  const downBy = new Map<string, number>()
  let first: string | null = null
  for (const s of sats) {
    if (!s.launchDate) continue
    const m = s.launchDate.slice(0, 7)
    launchedBy.set(m, (launchedBy.get(m) ?? 0) + 1)
    if (!first || m < first) first = m
    if (s.decayDate) {
      const dm = s.decayDate.slice(0, 7)
      downBy.set(dm, (downBy.get(dm) ?? 0) + 1)
    }
  }
  if (!first) return []

  const out: GrowthRow[] = []
  let launched = 0
  let reentered = 0
  const last = asOf.slice(0, 7)
  for (let d = new Date(`${first}-01T00:00:00Z`); ; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const month = d.toISOString().slice(0, 7)
    launched += launchedBy.get(month) ?? 0
    reentered += downBy.get(month) ?? 0
    out.push({ month, launched, inOrbit: launched - reentered, reentered })
    if (month >= last) break
  }
  return out
}

/* ----------------------------------- age ---------------------------------- */

export interface AgeBin extends VersionCountRow {
  label: string
}

/** Age distribution of satellites in orbit, in `binMonths`-month bins, stacked by version. */
export function ageHistogram(sats: Satellite[], asOf: string, binMonths = 6): AgeBin[] {
  const binDays = binMonths * 30.44
  const bins: AgeBin[] = []
  for (const s of sats) {
    if (!isInOrbit(s)) continue
    const age = ageDays(s, asOf)
    if (age == null) continue
    const i = Math.floor(age / binDays)
    while (bins.length <= i) {
      const k = bins.length
      bins.push({ label: `${k * binMonths}–${(k + 1) * binMonths} mo`, total: 0 })
    }
    const v = starlinkVersion(s)
    bins[i][v] = (bins[i][v] ?? 0) + 1
    bins[i].total += 1
  }
  return bins
}

/* -------------------------------- lifetime -------------------------------- */

export interface LifetimeRow {
  version: StarlinkVersion
  /** Reentered satellites that reached orbit. */
  samples: number
  medianYears: number | null
  p25Years: number | null
  p75Years: number | null
}

/**
 * Time from launch to reentry for satellites that are down, by version.
 * Launch failures are excluded (they never had a lifetime). Biased short for
 * young versions — only their early failures have come down yet — which is
 * why the survival curve exists alongside it.
 */
export function lifetimeByVersion(sats: Satellite[]): LifetimeRow[] {
  const byVersion = new Map<StarlinkVersion, number[]>()
  for (const s of sats) {
    if (reentryCause(s) === 'Failed to orbit') continue
    const life = lifetimeDays(s)
    if (life == null) continue
    const v = starlinkVersion(s)
    byVersion.set(v, [...(byVersion.get(v) ?? []), life / 365.25])
  }
  return VERSION_ORDER.filter((v) => byVersion.has(v)).map((v) => {
    const xs = ascending(byVersion.get(v) as number[])
    return {
      version: v,
      samples: xs.length,
      medianYears: quantile(xs, 0.5),
      p25Years: quantile(xs, 0.25),
      p75Years: quantile(xs, 0.75),
    }
  })
}

export type SurvivalRow = { [K in VersionFamily]?: number | null } & { day: number; years: number }

/**
 * Kaplan–Meier probability of still being in orbit N days after launch, per
 * hardware family. Satellites still up are right-censored at asOf; the event
 * is reentry (deliberate disposal included — this is orbital survival, not
 * hardware reliability). Launch failures are excluded. Each family's curve
 * stops once fewer than `minAtRisk` satellites remain, where the estimate
 * gets too noisy to read.
 */
export function survivalCurve(sats: Satellite[], asOf: string, stepDays = 30, minAtRisk = 25): SurvivalRow[] {
  const byFamily = new Map<VersionFamily, Array<{ t: number; event: boolean }>>()
  let maxT = 0
  for (const s of sats) {
    if (!s.launchDate || reentryCause(s) === 'Failed to orbit') continue
    const fam = versionFamily(starlinkVersion(s))
    if (fam === 'Prototype' || fam === 'Unclassified') continue
    const t = s.decayDate ? daysBetween(s.launchDate, s.decayDate) : daysBetween(s.launchDate, asOf)
    if (t < 0) continue
    maxT = Math.max(maxT, t)
    byFamily.set(fam, [...(byFamily.get(fam) ?? []), { t, event: s.decayDate != null }])
  }

  // Step function per family: [time, S(t), atRisk after t].
  const steps = new Map<VersionFamily, Array<[number, number, number]>>()
  for (const [fam, obs] of byFamily) {
    obs.sort((a, b) => a.t - b.t)
    let atRisk = obs.length
    let surv = 1
    const out: Array<[number, number, number]> = [[0, 1, atRisk]]
    for (let i = 0; i < obs.length; ) {
      const t = obs[i].t
      let d = 0
      let c = 0
      while (i < obs.length && obs[i].t === t) {
        if (obs[i].event) d += 1
        else c += 1
        i += 1
      }
      if (d > 0) surv *= 1 - d / atRisk
      atRisk -= d + c
      out.push([t, surv, atRisk])
    }
    steps.set(fam, out)
  }

  const rows: SurvivalRow[] = []
  for (let day = 0; day <= maxT; day += stepDays) {
    const row: SurvivalRow = { day, years: Math.round((day / 365.25) * 10) / 10 }
    for (const fam of FAMILY_ORDER) {
      const st = steps.get(fam)
      if (!st) continue
      let k = 0
      while (k + 1 < st.length && st[k + 1][0] <= day) k += 1
      // Stop the curve where the at-risk set has thinned out.
      row[fam] = st[k][2] >= minAtRisk ? Math.round(st[k][1] * 1000) / 1000 : null
    }
    rows.push(row)
  }
  return rows
}

/* ---------------------------- per-launch health --------------------------- */

export interface LaunchHealthRow {
  launchTag: string
  group: string | null
  date: string | null
  version: StarlinkVersion
  deployed: number
  inOrbit: number
  working: number
  operational: number
  reentered: number
  launch: Launch | null
}

/** One row per launch: how its batch has fared. Newest first. */
export function perLaunchHealth(sats: Satellite[], index: LaunchIndex): LaunchHealthRow[] {
  const rows = new Map<string, LaunchHealthRow & { versions: Map<StarlinkVersion, number> }>()
  for (const s of sats) {
    const tag = s.launchTag ?? s.piece?.slice(0, 8) ?? s.jcat
    let r = rows.get(tag)
    if (!r) {
      r = {
        launchTag: tag,
        group: launchGroup(s),
        date: s.launchDate,
        version: 'Unclassified',
        deployed: 0,
        inOrbit: 0,
        working: 0,
        operational: 0,
        reentered: 0,
        launch: launchFor(s, index),
        versions: new Map(),
      }
      rows.set(tag, r)
    }
    r.deployed += 1
    if (isInOrbit(s)) {
      r.inOrbit += 1
      if (isWorking(s)) r.working += 1
      if (isOperationalShell(s)) r.operational += 1
    } else r.reentered += 1
    const v = starlinkVersion(s)
    r.versions.set(v, (r.versions.get(v) ?? 0) + 1)
  }
  return [...rows.values()]
    .map(({ versions, ...r }) => ({
      ...r,
      version: [...versions].reduce((best, e) => (e[1] > best[1] ? e : best))[0],
    }))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.launchTag.localeCompare(a.launchTag))
}

/* ---------------------------- table filter/sort --------------------------- */

export type SatelliteStatusFilter = '' | 'inOrbit' | 'operational' | 'decaying' | 'reentered'

export interface SatelliteQuery {
  search: string
  version: StarlinkVersion | ''
  status: SatelliteStatusFilter
  shell: string
}

export type SatelliteSort = 'newest' | 'oldest' | 'altitude' | 'norad'

/** Free-text match on name, NORAD, COSPAR id and launch group, plus the three selects. */
export function filterSatellites(sats: Satellite[], q: SatelliteQuery): Satellite[] {
  const needle = q.search.trim().toLowerCase()
  return sats.filter((s) => {
    if (q.version && starlinkVersion(s) !== q.version) return false
    if (q.status === 'inOrbit' && !isInOrbit(s)) return false
    if (q.status === 'operational' && !isOperationalShell(s)) return false
    if (q.status === 'decaying' && !isDecaying(s)) return false
    if (q.status === 'reentered' && isInOrbit(s)) return false
    if (q.shell && shellOf(s)?.id !== q.shell) return false
    if (!needle) return true
    return [displayName(s), s.name, s.norad?.toString(), s.piece, s.plName, launchGroup(s), s.jcat].some(
      (f) => f != null && f.toLowerCase().includes(needle),
    )
  })
}

export function sortSatellites(sats: Satellite[], sort: SatelliteSort): Satellite[] {
  const list = [...sats]
  switch (sort) {
    case 'newest':
      return list.sort((a, b) => (b.launchDate ?? '').localeCompare(a.launchDate ?? '') || (b.norad ?? 0) - (a.norad ?? 0))
    case 'oldest':
      return list.sort((a, b) => (a.launchDate ?? '').localeCompare(b.launchDate ?? '') || (a.norad ?? 0) - (b.norad ?? 0))
    case 'altitude':
      // Highest first; satellites without an orbit (reentered) sink to the bottom.
      return list.sort((a, b) => (orbitOf(b)?.meanKm ?? -1) - (orbitOf(a)?.meanKm ?? -1))
    case 'norad':
      return list.sort((a, b) => (a.norad ?? Infinity) - (b.norad ?? Infinity))
  }
}

/* --------------------------------- history -------------------------------- */

export type HistoryRow = Record<string, number | string> & { date: string }

/** McDowell's log.dat weekly sample as objects keyed by its column letters. */
export function decodeHistory(file: StarlinkHistoryFile): HistoryRow[] {
  if (file?.v !== 1) throw new Error(`Unsupported starlink-history.json version: ${String(file?.v)}`)
  return file.rows.map((row) => {
    const out: HistoryRow = { date: row[0] }
    file.fields.forEach((f, i) => {
      if (i > 0) out[f] = row[i]
    })
    return out
  })
}

/** Launch years present, newest first, for any year-scoped control. */
export function launchYears(sats: Satellite[]): number[] {
  return [...new Set(sats.map(launchYearOf).filter((y): y is number => y != null))].sort((a, b) => b - a)
}
