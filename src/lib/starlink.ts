/**
 * All interpretation of a Starlink satellite record lives here — hardware
 * version, lifecycle phase, reentry cause, orbital shell, altitude and age.
 *
 * The mirror of launch.ts for the satellite snapshot. scripts/fetch-starlink.mjs
 * only downloads, joins and trims GCAT + CelesTrak data; every rule below has
 * exactly one implementation, shared by the Starlink tab, its charts and its
 * spreadsheet export.
 *
 * Vocabulary: "version" always means satellite HARDWARE (v1.5, v2 Mini, …).
 * The "Gen1/Gen2" in FCC filings are licence authorisations, which don't
 * line up with hardware (some V2 Minis fly in a Gen1-licensed shell), so this
 * module never calls a hardware version a "generation".
 */

import { isStarlinkMission } from './launch'
import type {
  GpElements,
  GpFile,
  Launch,
  Satellite,
  StarlinkFile,
  StarlinkSnapshot,
} from './types'

/* -------------------------------- decoding -------------------------------- */

const REQUIRED_FIELDS = [
  'jcat', 'norad', 'piece', 'launchTag', 'name', 'plName', 'program', 'bus', 'plane', 'type',
  'active', 'lDate', 'lApprox', 'dDate', 'dApprox', 'tOp', 'mass', 'perigee', 'apogee', 'inc',
  'period', 'oDate', 'gpEpoch', 'gpMeanMotion', 'gpEcc',
] as const

/**
 * Expand the columnar, dictionary-encoded transport file into records.
 * Throws on a version or field mismatch so a stale cached file from an older
 * deploy can never be misread column-for-column.
 */
export function decodeStarlink(file: StarlinkFile): StarlinkSnapshot {
  if (file?.v !== 1) throw new Error(`Unsupported starlink.json version: ${String(file?.v)}`)
  const col = Object.fromEntries(file.fields.map((f, i) => [f, i]))
  const missing = REQUIRED_FIELDS.filter((f) => !(f in col))
  if (missing.length) throw new Error(`starlink.json is missing field(s): ${missing.join(', ')}`)

  const dictOf = (field: string) => file.dict[field] ?? []
  const program = dictOf('program')
  const bus = dictOf('bus')
  const plane = dictOf('plane')
  const type = dictOf('type')
  const active = dictOf('active')

  const s = (row: (string | number | null)[], f: string) => row[col[f]] as string | null
  const n = (row: (string | number | null)[], f: string) => row[col[f]] as number | null
  const d = (dict: string[], row: (string | number | null)[], f: string) => {
    const i = row[col[f]]
    return typeof i === 'number' ? (dict[i] ?? null) : null
  }

  const satellites = file.rows.map((row): Satellite => {
    const norad = n(row, 'norad')
    return {
      // The fetch script nulls jcat when it is just "S" + NORAD.
      jcat: s(row, 'jcat') ?? `S${norad}`,
      norad,
      piece: s(row, 'piece'),
      launchTag: s(row, 'launchTag'),
      name: s(row, 'name'),
      plName: s(row, 'plName'),
      program: d(program, row, 'program'),
      bus: d(bus, row, 'bus'),
      plane: d(plane, row, 'plane'),
      type: d(type, row, 'type') ?? '',
      active: d(active, row, 'active'),
      launchDate: s(row, 'lDate'),
      launchDateApprox: row[col.lApprox] === 1,
      decayDate: s(row, 'dDate'),
      decayDateApprox: row[col.dApprox] === 1,
      endOfOps: s(row, 'tOp'),
      massKg: n(row, 'mass'),
      perigeeKm: n(row, 'perigee'),
      apogeeKm: n(row, 'apogee'),
      incDeg: n(row, 'inc'),
      periodMin: n(row, 'period'),
      orbitDate: s(row, 'oDate'),
      gpEpoch: s(row, 'gpEpoch'),
      gpMeanMotion: n(row, 'gpMeanMotion'),
      gpEccentricity: n(row, 'gpEcc'),
    }
  })

  return { meta: file.meta, satellites }
}

