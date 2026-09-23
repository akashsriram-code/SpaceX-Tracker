/**
 * KPI and analytics aggregation. Pure functions over the normalized
 * snapshot — no fetching, no React — so they're cheap to memoize and easy
 * to reason about.
 */

import {
  customerSegment,
  hasKnownSerial,
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

/* ------------------------------ booster fleet ----------------------------- */

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}

export interface TurnaroundRow {
  year: number
  /** Median days between a core's previous flight and this one. */
  median: number | null
  /** Fastest turnaround achieved that year. */
  fastest: number | null
  /** How many reflights the year's figures are based on. */
  samples: number
}

/**
 * Turnaround time per year. Only reflights contribute — a core's first
 * flight has no previous flight to measure against, so LL2 leaves
 * `turnAroundTimeDays` null there (633 of 820 booster records have a value).
 */
export function computeTurnaroundTrend(launches: Launch[]): TurnaroundRow[] {
  const byYear = new Map<number, number[]>()

  for (const l of launches) {
    const y = launchYear(l)
    if (y == null) continue
    for (const b of l.boosters) {
      if (b.turnAroundTimeDays == null) continue
      const list = byYear.get(y) ?? []
      list.push(b.turnAroundTimeDays)
      byYear.set(y, list)
    }
  }

  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, days]) => {
      const sorted = [...days].sort((a, b) => a - b)
      return {
        year,
        median: median(sorted),
        fastest: sorted[0] ?? null,
        samples: sorted.length,
      }
    })
}

export interface RecoveryRow {
  /** LL2 landing type: ASDS, Return to Launch Site, Expended, Ocean, … */
  method: string
  attempts: number
  successes: number
  failures: number
  /**
   * Attempts with no recorded success/failure — deliberately-expended cores
   * and landings still pending. Without this the "Expended" row (45 records,
   * 0 successes, 0 failures) would render as an invisible bar.
   */
  other: number
  /** null for methods where recovery isn't the goal (Expended). */
  successRate: number | null
}

/** Landing attempts grouped by recovery method. */
export function computeRecoveryMethods(launches: Launch[]): RecoveryRow[] {
  const rows = new Map<string, RecoveryRow>()

  for (const l of launches) {
    for (const b of l.boosters) {
      if (!b.landingType) continue
      let row = rows.get(b.landingType)
      if (!row) {
        row = {
          method: b.landingType,
          attempts: 0,
          successes: 0,
          failures: 0,
          other: 0,
          successRate: null,
        }
        rows.set(b.landingType, row)
      }
      row.attempts += 1
      if (b.landingSuccess === true) row.successes += 1
      else if (b.landingSuccess === false) row.failures += 1
    }
  }

  for (const row of rows.values()) {
    const decided = row.successes + row.failures
    row.other = row.attempts - decided
    row.successRate = decided > 0 ? row.successes / decided : null
  }

  return [...rows.values()].sort((a, b) => b.attempts - a.attempts)
}

export interface LandingSiteRow {
  site: string
  successes: number
  failures: number
  total: number
}

/** Where boosters came down — droneships, landing zones, and ocean splashdowns. */
export function computeLandingSites(launches: Launch[]): LandingSiteRow[] {
  const rows = new Map<string, LandingSiteRow>()

  for (const l of launches) {
    for (const b of l.boosters) {
      if (!b.landingLocation) continue
      let row = rows.get(b.landingLocation)
      if (!row) {
        row = { site: b.landingLocation, successes: 0, failures: 0, total: 0 }
        rows.set(b.landingLocation, row)
      }
      row.total += 1
      if (b.landingSuccess === true) row.successes += 1
      else if (b.landingSuccess === false) row.failures += 1
    }
  }

  return [...rows.values()].sort((a, b) => b.total - a.total)
}

