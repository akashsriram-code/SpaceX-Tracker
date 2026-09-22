/**
 * KPI and analytics aggregation. Pure functions over the normalized
 * snapshot — no fetching, no React — so they're cheap to memoize and easy
 * to reason about.
 */

import {
  customerSegment,
  isConcluded,
  isStarlinkMission,
  isUpcoming,
  landingAttempted,
  launchYear,
  outcomeOf,
  type CustomerSegment,
} from './launch'
import type { Launch } from './types'

export interface Kpis {
  totalLaunches: number
  concludedLaunches: number
  successes: number
  failures: number
  partialFailures: number
  /** Successes / concluded launches. Null when nothing has concluded yet. */
  successRate: number | null

  landingAttempts: number
  landingSuccesses: number
  landingRate: number | null
  /** Flights that flew on an already-used booster. */
  reflights: number
  /** Distinct boosters seen in the dataset. */
  distinctBoosters: number

  starlinkLaunches: number
  customerLaunches: number
  /** Starlink share of all launches, 0..1. */
  starlinkShare: number | null

  upcomingCount: number
}

export function computeKpis(launches: Launch[]): Kpis {
  let concluded = 0
  let successes = 0
  let failures = 0
  let partial = 0
  let landingAttempts = 0
  let landingSuccesses = 0
  let reflights = 0
  let starlink = 0
  let upcoming = 0
  const boosterSerials = new Set<string>()

  for (const l of launches) {
    if (isConcluded(l)) {
      concluded += 1
      const o = outcomeOf(l)
      if (o === 'success') successes += 1
      else if (o === 'failure') failures += 1
      else if (o === 'partial') partial += 1
    }
    if (isUpcoming(l)) upcoming += 1
    if (isStarlinkMission(l)) starlink += 1

    // Count landings per booster, not per launch — Falcon Heavy attempts
    // three at once, and collapsing them would understate the programme.
    for (const b of l.boosters) {
      if (b.serial) boosterSerials.add(b.serial)
      if (b.landingAttempt === true) landingAttempts += 1
      if (b.landingSuccess === true) landingSuccesses += 1
    }
    if (l.boosters.some((b) => b.reused === true)) reflights += 1
    // `landingAttempted` kept for symmetry with card-level display logic.
    void landingAttempted
  }

  return {
    totalLaunches: launches.length,
    concludedLaunches: concluded,
    successes,
    failures,
    partialFailures: partial,
    successRate: concluded > 0 ? successes / concluded : null,

    landingAttempts,
    landingSuccesses,
    landingRate: landingAttempts > 0 ? landingSuccesses / landingAttempts : null,
    reflights,
    distinctBoosters: boosterSerials.size,

    starlinkLaunches: starlink,
    customerLaunches: launches.length - starlink,
    starlinkShare: launches.length > 0 ? starlink / launches.length : null,

    upcomingCount: upcoming,
  }
}

/* ------------------------------ cadence ----------------------------------- */

export interface CadenceRow {
  year: number
  starlink: number
  customer: number
  total: number
}

/** Launches per year, split Starlink vs. everything else. */
export function computeCadence(launches: Launch[]): CadenceRow[] {
  const byYear = new Map<number, CadenceRow>()

  for (const l of launches) {
    const y = launchYear(l)
    if (y == null) continue
    let row = byYear.get(y)
    if (!row) {
      row = { year: y, starlink: 0, customer: 0, total: 0 }
      byYear.set(y, row)
    }
    if (isStarlinkMission(l)) row.starlink += 1
    else row.customer += 1
    row.total += 1
  }

  return [...byYear.values()].sort((a, b) => a.year - b.year)
}

/* ------------------------------ customers --------------------------------- */

export interface SegmentRow {
  segment: CustomerSegment
  count: number
}

export function computeCustomerSegments(launches: Launch[]): SegmentRow[] {
  const counts = new Map<CustomerSegment, number>()
  for (const l of launches) {
    const seg = customerSegment(l)
    counts.set(seg, (counts.get(seg) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([segment, count]) => ({ segment, count }))
    .sort((a, b) => b.count - a.count)
}

/* ------------------------------ launch sites ------------------------------ */

export interface PadRow {
  pad: string
  location: string
  count: number
}

export function computePadUtilization(launches: Launch[]): PadRow[] {
  const counts = new Map<string, PadRow>()
  for (const l of launches) {
    const pad = l.padName ?? 'Unknown pad'
    const key = `${pad}|${l.padLocation ?? ''}`
    let row = counts.get(key)
    if (!row) {
      row = { pad, location: l.padLocation ?? '—', count: 0 }
      counts.set(key, row)
    }
    row.count += 1
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

/* ------------------------------ rockets ----------------------------------- */

export interface RocketRow {
  rocket: string
  count: number
}

export function computeRocketUsage(launches: Launch[]): RocketRow[] {
  const counts = new Map<string, number>()
  for (const l of launches) {
    const r = l.rocketName ?? 'Unknown'
    counts.set(r, (counts.get(r) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([rocket, count]) => ({ rocket, count }))
    .sort((a, b) => b.count - a.count)
}

/* ------------------------------ booster reuse ----------------------------- */

export interface ReuseRow {
  /** Flight index for a single core: 1 = first flight, 2 = second, … */
  flight: string
  count: number
}

/**
 * Distribution of booster flight numbers — how many flights were a core's
 * 1st, 2nd, 3rd, … Nth. Shows the reuse curve rather than a single average.
 */
export function computeReuseHistogram(launches: Launch[]): ReuseRow[] {
  const counts = new Map<number, number>()
  for (const l of launches) {
    for (const b of l.boosters) {
      if (b.flightNumber == null || b.flightNumber < 1) continue
      counts.set(b.flightNumber, (counts.get(b.flightNumber) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([flight, count]) => ({ flight: `F${flight}`, count }))
}

/* ------------------------------ filter options ---------------------------- */

export interface FilterOptions {
  rockets: string[]
  pads: string[]
  years: string[]
}

export function computeFilterOptions(launches: Launch[]): FilterOptions {
  const rockets = new Set<string>()
  const pads = new Set<string>()
  const years = new Set<string>()

  for (const l of launches) {
    if (l.rocketName) rockets.add(l.rocketName)
    if (l.padName) pads.add(l.padName)
    const y = launchYear(l)
    if (y != null) years.add(String(y))
  }

  return {
    rockets: [...rockets].sort(),
    pads: [...pads].sort(),
    years: [...years].sort((a, b) => Number(b) - Number(a)),
  }
}
