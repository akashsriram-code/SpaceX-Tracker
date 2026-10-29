/**
 * Column definitions for the spreadsheet export: which field lands in which
 * column, under what header, as what type.
 *
 * This file only MAPS fields to columns. Every "(derived)" column must be a
 * plain call into src/lib/launch.ts with no logic of its own — if a derived
 * value needs a new rule, the rule goes in launch.ts so the dashboard and the
 * spreadsheet can never disagree about, say, what counts as a Starlink
 * flight.
 *
 * Deliberately free of any spreadsheet library, DOM or React import: the
 * same definitions build the file in the browser and are checked under tsx
 * by scripts/verify-export.mjs.
 */

import {
  boosterLabel,
  customerSegment,
  customersOf,
  hasKnownSerial,
  hasPreciseNet,
  hasSuccessfulLanding,
  isReflight,
  isStarlinkMission,
  isUpcoming,
  landingAttempted,
  launchYear,
  outcomeOf,
  primaryCustomer,
} from '../launch'
import type {
  Agency,
  Booster,
  Launch,
  LaunchPayload,
  LaunchStatus,
  MediaLink,
} from '../types'

/**
 * How a column is written. Chosen per column, never guessed from the value:
 * guessing would turn a numeric-looking serial into a number, or a null
 * landing flag into FALSE.
 */
export type ColumnKind = 'text' | 'url' | 'integer' | 'number' | 'boolean' | 'datetime'

/** What a column's `value` may return. Datetimes are ISO strings here. */
export type RawValue = string | number | boolean | null | undefined

/** Everything about a column except how to read it from a row. */
export interface ColumnInfo {
  /** Base header. workbook.ts appends " (derived)" when `derived` is set. */
  header: string
  kind: ColumnKind
  /** Approximate width in characters. */
  width: number
  /** Computed by this dashboard's rules rather than supplied by LL2. */
  derived?: true
  /**
   * Where the value comes from, shown on the Columns sheet. Raw fields are a
   * path into the snapshot ("status.name", "boosters[].serial"); derived ones
   * name their launch.ts function.
   */
  source: string
  /** One sentence for the Columns sheet, including any caveats. */
  description: string
}

export interface ColumnSpec<R> extends ColumnInfo {
  value: (row: R) => RawValue
}

/**
 * Joins list values into one cell. Not "/" (customer labels contain it, e.g.
 * "NASA / Commercial Crew") and not "," (agency names can contain it).
 */
export const LIST_SEPARATOR = '; '

/** `null` rather than an empty string, so an empty list is a blank cell. */
function joinList(items: string[]): string | null {
  return items.length ? items.join(LIST_SEPARATOR) : null
}

/* ------------------------------ row types --------------------------------- */

// Each nested array becomes its own sheet, one row per item, carrying its
// parent launch so the shared context columns can read from it. `index` is
// the 0-based position in the source array.

export interface BoosterRow {
  launch: Launch
  booster: Booster
  index: number
}

export interface PayloadRow {
  launch: Launch
  payload: LaunchPayload
  index: number
}

export interface AgencyRow {
  launch: Launch
  agency: Agency
  index: number
}

export interface LinkRow {
  launch: Launch
  link: MediaLink
  /** Which source array the link came from: vidUrls or infoUrls. */
  group: 'Video' | 'Info'
  index: number
}

/* ------------------------------ Launches ---------------------------------- */

