/**
 * Column definitions for the Starlink satellite export: which Satellite
 * field lands in which column, under what header, as what type.
 *
 * The satellite counterpart of schema.ts, with the same rule: this file only
 * MAPS. Every "(derived)" column is a plain call into src/lib/starlink.ts (or
 * starlinkStats.ts for the Versions sheet) — if a value needs a new rule, the
 * rule goes there, so the Starlink tab and the spreadsheet can never disagree
 * about, say, what counts as "working".
 *
 * Free of any spreadsheet library, DOM or React import, so the same
 * definitions build the file in the browser and are checked under tsx by
 * scripts/verify-starlink-export.mjs.
 */

import {
  ageDays,
  constellationFlag,
  displayName,
  fccOutOfService,
  isInOrbit,
  isOperationalShell,
  isOrbitStale,
  isWorking,
  launchGroup,
  lifecyclePhase,
  lifetimeDays,
  orbitOf,
  reentryCause,
  shellOf,
  starlinkVersion,
  versionFamily,
  versionVariant,
} from '../starlink'
import type { VersionRow } from '../starlinkStats'
import type { Launch, Satellite } from '../types'
import { zonelessAsUtc, type SheetColumnSpec } from './cells'

/**
 * One satellite with the context its derived columns need: `asOf` (the
 * snapshot's generatedAt, so ages match the tab rather than the exporter's
 * clock) and the LL2 launch launchFor() linked it to.
 */
export interface SatelliteRow {
  sat: Satellite
  asOf: string
  launch: Launch | null
}

/**
 * Computed altitudes carry float noise from Kepler's law ("547.2318…"); a
 * tenth of a km is far finer than the elements behind them justify.
 */
function tenth(km: number | null | undefined): number | null {
  return km == null ? null : Math.round(km * 10) / 10
}

const GCAT_ORBIT = 'GCAT latest catalogued orbit (currentcat); blank once reentered.'

/* ------------------------------ Satellites -------------------------------- */

