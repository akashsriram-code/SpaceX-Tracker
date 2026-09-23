/**
 * Domain model for the dashboard.
 *
 * These interfaces describe the *normalized* snapshot written by
 * `scripts/fetch-data.mjs`, not the raw Launch Library 2 payload. The fetch
 * script is deliberately dumb — it only flattens and slims the upstream
 * response (a single detailed LL2 launch is ~49 KB; 530 of them would be far
 * too large to commit or serve). All interpretation (Starlink detection,
 * customer attribution, KPI math) lives in the app so there is exactly one
 * implementation of each rule.
 */

/** LL2 status ids. Anything >= 3 is a terminal outcome. */
export const LaunchStatusId = {
  Go: 1,
  TBD: 2,
  Success: 3,
  Failure: 4,
  Hold: 5,
  InFlight: 6,
  PartialFailure: 7,
  TBC: 8,
} as const

export interface LaunchStatus {
  id: number
  name: string
  abbrev: string
}

export interface Booster {
  /** e.g. "B1082" — null for expendable/early flights where LL2 has no serial. */
  serial: string | null
  /** Which flight this was for *this* booster (LL2 launcher_flight_number). */
  flightNumber: number | null
  /** Total flights LL2 currently attributes to the booster. */
  totalFlights: number | null
  reused: boolean | null
  landingAttempt: boolean | null
  /** null while a landing is pending or was never attempted. */
  landingSuccess: boolean | null
  /** e.g. "Autonomous Spaceport Drone Ship", "Return to Launch Site". */
  landingType: string | null
  landingLocation: string | null
  /** Days between this flight and the booster's previous one. */
  turnAroundTimeDays: number | null
  previousFlightDate: string | null
}

export interface LaunchPayload {
  name: string | null
  massKg: number | null
  orbit: string | null
  manufacturer: string | null
  customers: string[]
}

export interface MediaLink {
  url: string
  title: string | null
  source: string | null
  /** LL2 link type, e.g. "Official Webcast", "Official Page". */
  type: string | null
}

export interface Agency {
  name: string
  abbrev: string | null
  /** e.g. "Commercial", "Government", "Educational". */
  type: string | null
}

export interface Launch {
  id: string
  slug: string | null
  /** Full LL2 name, e.g. "Falcon 9 Block 5 | Starlink Group 15-25". */
  name: string
  missionName: string | null
  missionDescription: string | null
  /** e.g. "Communications", "Resupply", "Human Exploration". */
  missionType: string | null

  /** No Earlier Than, ISO 8601 UTC. */
  net: string
  /**
   * How precise `net` actually is — "Minute" for a locked-in T-0, but often
   * "Day"/"Month"/"Quarter"/"Year" for far-out missions. Displaying a
   * second-level countdown against a "Quarter"-precision NET would be a lie,
   * so the UI degrades its display based on this.
   */
  netPrecision: string | null
  windowStart: string | null
  windowEnd: string | null

  status: LaunchStatus
  /** Populated by LL2 only for failures. */
  failReason: string | null

  rocketName: string | null
  /** e.g. "Falcon 9 Block 5". */
  rocketFullName: string | null
  rocketVariant: string | null
  rocketWikiUrl: string | null

  boosters: Booster[]
  payloads: LaunchPayload[]

  orbitName: string | null
  orbitAbbrev: string | null

  padName: string | null
  padLocation: string | null
  padWikiUrl: string | null

  /** Agencies LL2 associates with the mission (often the customer). */
  agencies: Agency[]
  /** Launch service provider — effectively always SpaceX in this dataset. */
  lspName: string | null

  patchUrl: string | null
  imageUrl: string | null
  vidUrls: MediaLink[]
  infoUrls: MediaLink[]

  /** Weather go-probability percentage, when published. */
  probability: number | null
  weatherConcerns: string | null

  /** Nth orbital launch attempt from this pad, per LL2. */
  padLaunchAttemptCount: number | null
}

export interface SnapshotMeta {
  generatedAt: string
  source: string
  sourceNote: string
  launchCount: number
  /** LL2's own reported total, to detect truncated fetches. */
  upstreamCount: number
}

export interface Snapshot {
  meta: SnapshotMeta
  launches: Launch[]
}

/* ------------------------------ UI view models ----------------------------- */

export type TabId = 'upcoming' | 'past' | 'analytics' | 'boosters'

export type StarlinkFilter = 'all' | 'customer' | 'starlink'

export type SortDirection = 'newest' | 'oldest'

export interface Filters {
  search: string
  starlink: StarlinkFilter
  rocket: string
  pad: string
  year: string
  sort: SortDirection
}

/** Terminal outcome of a launch, collapsed for display/stats. */
export type Outcome = 'success' | 'failure' | 'partial' | 'pending'