export const LAUNCH_COLUMNS: ColumnSpec<Launch>[] = [
  {
    header: 'Launch ID',
    kind: 'text',
    width: 12,
    source: 'id',
    description: 'Launch Library 2 launch UUID, and the join key for every other sheet.',
    value: (l) => l.id,
  },
  {
    header: 'Launch name',
    kind: 'text',
    width: 44,
    source: 'name',
    description: 'Full LL2 launch name, "<rocket> | <mission>".',
    value: (l) => l.name,
  },
  {
    header: 'Mission',
    kind: 'text',
    width: 30,
    source: 'missionName',
    description: 'Mission name.',
    value: (l) => l.missionName,
  },
  {
    header: 'NET (UTC)',
    kind: 'datetime',
    width: 19,
    source: 'net',
    description:
      'No Earlier Than date-time in UTC; at coarse NET precision it is a placeholder such as 2029-12-31 00:00:00.',
    value: (l) => l.net,
  },
  {
    header: 'NET precision',
    kind: 'text',
    width: 13,
    source: 'netPrecision',
    description: 'How precise NET is (Second, Minute, Day, Month, Quarter, Year, ...); blank when LL2 omits it.',
    value: (l) => l.netPrecision,
  },
  {
    header: 'NET is precise',
    kind: 'boolean',
    width: 11,
    derived: true,
    source: 'hasPreciseNet() in src/lib/launch.ts',
    description: 'TRUE when NET precision is Second, Minute, Hour or blank; FALSE means NET is a placeholder date.',
    value: (l) => hasPreciseNet(l),
  },
  {
    header: 'Year',
    kind: 'integer',
    width: 8,
    derived: true,
    source: 'launchYear() in src/lib/launch.ts',
    description: 'Calendar year of NET (UTC).',
    value: (l) => launchYear(l),
  },
  {
    header: 'Window start (UTC)',
    kind: 'datetime',
    width: 19,
    source: 'windowStart',
    description: 'Start of the launch window, UTC.',
    value: (l) => l.windowStart,
  },
  {
    header: 'Window end (UTC)',
    kind: 'datetime',
    width: 19,
    source: 'windowEnd',
    description: 'End of the launch window, UTC.',
    value: (l) => l.windowEnd,
  },
  {
    header: 'Status',
    kind: 'text',
    width: 24,
    source: 'status.name',
    description: 'LL2 launch status, e.g. Launch Successful, Go for Launch, To Be Determined.',
    value: (l) => l.status.name,
  },
  {
    header: 'Status abbrev',
    kind: 'text',
    width: 10,
    source: 'status.abbrev',
    description: 'Short form of Status, e.g. Success, Go, TBD.',
    value: (l) => l.status.abbrev,
  },
  {
    header: 'Status ID',
    kind: 'integer',
    width: 9,
    source: 'status.id',
    description:
      'LL2 status id: 1 Go, 2 TBD, 3 Success, 4 Failure, 5 Hold, 6 In Flight, 7 Partial Failure, 8 TBC.',
    value: (l) => l.status.id,
  },
  {
    header: 'Outcome',
    kind: 'text',
    width: 11,
    derived: true,
    source: 'outcomeOf() in src/lib/launch.ts',
    description:
      'Status collapsed to one of four tokens: success, failure, partial or pending (pending = not yet concluded).',
    value: (l) => outcomeOf(l),
  },
  {
    header: 'Upcoming',
    kind: 'boolean',
    width: 11,
    derived: true,
    source: 'isUpcoming() in src/lib/launch.ts',
    description: 'TRUE until the launch reaches a terminal outcome; keyed off status, not the clock.',
    value: (l) => isUpcoming(l),
  },
  {
    header: 'Failure reason',
    kind: 'text',
    width: 40,
    source: 'failReason',
    description: 'Failure explanation; LL2 fills it in only for failures.',
    value: (l) => l.failReason,
  },
  {
    header: 'Rocket',
    kind: 'text',
    width: 14,
    source: 'rocketName',
    description: 'Rocket family, e.g. Falcon 9.',
    value: (l) => l.rocketName,
  },
  {
    header: 'Rocket full name',
    kind: 'text',
    width: 22,
    source: 'rocketFullName',
    description: 'Rocket configuration, e.g. Falcon 9 Block 5.',
    value: (l) => l.rocketFullName,
  },
  {
    header: 'Rocket variant',
    kind: 'text',
    width: 12,
    source: 'rocketVariant',
    description: 'Rocket variant, e.g. Block 5.',
    value: (l) => l.rocketVariant,
  },
  {
    header: 'Starlink',
    kind: 'boolean',
    width: 10,
    derived: true,
    source: 'isStarlinkMission() in src/lib/launch.ts',
    description: 'TRUE for Starlink constellation launches, matched on mission, launch and payload names.',
    value: (l) => isStarlinkMission(l),
  },
  {
    header: 'Customers',
    kind: 'text',
    width: 32,
    derived: true,
    source: 'customersOf() in src/lib/launch.ts',
    description:
      'Inferred customers, joined with "; ". LL2 has no customer field, so treat this as a label, not a contract record.',
    value: (l) => customersOf(l).join(LIST_SEPARATOR),
  },
  {
    header: 'Primary customer',
    kind: 'text',
    width: 26,
    derived: true,
    source: 'primaryCustomer() in src/lib/launch.ts',
    description: 'First inferred customer, as shown on the dashboard cards.',
    value: (l) => primaryCustomer(l),
  },
  {
    header: 'Customer segment',
    kind: 'text',
    width: 24,
    derived: true,
    source: 'customerSegment() in src/lib/launch.ts',
    description: 'Coarse customer bucket used by the Analytics tab, e.g. Starlink, NASA, US Military, Commercial.',
    value: (l) => customerSegment(l),
  },
  {
    header: 'Agencies',
    kind: 'text',
    width: 30,
    source: 'agencies[].name joined with "; "',
    description: 'Mission agency names, joined with "; "; full detail is on the Agencies sheet.',
    value: (l) => joinList(l.agencies.map((a) => a.name)),
  },
  {
    header: 'Mission type',
    kind: 'text',
    width: 18,
    source: 'missionType',
    description: 'Mission type, e.g. Communications, Resupply, Human Exploration.',
    value: (l) => l.missionType,
  },
  {
    header: 'Orbit',
    kind: 'text',
    width: 22,
    source: 'orbitName',
    description: 'Target orbit name.',
    value: (l) => l.orbitName,
  },
  {
    header: 'Orbit abbrev',
    kind: 'text',
    width: 8,
    source: 'orbitAbbrev',
    description: 'Target orbit abbreviation, e.g. LEO, GTO.',
    value: (l) => l.orbitAbbrev,
  },
  {
    header: 'Launch site',
    kind: 'text',
    width: 28,
    source: 'padName',
    description: 'Launch pad name.',
    value: (l) => l.padName,
  },
  {
    header: 'Launch site location',
    kind: 'text',
    width: 30,
    source: 'padLocation',
    description: 'Location of the launch pad.',
    value: (l) => l.padLocation,
  },
  {
    header: 'Pad launch attempt #',
    kind: 'integer',
    width: 10,
    source: 'padLaunchAttemptCount',
    description: 'Nth orbital launch attempt from this pad, per LL2.',
    value: (l) => l.padLaunchAttemptCount,
  },
  {
    header: 'COSPAR launch ID',
    kind: 'text',
    width: 11,
    source: 'launchDesignator',
    description:
      'International designator of the launch, e.g. 2026-160; blank before launch. Satellites from this launch have COSPAR ids starting with it.',
    value: (l) => l.launchDesignator,
  },
  {
    header: 'Launch provider',
    kind: 'text',
    width: 12,
    source: 'lspName',
    description: 'Launch service provider; SpaceX for every row in this dataset.',
    value: (l) => l.lspName,
  },
  {
    header: 'Boosters',
    kind: 'text',
    width: 24,
    derived: true,
    source: 'boosterLabel() in src/lib/launch.ts, per booster',
    description:
      'Booster labels such as B1062.18 (serial.flight), joined with "; "; blank when LL2 lists no boosters.',
    value: (l) => joinList(l.boosters.map((b) => boosterLabel(b.serial, b.flightNumber))),
  },
  {
    header: 'Booster records',
    kind: 'integer',
    width: 9,
    source: 'boosters.length',
    description: 'Number of booster rows for this launch on the Boosters sheet.',
    value: (l) => l.boosters.length,
  },
  {
    header: 'Reflight',
    kind: 'boolean',
    width: 10,
    derived: true,
    source: 'isReflight() in src/lib/launch.ts',
    description: 'TRUE when any booster was reused; FALSE (not blank) when Booster records = 0.',
    value: (l) => isReflight(l),
  },
  {
    header: 'Landing attempted',
    kind: 'boolean',
    width: 12,
    derived: true,
    source: 'landingAttempted() in src/lib/launch.ts',
    description: 'TRUE when any booster attempted a landing; FALSE (not blank) when Booster records = 0.',
    value: (l) => landingAttempted(l),
  },
  {
    header: 'Landing succeeded',
    kind: 'boolean',
    width: 12,
    derived: true,
    source: 'hasSuccessfulLanding() in src/lib/launch.ts',
    description: 'TRUE when any booster landed successfully; FALSE (not blank) when Booster records = 0.',
    value: (l) => hasSuccessfulLanding(l),
  },
  {
    header: 'Payload records',
    kind: 'integer',
    width: 9,
    source: 'payloads.length',
    description: 'Number of payload rows for this launch on the Payloads sheet.',
    value: (l) => l.payloads.length,
  },
  {
    header: 'Weather go (%)',
    kind: 'integer',
    width: 10,
    source: 'probability',
    description: 'Published weather go-probability, 0-100; blank when none was published.',
    value: (l) => l.probability,
  },
  {
    header: 'Weather concerns',
    kind: 'text',
    width: 30,
    source: 'weatherConcerns',
    description: 'Published weather concerns.',
    value: (l) => l.weatherConcerns,
  },
  {
    header: 'Mission description',
    kind: 'text',
    width: 60,
    source: 'missionDescription',
    description: 'LL2 mission description.',
    value: (l) => l.missionDescription,
  },
  {
    header: 'Slug',
    kind: 'text',
    width: 30,
    source: 'slug',
    description: 'LL2 URL slug for the launch.',
    value: (l) => l.slug,
  },
  {
    header: 'Mission patch URL',
    kind: 'url',
    width: 30,
    source: 'patchUrl',
    description: 'Mission patch image URL, as plain text.',
    value: (l) => l.patchUrl,
  },
  {
    header: 'Image URL',
    kind: 'url',
    width: 30,
    source: 'imageUrl',
    description: 'Launch image URL, as plain text.',
    value: (l) => l.imageUrl,
  },
  {
    header: 'Rocket wiki URL',
    kind: 'url',
    width: 30,
    source: 'rocketWikiUrl',
    description: 'Wikipedia page for the rocket, as plain text.',
    value: (l) => l.rocketWikiUrl,
  },
  {
    header: 'Launch site wiki URL',
    kind: 'url',
    width: 30,
    source: 'padWikiUrl',
    description: 'Wikipedia page for the launch pad, as plain text.',
    value: (l) => l.padWikiUrl,
  },
  {
    header: 'Video links',
    kind: 'integer',
    width: 8,
    source: 'vidUrls.length',
    description: 'Number of rows for this launch on the Links sheet with Link group = Video.',
    value: (l) => l.vidUrls.length,
  },
  {
    header: 'Info links',
    kind: 'integer',
    width: 8,
    source: 'infoUrls.length',
    description: 'Number of rows for this launch on the Links sheet with Link group = Info.',
    value: (l) => l.infoUrls.length,
  },
]