export const SATELLITE_COLUMNS: SheetColumnSpec<SatelliteRow>[] = [
  {
    header: 'NORAD',
    kind: 'integer',
    width: 9,
    source: 'norad',
    description:
      'US catalogue number, and the key of this sheet. Blank for satellites lost before they were catalogued (no NORAD id was ever assigned).',
    value: (r) => r.sat.norad,
  },
  {
    header: 'Name',
    kind: 'text',
    width: 12,
    source: 'name',
    description: 'GCAT name with the "Starlink " prefix stripped, e.g. 38128, or a prototype name such as Tintin A.',
    value: (r) => r.sat.name,
  },
  {
    header: 'COSPAR ID',
    kind: 'text',
    width: 11,
    source: 'piece',
    description: 'International designator, e.g. 2026-160A. Launch failures use GCAT\'s letter form, e.g. 2026-U04.',
    value: (r) => r.sat.piece,
  },
  {
    header: 'COSPAR launch',
    kind: 'text',
    width: 10,
    source: 'launchTag',
    description: 'International designator of the launch, e.g. 2026-160; joins to COSPAR launch ID in the launch workbook.',
    value: (r) => r.sat.launchTag,
  },
  {
    header: 'GCAT ID',
    kind: 'text',
    width: 10,
    source: 'jcat',
    description: 'GCAT catalogue id: S + NORAD for catalogued satellites, A… for uncatalogued losses.',
    value: (r) => r.sat.jcat,
  },
  {
    header: 'Payload name',
    kind: 'text',
    width: 16,
    source: 'plName',
    description: 'GCAT payload name with launch group, e.g. Group 15-14-01 or V1.0-L1-01.',
    value: (r) => r.sat.plName,
  },
  {
    header: 'GCAT program',
    kind: 'text',
    width: 16,
    source: 'program',
    description: 'GCAT psatcat Program, e.g. Starlink 2MO S3 — the source of Version (derived). Blank for uncatalogued losses.',
    value: (r) => r.sat.program,
  },
  {
    header: 'GCAT bus',
    kind: 'text',
    width: 14,
    source: 'bus',
    description: 'GCAT Bus, e.g. Starlink V2MO. Coarser than Program: every V1 satellite is just "Starlink".',
    value: (r) => r.sat.bus,
  },
  {
    header: 'GCAT plane',
    kind: 'text',
    width: 9,
    source: 'plane',
    description: 'GCAT Plane: an internal shell/plane index, undocumented for Starlink. Shown as published.',
    value: (r) => r.sat.plane,
  },
  {
    header: 'GCAT type code',
    kind: 'text',
    width: 14,
    source: 'type',
    description:
      'Raw 12-character GCAT Type code. Byte 8 is McDowell\'s Starlink lifecycle flag (see Status flag), byte 9 the FCC out-of-service marker.',
    value: (r) => r.sat.type,
  },
  {
    header: 'GCAT active flag',
    kind: 'text',
    width: 8,
    source: 'active',
    description: 'GCAT currentcat Active: A = active, P = previously active.',
    value: (r) => r.sat.active,
  },
  {
    header: 'Launch date (UTC)',
    kind: 'date',
    width: 11,
    source: 'launchDate',
    description: 'Launch date, UTC, day precision.',
    value: (r) => r.sat.launchDate,
  },
  {
    header: 'Launch date approximate',
    kind: 'boolean',
    width: 10,
    source: 'launchDateApprox',
    description: 'TRUE when GCAT marks the launch date as uncertain.',
    value: (r) => r.sat.launchDateApprox,
  },
  {
    header: 'Reentry date (UTC)',
    kind: 'date',
    width: 11,
    source: 'decayDate',
    description: 'Reentry date, UTC, day precision; blank while in orbit.',
    value: (r) => r.sat.decayDate,
  },
  {
    header: 'Reentry date approximate',
    kind: 'boolean',
    width: 10,
    source: 'decayDateApprox',
    description: 'TRUE when GCAT marks the reentry date as uncertain; FALSE (not blank) while in orbit.',
    value: (r) => r.sat.decayDateApprox,
  },
  {
    header: 'End of operations (UTC)',
    kind: 'date',
    width: 11,
    source: 'endOfOps',
    description: 'GCAT psatcat end of operations, when recorded; often blank even for reentered satellites.',
    value: (r) => r.sat.endOfOps,
  },
  {
    header: 'Mass (kg)',
    kind: 'number',
    width: 9,
    source: 'massKg',
    description: 'GCAT estimate, not a manufacturer figure.',
    value: (r) => r.sat.massKg,
  },
  {
    header: 'Perigee (km)',
    kind: 'number',
    width: 9,
    source: 'perigeeKm',
    description: `Perigee height. ${GCAT_ORBIT}`,
    value: (r) => r.sat.perigeeKm,
  },
  {
    header: 'Apogee (km)',
    kind: 'number',
    width: 9,
    source: 'apogeeKm',
    description: `Apogee height. ${GCAT_ORBIT}`,
    value: (r) => r.sat.apogeeKm,
  },
  {
    header: 'Inclination (deg)',
    kind: 'number',
    width: 9,
    source: 'incDeg',
    description: `Orbital inclination. ${GCAT_ORBIT}`,
    value: (r) => r.sat.incDeg,
  },
  {
    header: 'Period (min)',
    kind: 'number',
    width: 9,
    source: 'periodMin',
    description: `Orbital period. ${GCAT_ORBIT}`,
    value: (r) => r.sat.periodMin,
  },
  {
    header: 'Orbit date (UTC)',
    kind: 'date',
    width: 11,
    source: 'orbitDate',
    description: 'Date of the GCAT catalogued orbit in the four columns before; blank once reentered.',
    value: (r) => r.sat.orbitDate,
  },
  {
    header: 'GP epoch (UTC)',
    kind: 'datetime',
    width: 19,
    source: 'gpEpoch',
    description:
      'Epoch of the CelesTrak GP element set, UTC (CelesTrak publishes it without a zone suffix). Blank when CelesTrak has no elements for the satellite.',
    value: (r) => zonelessAsUtc(r.sat.gpEpoch),
  },
  {
    header: 'GP mean motion (rev/day)',
    kind: 'number',
    width: 12,
    source: 'gpMeanMotion',
    description: 'CelesTrak GP mean motion, revolutions per day (SGP4 mean element, not osculating).',
    value: (r) => r.sat.gpMeanMotion,
  },
  {
    header: 'GP eccentricity',
    kind: 'number',
    width: 11,
    source: 'gpEccentricity',
    description: 'CelesTrak GP mean eccentricity.',
    value: (r) => r.sat.gpEccentricity,
  },

  /* ------------------------------- derived -------------------------------- */

  {
    header: 'Display name',
    kind: 'text',
    width: 16,
    derived: true,
    source: 'displayName() in src/lib/starlink.ts',
    description: 'Name as the dashboard shows it, e.g. Starlink-38128; prototypes keep their own names.',
    value: (r) => displayName(r.sat),
  },
  {
    header: 'Version',
    kind: 'text',
    width: 16,
    derived: true,
    source: 'starlinkVersion() in src/lib/starlink.ts',
    description:
      'Hardware version (Tintin, v0.9, v1.0, v1.5, v2 Mini, v2 Mini DTC, v2 Mini Optimized, V3) from GCAT Program, falling back to Bus and payload name.',
    value: (r) => starlinkVersion(r.sat),
  },
  {
    header: 'Version detail',
    kind: 'text',
    width: 14,
    derived: true,
    source: 'versionVariant() in src/lib/starlink.ts',
    description: 'VisorSat split and GCAT shell/group code from Program, e.g. "VisorSat V2" or "S3"; blank when Program has neither.',
    value: (r) => versionVariant(r.sat),
  },
  {
    header: 'Family',
    kind: 'text',
    width: 11,
    derived: true,
    source: 'versionFamily(starlinkVersion()) in src/lib/starlink.ts',
    description: 'Hardware family: Prototype, V1, V2 Mini or V3. Not the FCC Gen1/Gen2 licence.',
    value: (r) => versionFamily(starlinkVersion(r.sat)),
  },
  {
    header: 'In orbit',
    kind: 'boolean',
    width: 8,
    derived: true,
    source: 'isInOrbit() in src/lib/starlink.ts',
    description: 'TRUE while there is no reentry date.',
    value: (r) => isInOrbit(r.sat),
  },
  {
    header: 'Working',
    kind: 'boolean',
    width: 8,
    derived: true,
    source: 'isWorking() in src/lib/starlink.ts',
    description: "McDowell's \"working\": in orbit and not failed, screened or in the graveyard. Satellites being raised, drifted or lowered count.",
    value: (r) => isWorking(r.sat),
  },
  {
    header: 'In operational shell',
    kind: 'boolean',
    width: 11,
    derived: true,
    source: 'isOperationalShell() in src/lib/starlink.ts',
    description: 'In orbit with lifecycle flag O: in its operational shell right now. The strictest "active".',
    value: (r) => isOperationalShell(r.sat),
  },
  {
    header: 'Status flag',
    kind: 'text',
    width: 7,
    derived: true,
    source: 'constellationFlag() in src/lib/starlink.ts',
    description:
      'GCAT Type byte 8: O operational, A ascending, D drift, T relocating, L out of constellation, R lowering, M failed decaying, F screened, G graveyard, S special, U anomalous. For a reentered satellite it records how it came down.',
    value: (r) => constellationFlag(r.sat),
  },
  {
    header: 'Lifecycle phase',
    kind: 'text',
    width: 18,
    derived: true,
    source: 'lifecyclePhase() in src/lib/starlink.ts',
    description: 'Status flag as a phase name (Operational, Orbit raising, …); Reentered once down.',
    value: (r) => lifecyclePhase(r.sat),
  },
  {
    header: 'Reentry cause',
    kind: 'text',
    width: 18,
    derived: true,
    source: 'reentryCause() in src/lib/starlink.ts',
    description:
      'Why a reentered satellite came down, matching McDowell\'s "Down" columns: Disposal, Early deorbit, Reentry after failure, Failed to orbit or Other. Blank while in orbit.',
    value: (r) => reentryCause(r.sat),
  },
  {
    header: 'Shell',
    kind: 'text',
    width: 16,
    derived: true,
    source: 'shellOf()?.label in src/lib/starlink.ts',
    description: 'Inclination band, e.g. 53.0° or 97.6° (Gen1 polar); Other outside the known bands. Blank once reentered.',
    value: (r) => shellOf(r.sat)?.label,
  },
  {
    header: 'Orbit source',
    kind: 'text',
    width: 8,
    derived: true,
    source: 'orbitOf()?.source in src/lib/starlink.ts',
    description:
      'Which orbit the current-orbit columns use: gp = CelesTrak GP mean elements, gcat = GCAT catalogued orbit (when GP is missing or older). Blank once reentered.',
    value: (r) => orbitOf(r.sat)?.source,
  },
  {
    header: 'Current orbit date (UTC)',
    kind: 'date',
    width: 11,
    derived: true,
    source: 'orbitOf()?.epoch in src/lib/starlink.ts',
    description: 'UTC day of the orbit named in Orbit source.',
    value: (r) => orbitOf(r.sat)?.epoch,
  },
  {
    header: 'Mean altitude (km)',
    kind: 'number',
    width: 10,
    derived: true,
    source: 'orbitOf()?.meanKm in src/lib/starlink.ts, to 0.1 km',
    description:
      'Semi-major axis minus Earth radius (GP) or mean of perigee and apogee (GCAT). Latest catalogued orbit, not a live position.',
    value: (r) => tenth(orbitOf(r.sat)?.meanKm),
  },
  {
    header: 'Current perigee (km)',
    kind: 'number',
    width: 10,
    derived: true,
    source: 'orbitOf()?.perigeeKm in src/lib/starlink.ts, to 0.1 km',
    description: 'Perigee height from the orbit named in Orbit source.',
    value: (r) => tenth(orbitOf(r.sat)?.perigeeKm),
  },
  {
    header: 'Current apogee (km)',
    kind: 'number',
    width: 10,
    derived: true,
    source: 'orbitOf()?.apogeeKm in src/lib/starlink.ts, to 0.1 km',
    description: 'Apogee height from the orbit named in Orbit source.',
    value: (r) => tenth(orbitOf(r.sat)?.apogeeKm),
  },
  {
    header: 'Orbit stale',
    kind: 'boolean',
    width: 8,
    derived: true,
    source: 'isOrbitStale() in src/lib/starlink.ts, vs snapshot time',
    description:
      'TRUE when the current orbit is more than 14 days older than the snapshot; such altitudes are left out of the tab\'s medians. FALSE when there is no orbit.',
    value: (r) => isOrbitStale(r.sat, r.asOf),
  },
  {
    header: 'Age (days)',
    kind: 'integer',
    width: 8,
    derived: true,
    source: 'ageDays() in src/lib/starlink.ts, vs snapshot time',
    description: 'Whole days from launch to the snapshot time (not the export time), for reentered satellites too.',
    value: (r) => ageDays(r.sat, r.asOf),
  },
  {
    header: 'Lifetime (days)',
    kind: 'integer',
    width: 8,
    derived: true,
    source: 'lifetimeDays() in src/lib/starlink.ts',
    description: 'Whole days from launch to reentry; blank while in orbit.',
    value: (r) => lifetimeDays(r.sat),
  },
  {
    header: 'Launch group',
    kind: 'text',
    width: 14,
    derived: true,
    source: 'launchGroup() in src/lib/starlink.ts',
    description: 'Payload name without its satellite number, e.g. Group 15-14; falls back to COSPAR launch.',
    value: (r) => launchGroup(r.sat),
  },
  {
    header: 'FCC out of service',
    kind: 'text',
    width: 14,
    derived: true,
    source: 'fccOutOfService() in src/lib/starlink.ts',
    description:
      "From GCAT Type byte 9: manoeuvrable or not manoeuvrable when SpaceX's semi-annual FCC report listed the satellite as out of service; blank otherwise.",
    value: (r) => fccOutOfService(r.sat),
  },
  {
    header: 'LL2 launch ID',
    kind: 'text',
    width: 12,
    derived: true,
    source: 'launchFor()?.id in src/lib/starlink.ts',
    description:
      'Launch Library 2 launch that carried the satellite, joined on COSPAR launch; joins to Launch ID in the launch workbook. Blank when no LL2 launch matches.',
    value: (r) => r.launch?.id,
  },
  {
    header: 'LL2 launch name',
    kind: 'text',
    width: 36,
    derived: true,
    source: 'launchFor()?.name in src/lib/starlink.ts',
    description: 'Name of that LL2 launch, e.g. Falcon 9 Block 5 | Starlink Group 15-14.',
    value: (r) => r.launch?.name,
  },
]