const GP_FIELDS = ['norad', 'epoch', 'meanMotion', 'ecc', 'inc', 'raan', 'argp', 'meanAnomaly', 'bstar', 'mmDot', 'mmDdot']

export function decodeGp(file: GpFile): GpElements[] {
  if (file?.v !== 1) throw new Error(`Unsupported starlink-gp.json version: ${String(file?.v)}`)
  if (file.fields.join() !== GP_FIELDS.join()) {
    throw new Error(`starlink-gp.json fields changed: ${file.fields.join(', ')}`)
  }
  return file.rows.map(([norad, epoch, meanMotion, ecc, inc, raan, argp, meanAnomaly, bstar, mmDot, mmDdot]) => ({
    norad, epoch, meanMotion, ecc, inc, raan, argp, meanAnomaly, bstar, mmDot, mmDdot,
  }))
}

/* -------------------------------- version --------------------------------- */

export type StarlinkVersion =
  | 'Tintin'
  | 'v0.9'
  | 'v1.0'
  | 'v1.5'
  | 'v2 Mini'
  | 'v2 Mini DTC'
  | 'v2 Mini Optimized'
  | 'V3'
  | 'Unclassified'

/** Chronological, for legends, stacks and table sorting. */
export const VERSION_ORDER: StarlinkVersion[] = [
  'Tintin', 'v0.9', 'v1.0', 'v1.5', 'v2 Mini', 'v2 Mini DTC', 'v2 Mini Optimized', 'V3', 'Unclassified',
]

/**
 * Single source of truth for version colours, so the map, every chart and
 * the table dots agree. Drawn from the same family as the launch palette
 * (components/Analytics.tsx, lib/vehicles.ts) and separable by lightness as
 * well as hue.
 */
export const VERSION_COLORS: Record<StarlinkVersion, string> = {
  Tintin: '#475569', // slate-600 — prototypes
  'v0.9': '#64748b', // slate
  'v1.0': '#38bdf8', // accent blue
  'v1.5': '#10b981', // emerald
  'v2 Mini': '#a78bfa', // violet
  'v2 Mini DTC': '#f472b6', // pink — direct-to-cell
  'v2 Mini Optimized': '#f59e0b', // amber
  V3: '#e2e8f0', // near-white — the new, much larger bus
  Unclassified: '#94a3b8',
}

export function versionColor(v: StarlinkVersion): string {
  return VERSION_COLORS[v] ?? VERSION_COLORS.Unclassified
}

/** GCAT psatcat Program, e.g. "Starlink 2MO S3", "Starlink 1.0V2", "Starlink 3 S1". */
const PROGRAM_RE = /^Starlink (0|0\.9|1\.0|1\.5|2MO|2M|3)(V\d)?(?: ([A-Z])(\d))?$/

/**
 * Hardware version, from GCAT's psatcat `Program` — the only machine-readable
 * per-satellite version field in any free source. `2M D*` is the
 * direct-to-cell variant and `1.0 G3` the two Transporter rideshares.
 *
 * Uncatalogued losses (the Feb 2022 storm batch, V3s lost on Starship
 * Flight 13) have no Program, so they fall back to Bus, then to the payload
 * name's launch-group prefix. v1.5 is never written out by GCAT: it is
 * inferred from Groups 2–5 on the Gen1 "Starlink" bus.
 */