/* ---------------------------- child sheets -------------------------------- */

/**
 * The parent-launch columns every child sheet starts with, defined once.
 * Launch ID is the join key; name and NET are there so a child sheet is
 * readable on its own without a lookup.
 */
const LAUNCH_CONTEXT: ColumnSpec<{ launch: Launch }>[] = [
  {
    header: 'Launch ID',
    kind: 'text',
    width: 12,
    source: 'id',
    description: 'Parent launch UUID; joins to Launch ID on the Launches sheet.',
    value: (r) => r.launch.id,
  },
  {
    header: 'Launch name',
    kind: 'text',
    width: 40,
    source: 'name',
    description: 'Parent launch name, repeated for readability.',
    value: (r) => r.launch.name,
  },
  {
    header: 'NET (UTC)',
    kind: 'datetime',
    width: 19,
    source: 'net',
    description: 'Parent launch NET in UTC, repeated for readability.',
    value: (r) => r.launch.net,
  },
]

export const BOOSTER_COLUMNS: ColumnSpec<BoosterRow>[] = [
  ...LAUNCH_CONTEXT,
  {
    header: 'Year',
    kind: 'integer',
    width: 8,
    derived: true,
    source: 'launchYear() in src/lib/launch.ts',
    description: 'Calendar year of the parent launch NET (UTC).',
    value: (r) => launchYear(r.launch),
  },
  {
    header: 'Rocket',
    kind: 'text',
    width: 14,
    source: 'rocketName',
    description: 'Parent launch rocket family.',
    value: (r) => r.launch.rocketName,
  },
  {
    header: 'Launch outcome',
    kind: 'text',
    width: 11,
    derived: true,
    source: 'outcomeOf() in src/lib/launch.ts',
    description: 'Parent launch outcome token: success, failure, partial or pending.',
    value: (r) => outcomeOf(r.launch),
  },
  {
    header: 'Booster position',
    kind: 'integer',
    width: 9,
    source: 'boosters[] index + 1',
    description: "Position in LL2's booster list for the launch; it does NOT mean centre or side core.",
    value: (r) => r.index + 1,
  },
  {
    header: 'Serial',
    kind: 'text',
    width: 12,
    source: 'boosters[].serial',
    description: 'Core serial as LL2 reports it, including placeholders such as "Unknown F9".',
    value: (r) => r.booster.serial,
  },
  {
    header: 'Serial known',
    kind: 'boolean',
    width: 11,
    derived: true,
    source: 'hasKnownSerial() in src/lib/launch.ts',
    description: 'FALSE when the serial is blank or an LL2 "Unknown" placeholder.',
    value: (r) => hasKnownSerial(r.booster.serial),
  },
  {
    header: 'Booster label',
    kind: 'text',
    width: 18,
    derived: true,
    source: 'boosterLabel() in src/lib/launch.ts',
    description: 'Serial plus flight number, e.g. B1062.18, or "Unidentified core".',
    value: (r) => boosterLabel(r.booster.serial, r.booster.flightNumber),
  },
  {
    header: 'Core flight #',
    kind: 'integer',
    width: 10,
    source: 'boosters[].flightNumber',
    description: 'Which flight this was for this core.',
    value: (r) => r.booster.flightNumber,
  },
  {
    header: 'Core total flights',
    kind: 'integer',
    width: 10,
    source: 'boosters[].totalFlights',
    description: 'Total flights LL2 attributes to the core at snapshot time.',
    value: (r) => r.booster.totalFlights,
  },
  {
    header: 'Reused',
    kind: 'boolean',
    width: 9,
    source: 'boosters[].reused',
    description: 'Whether the core had flown before; blank = unknown.',
    value: (r) => r.booster.reused,
  },
  {
    header: 'Landing attempted',
    kind: 'boolean',
    width: 11,
    source: 'boosters[].landingAttempt',
    description: 'Whether a landing was attempted; blank = unknown.',
    value: (r) => r.booster.landingAttempt,
  },
  {
    header: 'Landing succeeded',
    kind: 'boolean',
    width: 11,
    source: 'boosters[].landingSuccess',
    description: 'Whether the landing succeeded; blank = pending or not attempted.',
    value: (r) => r.booster.landingSuccess,
  },
  {
    header: 'Landing type',
    kind: 'text',
    width: 30,
    source: 'boosters[].landingType',
    description: 'Landing type, e.g. Autonomous Spaceport Drone Ship, Return to Launch Site.',
    value: (r) => r.booster.landingType,
  },
  {
    header: 'Landing location',
    kind: 'text',
    width: 30,
    source: 'boosters[].landingLocation',
    description: 'Landing zone or droneship name.',
    value: (r) => r.booster.landingLocation,
  },
  {
    header: 'Turnaround (days)',
    kind: 'integer',
    width: 11,
    source: 'boosters[].turnAroundTimeDays',
    description: "Days since this core's previous flight, converted at fetch time from LL2's ISO-8601 duration.",
    value: (r) => r.booster.turnAroundTimeDays,
  },
  {
    header: 'Previous flight (UTC)',
    kind: 'datetime',
    width: 19,
    source: 'boosters[].previousFlightDate',
    description: "Date-time of this core's previous flight, UTC; blank on a first flight.",
    value: (r) => r.booster.previousFlightDate,
  },
]