export interface FleetRow {
  serial: string
  /** Flights for this core present in the snapshot. */
  flights: number
  /** Highest flight number LL2 attributes to the core. */
  maxFlightNumber: number
  lastFlown: string
  daysSinceLastFlight: number
  landings: number
  fastestTurnaround: number | null
  /**
   * Outcome of the core's most recent landing attempt. Reported as fact
   * ("Recovered"/"Expended"), deliberately NOT as "Active"/"Retired" — a
   * recovered core may still be retired (museum pieces, life-leaders) and
   * the snapshot cannot tell the difference.
   */
  lastOutcome: 'recovered' | 'expended' | 'pending'
}

/**
 * Per-core fleet summary, newest activity first.
 *
 * Skips LL2's placeholder serials via hasKnownSerial() so the table matches
 * what the launch cards show.
 */
export function computeFleet(launches: Launch[]): FleetRow[] {
  interface Acc extends Omit<FleetRow, 'daysSinceLastFlight'> {
    lastNet: string
  }
  const fleet = new Map<string, Acc>()

  for (const l of launches) {
    for (const b of l.boosters) {
      if (!hasKnownSerial(b.serial)) continue
      const serial = b.serial as string

      let row = fleet.get(serial)
      if (!row) {
        row = {
          serial,
          flights: 0,
          maxFlightNumber: 0,
          lastFlown: l.net,
          lastNet: l.net,
          landings: 0,
          fastestTurnaround: null,
          lastOutcome: 'pending',
        }
        fleet.set(serial, row)
      }

      row.flights += 1
      if (b.flightNumber != null && b.flightNumber > row.maxFlightNumber) {
        row.maxFlightNumber = b.flightNumber
      }
      if (b.landingSuccess === true) row.landings += 1
      if (
        b.turnAroundTimeDays != null &&
        (row.fastestTurnaround == null || b.turnAroundTimeDays < row.fastestTurnaround)
      ) {
        row.fastestTurnaround = b.turnAroundTimeDays
      }

      // Track the most recent flight so `lastOutcome` reflects the core's
      // latest state rather than whichever record happened to come last.
      if (l.net >= row.lastNet) {
        row.lastNet = l.net
        row.lastFlown = l.net
        row.lastOutcome =
          b.landingSuccess === true
            ? 'recovered'
            : b.landingSuccess === false || b.landingType === 'Expended'
              ? 'expended'
              : 'pending'
      }
    }
  }

  const now = Date.now()
  return [...fleet.values()]
    .map(({ lastNet: _lastNet, ...row }) => ({
      ...row,
      daysSinceLastFlight: Math.max(
        0,
        Math.round((now - new Date(row.lastFlown).getTime()) / 86_400_000),
      ),
    }))
    .sort((a, b) => b.maxFlightNumber - a.maxFlightNumber)
}

export interface FleetSummary {
  cores: number
  totalLandings: number
  recordTurnaround: number | null
  /** Median turnaround across the most recent year that has data. */
  latestMedianTurnaround: number | null
  latestYear: number | null
  /** Booster records carrying a turnaround value, for honest coverage labelling. */
  turnaroundSamples: number
  boosterRecords: number
}

export function computeFleetSummary(launches: Launch[]): FleetSummary {
  const trend = computeTurnaroundTrend(launches)
  const fleet = computeFleet(launches)

  let boosterRecords = 0
  let turnaroundSamples = 0
  let totalLandings = 0
  let record: number | null = null

  for (const l of launches) {
    for (const b of l.boosters) {
      boosterRecords += 1
      if (b.landingSuccess === true) totalLandings += 1
      if (b.turnAroundTimeDays != null) {
        turnaroundSamples += 1
        if (record == null || b.turnAroundTimeDays < record) record = b.turnAroundTimeDays
      }
    }
  }

  const latest = trend.at(-1) ?? null

  return {
    cores: fleet.length,
    totalLandings,
    recordTurnaround: record,
    latestMedianTurnaround: latest?.median ?? null,
    latestYear: latest?.year ?? null,
    turnaroundSamples,
    boosterRecords,
  }
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