/* ------------------------------- Versions --------------------------------- */

const BREAKDOWN = 'versionBreakdown() in src/lib/starlinkStats.ts'

export const VERSION_COLUMNS: SheetColumnSpec<VersionRow>[] = [
  {
    header: 'Version',
    kind: 'text',
    width: 18,
    derived: true,
    source: `${BREAKDOWN}: version`,
    description: 'Hardware version, as in Version (derived) on Satellites. Oldest first.',
    value: (r) => r.version,
  },
  {
    header: 'Launched',
    kind: 'integer',
    width: 10,
    derived: true,
    source: `${BREAKDOWN}: launched`,
    description: 'Satellites of this version launched, including launch failures and reentered ones.',
    value: (r) => r.launched,
  },
  {
    header: 'In orbit',
    kind: 'integer',
    width: 10,
    derived: true,
    source: `${BREAKDOWN}: inOrbit`,
    description: 'Of those, still in orbit (no reentry date).',
    value: (r) => r.inOrbit,
  },
  {
    header: 'Working',
    kind: 'integer',
    width: 10,
    derived: true,
    source: `${BREAKDOWN}: working`,
    description: 'In orbit and Working (derived) on Satellites.',
    value: (r) => r.working,
  },
  {
    header: 'Operational',
    kind: 'integer',
    width: 11,
    derived: true,
    source: `${BREAKDOWN}: operational`,
    description: 'In orbit and In operational shell (derived) on Satellites.',
    value: (r) => r.operational,
  },
  {
    header: 'Reentered',
    kind: 'integer',
    width: 10,
    derived: true,
    source: `${BREAKDOWN}: reentered`,
    description: 'Reentered, including launch failures.',
    value: (r) => r.reentered,
  },
]