export const PAYLOAD_COLUMNS: ColumnSpec<PayloadRow>[] = [
  ...LAUNCH_CONTEXT,
  {
    header: 'Payload position',
    kind: 'integer',
    width: 9,
    source: 'payloads[] index + 1',
    description: "Position in LL2's payload list for the launch.",
    value: (r) => r.index + 1,
  },
  {
    header: 'Payload name',
    kind: 'text',
    width: 30,
    source: 'payloads[].name',
    description: 'Payload name.',
    value: (r) => r.payload.name,
  },
  {
    header: 'Mass (kg)',
    kind: 'number',
    width: 11,
    source: 'payloads[].massKg',
    description: 'Payload mass in kilograms; rarely filled in upstream.',
    value: (r) => r.payload.massKg,
  },
  {
    header: 'Orbit',
    kind: 'text',
    width: 22,
    source: 'payloads[].orbit',
    description: 'Payload target orbit.',
    value: (r) => r.payload.orbit,
  },
  {
    header: 'Manufacturer',
    kind: 'text',
    width: 24,
    source: 'payloads[].manufacturer',
    description: 'Payload manufacturer.',
    value: (r) => r.payload.manufacturer,
  },
  {
    header: 'Customers (upstream)',
    kind: 'text',
    width: 30,
    source: 'payloads[].customers joined with "; "',
    description: 'Payload customers exactly as LL2 lists them, not the derived attribution on Launches.',
    value: (r) => joinList(r.payload.customers),
  },
]