export function starlinkVersion(s: Satellite): StarlinkVersion {
  const m = s.program?.match(PROGRAM_RE)
  if (m) {
    const [, base, , shellKind] = m
    switch (base) {
      case '0':
        return 'Tintin'
      case '0.9':
        return 'v0.9'
      case '1.0':
        return 'v1.0'
      case '1.5':
        return 'v1.5'
      case '2M':
        return shellKind === 'D' ? 'v2 Mini DTC' : 'v2 Mini'
      case '2MO':
        return 'v2 Mini Optimized'
      case '3':
        return 'V3'
    }
  }

  switch (s.bus) {
    case 'Starlink V2M':
      return 'v2 Mini'
    case 'Starlink V2MD':
      return 'v2 Mini DTC'
    case 'Starlink V2MO':
      return 'v2 Mini Optimized'
    case 'Starlink V3':
      return 'V3'
    case 'SpXMicro':
      return 'Tintin'
    case 'Starlink': {
      const pl = s.plName ?? ''
      if (pl.startsWith('V0.9')) return 'v0.9'
      if (pl.startsWith('V1.0') || pl.startsWith('TSP')) return 'v1.0'
      if (/^Group [2-5]-/.test(pl)) return 'v1.5'
      return 'Unclassified'
    }
  }
  return 'Unclassified'
}

/**
 * Finer detail within a version: the VisorSat split for v1.0 ("1.0V1" =
 * Launches 9–17, "1.0V2" = 19+) and GCAT's shell/group code ("S3", "G4",
 * "D1"). Null when the Program carries neither.
 */