/* --------------------------- field coverage -------------------------------- */

/**
 * Compile-time proof that the Satellites sheet covers every field of
 * Satellite, as LAUNCH_FIELDS does for Launch: adding a field to types.ts
 * fails `tsc` here until someone decides which column exports it.
 * scripts/verify-starlink-export.mjs then checks each header exists and that
 * the column really reads that field.
 */
export const SATELLITE_FIELDS = {
  jcat: 'GCAT ID',
  norad: 'NORAD',
  piece: 'COSPAR ID',
  launchTag: 'COSPAR launch',
  name: 'Name',
  plName: 'Payload name',
  program: 'GCAT program',
  bus: 'GCAT bus',
  plane: 'GCAT plane',
  type: 'GCAT type code',
  active: 'GCAT active flag',
  launchDate: 'Launch date (UTC)',
  launchDateApprox: 'Launch date approximate',
  decayDate: 'Reentry date (UTC)',
  decayDateApprox: 'Reentry date approximate',
  endOfOps: 'End of operations (UTC)',
  massKg: 'Mass (kg)',
  perigeeKm: 'Perigee (km)',
  apogeeKm: 'Apogee (km)',
  incDeg: 'Inclination (deg)',
  periodMin: 'Period (min)',
  orbitDate: 'Orbit date (UTC)',
  gpEpoch: 'GP epoch (UTC)',
  gpMeanMotion: 'GP mean motion (rev/day)',
  gpEccentricity: 'GP eccentricity',
} satisfies Record<keyof Satellite, string>