export const AGENCY_COLUMNS: ColumnSpec<AgencyRow>[] = [
  ...LAUNCH_CONTEXT,
  {
    header: 'Agency position',
    kind: 'integer',
    width: 9,
    source: 'agencies[] index + 1',
    description: "Position in LL2's mission agency list for the launch.",
    value: (r) => r.index + 1,
  },
  {
    header: 'Agency',
    kind: 'text',
    width: 36,
    source: 'agencies[].name',
    description: 'Agency name.',
    value: (r) => r.agency.name,
  },
  {
    header: 'Abbrev',
    kind: 'text',
    width: 10,
    source: 'agencies[].abbrev',
    description: 'Agency abbreviation.',
    value: (r) => r.agency.abbrev,
  },
  {
    header: 'Agency type',
    kind: 'text',
    width: 16,
    source: 'agencies[].type',
    description: 'Agency type, e.g. Commercial, Government, Educational.',
    value: (r) => r.agency.type,
  },
]

export const LINK_COLUMNS: ColumnSpec<LinkRow>[] = [
  ...LAUNCH_CONTEXT,
  {
    header: 'Link group',
    kind: 'text',
    width: 8,
    source: 'Video for vidUrls[], Info for infoUrls[]',
    description: 'Which LL2 list the link came from: Video (vidUrls) or Info (infoUrls).',
    value: (r) => r.group,
  },
  {
    header: 'Link position',
    kind: 'integer',
    width: 8,
    source: 'vidUrls[] or infoUrls[] index + 1',
    description: 'Position within its Link group for the launch.',
    value: (r) => r.index + 1,
  },
  {
    header: 'URL',
    kind: 'url',
    width: 50,
    source: 'vidUrls[].url, infoUrls[].url',
    description: 'Link URL, as plain text.',
    value: (r) => r.link.url,
  },
  {
    header: 'Title',
    kind: 'text',
    width: 40,
    source: 'vidUrls[].title, infoUrls[].title',
    description: 'Link title.',
    value: (r) => r.link.title,
  },
  {
    header: 'Source',
    kind: 'text',
    width: 18,
    source: 'vidUrls[].source, infoUrls[].source',
    description: 'Link source, e.g. youtube.com.',
    value: (r) => r.link.source,
  },
  {
    header: 'Link type',
    kind: 'text',
    width: 18,
    source: 'vidUrls[].type, infoUrls[].type',
    description: 'LL2 link type, e.g. Official Webcast, Official Page.',
    value: (r) => r.link.type,
  },
]