export function versionVariant(s: Satellite): string | null {
  const m = s.program?.match(PROGRAM_RE)
  if (!m) return null
  const [, , visor, kind, num] = m
  const parts = [visor ? `VisorSat ${visor}` : null, kind ? `${kind}${num}` : null].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

export type VersionFamily = 'Prototype' | 'V1' | 'V2 Mini' | 'V3' | 'Unclassified'

/**
 * Hardware family. These line up with the Gen1/Gen2/Gen3 subtotals on
 * McDowell's stats page (Gen1 there = Tintin + V0.9 + V1.0 + V1.5), which is
 * what the reconciliation line compares against.
 */
export function versionFamily(v: StarlinkVersion): VersionFamily {
  switch (v) {
    case 'Tintin':
      return 'Prototype'
    case 'v0.9':
    case 'v1.0':
    case 'v1.5':
      return 'V1'
    case 'v2 Mini':
    case 'v2 Mini DTC':
    case 'v2 Mini Optimized':
      return 'V2 Mini'
    case 'V3':
      return 'V3'
    default:
      return 'Unclassified'
  }
}

export const FAMILY_ORDER: VersionFamily[] = ['Prototype', 'V1', 'V2 Mini', 'V3', 'Unclassified']

export function isDirectToCell(s: Satellite): boolean {
  return starlinkVersion(s) === 'v2 Mini DTC'
}

/* ------------------------------- lifecycle -------------------------------- */

export function isInOrbit(s: Satellite): boolean {
  return s.decayDate == null
}

/**
 * GCAT Type byte 8, which McDowell repurposed as a Starlink constellation
 * status flag: O operational, A ascending, D plane drift, T/L moved
 * slightly/far out of the constellation, R lowering to reentry, M failed and
 * decaying uncontrolled, F failed early ("screened"), G graveyard, S special
 * tests, U apparently malfunctioning. For a reentered satellite it records
 * how it came down.
 */
export function constellationFlag(s: Satellite): string {
  return s.type.charAt(7).trim()
}

export type LifecyclePhase =
  | 'Operational'
  | 'Orbit raising'
  | 'Plane drift'
  | 'Relocating'
  | 'Out of constellation'
  | 'Lowering to reentry'
  | 'Failed, decaying'
  | 'Screened'
  | 'Graveyard'
  | 'Special tests'
  | 'Anomalous'
  | 'Unknown'
  | 'Reentered'

const PHASE_BY_FLAG: Record<string, LifecyclePhase> = {
  O: 'Operational',
  A: 'Orbit raising',
  D: 'Plane drift',
  T: 'Relocating',
  L: 'Out of constellation',
  R: 'Lowering to reentry',
  M: 'Failed, decaying',
  F: 'Screened',
  G: 'Graveyard',
  S: 'Special tests',
  U: 'Anomalous',
}

/** Current phase for satellites in orbit; 'Reentered' once down. */
export function lifecyclePhase(s: Satellite): LifecyclePhase {
  if (!isInOrbit(s)) return 'Reentered'
  return PHASE_BY_FLAG[constellationFlag(s)] ?? 'Unknown'
}

/** Display order: healthy states first, then the paths out of service. */
export const PHASE_ORDER: LifecyclePhase[] = [
  'Operational', 'Orbit raising', 'Plane drift', 'Relocating', 'Out of constellation',
  'Lowering to reentry', 'Special tests', 'Anomalous', 'Failed, decaying', 'Screened',
  'Graveyard', 'Unknown', 'Reentered',
]

export const PHASE_COLORS: Record<LifecyclePhase, string> = {
  Operational: '#10b981',
  'Orbit raising': '#38bdf8',
  'Plane drift': '#a78bfa',
  Relocating: '#818cf8',
  'Out of constellation': '#f59e0b',
  'Lowering to reentry': '#fb923c',
  'Failed, decaying': '#ef4444',
  Screened: '#b91c1c',
  Graveyard: '#64748b',
  'Special tests': '#f472b6',
  Anomalous: '#fbbf24',
  Unknown: '#94a3b8',
  Reentered: '#475569',
}

/**
 * McDowell's "working": in orbit and not failed (screened, failed-decaying
 * or graveyard). Satellites being raised, drifted or lowered still count.
 */
export function isWorking(s: Satellite): boolean {
  if (!isInOrbit(s)) return false
  const f = constellationFlag(s)
  return f !== 'F' && f !== 'M' && f !== 'G'
}

/** In the operational shell right now (byte 8 = O). The strictest "active". */
export function isOperationalShell(s: Satellite): boolean {
  return isInOrbit(s) && constellationFlag(s) === 'O'
}

/** In orbit and coming down: controlled lowering (R) or uncontrolled decay (M). */
export function isDecaying(s: Satellite): boolean {
  if (!isInOrbit(s)) return false
  const f = constellationFlag(s)
  return f === 'R' || f === 'M'
}

export type ReentryCause =
  | 'Failed to orbit'
  | 'Early deorbit'
  | 'Disposal'
  | 'Reentry after failure'
  | 'Other'

export const REENTRY_CAUSE_ORDER: ReentryCause[] = [
  'Disposal', 'Early deorbit', 'Reentry after failure', 'Failed to orbit', 'Other',
]

export const REENTRY_CAUSE_COLORS: Record<ReentryCause, string> = {
  Disposal: '#38bdf8',
  'Early deorbit': '#f59e0b',
  'Reentry after failure': '#ef4444',
  'Failed to orbit': '#a78bfa',
  Other: '#64748b',
}

/**
 * Why a satellite came down, matching the "Down" columns of McDowell's stats
 * page. Launch failures carry GCAT's letter-prefixed designator (2026-U04).
 * Null while in orbit.
 */
export function reentryCause(s: Satellite): ReentryCause | null {
  if (isInOrbit(s)) return null
  if (s.piece && /^\d{4}-[A-Z]\d{2}/.test(s.piece)) return 'Failed to orbit'
  switch (constellationFlag(s)) {
    case 'R':
      return 'Disposal'
    case 'F':
      return 'Early deorbit'
    case 'M':
      return 'Reentry after failure'
    default:
      return 'Other'
  }
}

/** Lost before the US catalogue assigned a number (Feb 2022 storm, Flight 13 V3s). */
export function isUncatalogued(s: Satellite): boolean {
  return s.norad == null
}

/**
 * GCAT byte 9 when SpaceX's semi-annual FCC report listed the satellite as
 * out of service: '+' could still manoeuvre, '*' could not.
 */
export function fccOutOfService(s: Satellite): 'manoeuvrable' | 'not manoeuvrable' | null {
  const b = s.type.charAt(8)
  if (b === '+') return 'manoeuvrable'
  if (b === '*') return 'not manoeuvrable'
  return null
}

/* --------------------------------- orbit ---------------------------------- */

/** WGS-84 equatorial radius and Earth's gravitational parameter (km, km³/s²). */
export const EARTH_RADIUS_KM = 6378.137
const MU_KM3_S2 = 398600.4418

export interface OrbitSummary {
  perigeeKm: number
  apogeeKm: number
  /** Semi-major axis minus Earth radius — the usual "altitude" for a near-circular orbit. */
  meanKm: number
  incDeg: number | null
  /** YYYY-MM-DD the orbit describes. */
  epoch: string
  source: 'gp' | 'gcat'
}

/**
 * Perigee/apogee from mean elements via Kepler's third law:
 * a = (μ / n²)^(1/3), with n converted from rev/day to rad/s.
 */
export function altitudeFromElements(meanMotionRevPerDay: number, ecc: number) {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86_400
  const a = Math.cbrt(MU_KM3_S2 / (n * n))
  return {
    perigeeKm: a * (1 - ecc) - EARTH_RADIUS_KM,
    apogeeKm: a * (1 + ecc) - EARTH_RADIUS_KM,
    meanKm: a - EARTH_RADIUS_KM,
  }
}

/**
 * Best available orbit: CelesTrak GP (hours old) when present and at least
 * as new as GCAT's catalogued orbit, otherwise GCAT's latest catalogued
 * orbit (mostly days old). Null once reentered or when neither exists.
 * Inclination always comes from GCAT; it barely changes.
 */
export function orbitOf(s: Satellite): OrbitSummary | null {
  if (!isInOrbit(s)) return null
  const gpDay = s.gpEpoch?.slice(0, 10) ?? null
  if (s.gpMeanMotion != null && s.gpEccentricity != null && gpDay && (!s.orbitDate || gpDay >= s.orbitDate)) {
    return {
      ...altitudeFromElements(s.gpMeanMotion, s.gpEccentricity),
      incDeg: s.incDeg,
      epoch: gpDay,
      source: 'gp',
    }
  }
  if (s.perigeeKm != null && s.apogeeKm != null && s.orbitDate) {
    return {
      perigeeKm: s.perigeeKm,
      apogeeKm: s.apogeeKm,
      meanKm: (s.perigeeKm + s.apogeeKm) / 2,
      incDeg: s.incDeg,
      epoch: s.orbitDate,
      source: 'gcat',
    }
  }
  return null
}

export function meanAltitudeKm(s: Satellite): number | null {
  return orbitOf(s)?.meanKm ?? null
}

/** Days between the orbit's epoch and `asOf` (an ISO timestamp). */
export function orbitAgeDays(s: Satellite, asOf: string): number | null {
  const o = orbitOf(s)
  return o ? daysBetween(o.epoch, asOf) : null
}

export const STALE_ORBIT_DAYS = 14

/** Orbit more than two weeks old — shown amber, and excluded from altitude medians. */
export function isOrbitStale(s: Satellite, asOf: string): boolean {
  const age = orbitAgeDays(s, asOf)
  return age != null && age > STALE_ORBIT_DAYS
}

/**
 * Perigee below ~280 km and not ascending: past the point where Starlinks
 * typically come down within days to weeks. A heuristic, labelled as such.
 */
export function approachingReentry(s: Satellite): boolean {
  const o = orbitOf(s)
  return o != null && o.perigeeKm < 280 && constellationFlag(s) !== 'A'
}

/* --------------------------------- shells --------------------------------- */

export interface Shell {
  id: string
  label: string
  /** Lower/upper inclination bound, degrees. */
  min: number
  max: number
}

/**
 * Inclination bands observed in the live data. Gen1's polar shell (97.6°)
 * and Gen2's (97.28°) are separate — trackers that lump them as "97°" blur
 * two different populations.
 */
export const SHELLS: Shell[] = [
  { id: '53.0', label: '53.0°', min: 52.9, max: 53.1 },
  { id: '53.2', label: '53.2°', min: 53.1, max: 53.3 },
  { id: '43', label: '43°', min: 42.8, max: 43.2 },
  { id: '70', label: '70°', min: 69.8, max: 70.2 },
  { id: '97.3', label: '97.3° (Gen2 polar)', min: 97.15, max: 97.45 },
  { id: '97.6', label: '97.6° (Gen1 polar)', min: 97.45, max: 97.8 },
  { id: '30.5', label: '30.5° (V3 ascent)', min: 30.2, max: 30.8 },
]

const OTHER_SHELL: Shell = { id: 'other', label: 'Other', min: -Infinity, max: Infinity }

export function shellOf(s: Satellite): Shell | null {
  const inc = s.incDeg
  if (inc == null || !isInOrbit(s)) return null
  return SHELLS.find((sh) => inc >= sh.min && inc < sh.max) ?? OTHER_SHELL
}

/* ---------------------------------- time ---------------------------------- */

const DAY_MS = 86_400_000

/** Whole days from date `a` to date/timestamp `b`; ISO strings, UTC. */
export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a)
  const tb = Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b)
  return Math.floor((tb - ta) / DAY_MS)
}

