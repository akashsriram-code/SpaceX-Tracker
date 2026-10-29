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

  /**
   * COSPAR international designator of the launch, e.g. "2026-160". Null for
   * launches that haven't flown (and in snapshots written before this field
   * existed). Joins satellites (GCAT Launch_Tag) to the launch that carried them.
   */
  launchDesignator: string | null
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

/* --------------------------- Starlink satellites -------------------------- */

/**
 * Columnar transport shape of public/data/starlink.json, written by
 * scripts/fetch-starlink.mjs. Rows are arrays ordered by `fields`; columns
 * named in `dict` hold indexes into that dictionary. Decoded into
 * `Satellite[]` by decodeStarlink() in src/lib/starlink.ts.
 */
export interface StarlinkFile {
  v: 1
  meta: StarlinkMeta
  fields: string[]
  dict: Record<string, string[]>
  rows: Array<Array<string | number | null>>
}

/** One column of McDowell's published Starlink summary table. */
export interface StarlinkReferenceCounts {
  launched: number
  failedToOrbit: number
  earlyDeorbit: number
  disposalComplete: number
  reentryAfterFail: number
  down: number
  inOrbit: number
  screened: number
  failedDecaying: number
  graveyard: number
  working: number
  disposalUnderway: number
  outOfConstellation: number
  anomalous: number
  relocating: number
  special: number
  drift: number
  ascent: number
  operational: number
}

export interface StarlinkMeta {
  generatedAt: string
  /** Newest "# Updated" stamp across the GCAT files, ISO UTC. */
  gcatUpdated: string | null
  satelliteCount: number
  inOrbitCount: number
  excluded: Record<string, number>
  /** McDowell's stats.html totals, used only as a reconciliation target. */
  reference: {
    asOf: string | null
    total: StarlinkReferenceCounts
    gen1: StarlinkReferenceCounts | null
    gen2: StarlinkReferenceCounts | null
    gen3: StarlinkReferenceCounts | null
    rows: Array<{ label: string; values: StarlinkReferenceCounts }>
  } | null
  gp: { status: number | string; rows: number; maxEpoch: string; attemptedAt: string | null } | null
  files: Record<string, { url: string; status: number | string; updated: string | null; rows: number | null }>
  source: string
  attribution: string
}

/**
 * One Starlink satellite, as catalogued by GCAT and (when CelesTrak has
 * elements for it) joined to its latest GP element set. Raw values only —
 * version, lifecycle phase, shell and altitude are derived in starlink.ts.
 */
export interface Satellite {
  /** GCAT id: "S" + NORAD for catalogued objects, "A…" for uncatalogued losses. */
  jcat: string
  /** Null for satellites lost before the US catalogue assigned a number. */
  norad: number | null
  /** COSPAR id, e.g. "2026-160A". Launch failures use GCAT's "2026-U04". */
  piece: string | null
  /** COSPAR launch, e.g. "2026-160" — the join key to LL2's launch_designator. */
  launchTag: string | null
  /** "38128" (the "Starlink " prefix is stripped), or "Tintin A". */
  name: string | null
  /** Payload name with launch group, e.g. "Group 15-14-01" or "V1.0-L1-01". */
  plName: string | null
  /** GCAT psatcat Program, e.g. "Starlink 2MO S3". Null for uncatalogued losses. */
  program: string | null
  /** GCAT Bus, e.g. "Starlink V2MO". Coarser than Program (Gen1 is one value). */
  bus: string | null
  /** GCAT Plane — an internal shell/plane index; undocumented for Starlink. */
  plane: string | null
  /** Raw 12-character GCAT Type code; byte 8 is the Starlink lifecycle flag. */
  type: string
  /** GCAT currentcat Active: A = active, P = previously active. */
  active: string | null
  launchDate: string | null
  launchDateApprox: boolean
  /** Reentry date; null while in orbit. */
  decayDate: string | null
  decayDateApprox: boolean
  /** End of operations (psatcat TOp), when GCAT records one. */
  endOfOps: string | null
  /** GCAT's estimate, not a manufacturer figure. */
  massKg: number | null
  /** Latest catalogued orbit (GCAT currentcat), null once reentered. */
  perigeeKm: number | null
  apogeeKm: number | null
  incDeg: number | null
  periodMin: number | null
  orbitDate: string | null
  /** CelesTrak GP element-set epoch (UTC, no zone suffix) when joined. */
  gpEpoch: string | null
  /** Revolutions per day. */
  gpMeanMotion: number | null
  gpEccentricity: number | null
}

export interface StarlinkSnapshot {
  meta: StarlinkMeta
  satellites: Satellite[]
}

/** Columnar transport shape of public/data/starlink-gp.json (SGP4 inputs). */
export interface GpFile {
  v: 1
  generatedAt: string
  source: string
  fields: string[]
  rows: Array<[number, string, number, number, number, number, number, number, number, number, number]>
}

/** One CelesTrak GP element set, ready for satellite.js json2satrec. */
export interface GpElements {
  norad: number
  epoch: string
  meanMotion: number
  ecc: number
  inc: number
  raan: number
  argp: number
  meanAnomaly: number
  bstar: number
  mmDot: number
  mmDdot: number
}

/** McDowell's log.dat weekly sample: [date, ...counts] per `fields`. */
export interface StarlinkHistoryFile {
  v: 1
  generatedAt: string
  source: string
  fields: string[]
  rows: Array<[string, ...number[]]>
}

/* ------------------------------ UI view models ----------------------------- */

export type TabId = 'upcoming' | 'past' | 'analytics' | 'boosters' | 'starlink'

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