/* --------------------------- field coverage -------------------------------- */

/**
 * Compile-time proof that the export covers every field in types.ts.
 *
 * Each map is keyed by the type's own fields and names the header that
 * exports the field (or the sheet a nested array is flattened onto). Adding a
 * field to types.ts fails `tsc` here as a missing key; removing one fails as
 * an excess property. So the spreadsheet can't silently fall behind the data
 * model — whoever changes types.ts is made to decide where the field goes.
 * scripts/verify-export.mjs then checks each named header really exists.
 */

export const LAUNCH_FIELDS = {
  id: 'Launch ID',
  slug: 'Slug',
  name: 'Launch name',
  missionName: 'Mission',
  missionDescription: 'Mission description',
  missionType: 'Mission type',
  net: 'NET (UTC)',
  netPrecision: 'NET precision',
  windowStart: 'Window start (UTC)',
  windowEnd: 'Window end (UTC)',
  status: 'Status',
  failReason: 'Failure reason',
  rocketName: 'Rocket',
  rocketFullName: 'Rocket full name',
  rocketVariant: 'Rocket variant',
  rocketWikiUrl: 'Rocket wiki URL',
  boosters: 'Boosters sheet',
  payloads: 'Payloads sheet',
  orbitName: 'Orbit',
  orbitAbbrev: 'Orbit abbrev',
  padName: 'Launch site',
  padLocation: 'Launch site location',
  padWikiUrl: 'Launch site wiki URL',
  agencies: 'Agencies sheet',
  lspName: 'Launch provider',
  patchUrl: 'Mission patch URL',
  imageUrl: 'Image URL',
  vidUrls: 'Links sheet',
  infoUrls: 'Links sheet',
  probability: 'Weather go (%)',
  weatherConcerns: 'Weather concerns',
  padLaunchAttemptCount: 'Pad launch attempt #',
  launchDesignator: 'COSPAR launch ID',
} satisfies Record<keyof Launch, string>