/**
 * Days since launch, measured to `asOf` (the snapshot's generatedAt), never
 * the viewer's clock — so the UI and the spreadsheet always agree.
 */
export function ageDays(s: Satellite, asOf: string): number | null {
  return s.launchDate ? Math.max(0, daysBetween(s.launchDate, asOf)) : null
}

/** Launch to reentry for satellites that are down; null while in orbit. */
export function lifetimeDays(s: Satellite): number | null {
  if (!s.launchDate || !s.decayDate) return null
  return Math.max(0, daysBetween(s.launchDate, s.decayDate))
}

export function launchYearOf(s: Satellite): number | null {
  const y = Number(s.launchDate?.slice(0, 4))
  return Number.isFinite(y) && y > 2000 ? y : null
}

/**
 * Launch group from the payload name: "Group 15-14-01" -> "Group 15-14",
 * "V1.0-L1-01" -> "V1.0-L1", "V0.9-07" -> "V0.9". Falls back to the COSPAR
 * launch, which every catalogued satellite has.
 */
export function launchGroup(s: Satellite): string | null {
  if (s.plName && /-\d+$/.test(s.plName)) return s.plName.replace(/-\d+$/, '')
  return s.plName ?? s.launchTag
}

/** "Starlink-38128" style display name; prototypes keep their own names. */
export function displayName(s: Satellite): string {
  if (!s.name) return s.jcat
  return /^\d+$/.test(s.name) ? `Starlink-${s.name}` : s.name
}

/* ------------------------------ launch linking ---------------------------- */

export interface LaunchIndex {
  byDesignator: Map<string, Launch>
  /** Starlink launches by UTC day, for snapshots predating launchDesignator. */
  starlinkByDay: Map<string, Launch[]>
}

export function indexStarlinkLaunches(launches: Launch[]): LaunchIndex {
  const byDesignator = new Map<string, Launch>()
  const starlinkByDay = new Map<string, Launch[]>()
  for (const l of launches) {
    if (l.launchDesignator) byDesignator.set(l.launchDesignator, l)
    if (isStarlinkMission(l) && l.net) {
      const day = l.net.slice(0, 10)
      starlinkByDay.set(day, [...(starlinkByDay.get(day) ?? []), l])
    }
  }
  return { byDesignator, starlinkByDay }
}

/**
 * The LL2 launch that carried this satellite. Joins GCAT's COSPAR launch tag
 * to LL2's launch_designator; if the launch snapshot predates that field,
 * falls back to a same-UTC-day Starlink launch, but only when exactly one
 * matches (two Starlink launches a day happen, and a guess would mislink).
 */
export function launchFor(s: Satellite, index: LaunchIndex): Launch | null {
  if (s.launchTag) {
    const exact = index.byDesignator.get(s.launchTag)
    if (exact) return exact
  }
  if (!s.launchDate || s.launchDateApprox) return null
  const sameDay = index.starlinkByDay.get(s.launchDate)
  return sameDay && sameDay.length === 1 ? sameDay[0] : null
}