export const STATUS_FIELDS = {
  id: 'Status ID',
  name: 'Status',
  abbrev: 'Status abbrev',
} satisfies Record<keyof LaunchStatus, string>

export const BOOSTER_FIELDS = {
  serial: 'Serial',
  flightNumber: 'Core flight #',
  totalFlights: 'Core total flights',
  reused: 'Reused',
  landingAttempt: 'Landing attempted',
  landingSuccess: 'Landing succeeded',
  landingType: 'Landing type',
  landingLocation: 'Landing location',
  turnAroundTimeDays: 'Turnaround (days)',
  previousFlightDate: 'Previous flight (UTC)',
} satisfies Record<keyof Booster, string>

export const PAYLOAD_FIELDS = {
  name: 'Payload name',
  massKg: 'Mass (kg)',
  orbit: 'Orbit',
  manufacturer: 'Manufacturer',
  customers: 'Customers (upstream)',
} satisfies Record<keyof LaunchPayload, string>

export const AGENCY_FIELDS = {
  name: 'Agency',
  abbrev: 'Abbrev',
  type: 'Agency type',
} satisfies Record<keyof Agency, string>

export const LINK_FIELDS = {
  url: 'URL',
  title: 'Title',
  source: 'Source',
  type: 'Link type',
} satisfies Record<keyof MediaLink, string>

/** The maps above with the sheet whose headers they name, for verify-export. */
export const FIELD_COVERAGE: {
  type: string
  sheet: string
  fields: Record<string, string>
}[] = [
  { type: 'Launch', sheet: 'Launches', fields: LAUNCH_FIELDS },
  { type: 'LaunchStatus', sheet: 'Launches', fields: STATUS_FIELDS },
  { type: 'Booster', sheet: 'Boosters', fields: BOOSTER_FIELDS },
  { type: 'LaunchPayload', sheet: 'Payloads', fields: PAYLOAD_FIELDS },
  { type: 'Agency', sheet: 'Agencies', fields: AGENCY_FIELDS },
  { type: 'MediaLink', sheet: 'Links', fields: LINK_FIELDS },
]
