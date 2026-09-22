/**
 * All interpretation of a launch record lives here — Starlink detection,
 * customer attribution, outcome collapsing, and the upcoming/past split.
 *
 * Kept separate from the fetch script on purpose: the script only reshapes
 * the upstream payload, so every rule below has exactly one implementation
 * and can be reasoned about (and corrected) in one place.
 */

import { LaunchStatusId, type Launch, type Outcome } from './types'

/* ------------------------------ Starlink ---------------------------------- */

const STARLINK_RE = /starlink/i

/**
 * Is this a Starlink constellation launch?
 *
 * Checks the mission name, the full LL2 launch name (which is
 * "<rocket> | <mission>", so it catches records where `mission` is null),
 * and any payload names. Derived at render time rather than baked into the
 * snapshot so the rule can be changed without a data refresh.
 *
 * Note this intentionally matches only the Starlink constellation itself.
 * Rideshare missions that *carry* Starlink sats alongside customer payloads
 * are rare, and Transporter/Bandwagon rideshares are correctly excluded.
 */
export function isStarlinkMission(launch: Launch): boolean {
  if (launch.missionName && STARLINK_RE.test(launch.missionName)) return true
  if (STARLINK_RE.test(launch.name)) return true
  return launch.payloads.some((p) => p.name != null && STARLINK_RE.test(p.name))
}

/* ------------------------------ outcome ----------------------------------- */

export function outcomeOf(launch: Launch): Outcome {
  switch (launch.status.id) {
    case LaunchStatusId.Success:
      return 'success'
    case LaunchStatusId.Failure:
      return 'failure'
    case LaunchStatusId.PartialFailure:
      return 'partial'
    default:
      return 'pending'
  }
}

/** Has this launch reached a terminal outcome (i.e. counts toward success rate)? */
export function isConcluded(launch: Launch): boolean {
  return outcomeOf(launch) !== 'pending'
}

/**
 * Upcoming = not yet concluded. We key off status rather than comparing NET
 * to the clock: a launch that slipped keeps a past NET while still being
 * upcoming, and one mid-ascent ("In Flight") is neither past nor pending in
 * the usual sense. Status is what LL2 actually maintains.
 */
export function isUpcoming(launch: Launch): boolean {
  return !isConcluded(launch)
}

/* ------------------------------ customers --------------------------------- */

/**
 * Who is this launch *for*?
 *
 * LL2 has no direct equivalent of the old SpaceX-API `payload.customers`
 * array, so this is a best-effort attribution from the signals it does
 * expose, in descending order of reliability:
 *
 *   1. explicit payload customers (rarely populated — 16/860 launches)
 *   2. Starlink, which is SpaceX flying its own constellation
 *   3. mission agencies — real upstream data, so it outranks our guesses
 *   4. well-known mission-name patterns, as a fallback when 3 is empty
 *   5. "Undisclosed"
 *
 * Agencies deliberately beat the name patterns: LL2 tracks operator renames
 * that hardcoded regexes miss. Amazon's constellation is a live example —
 * LL2 now reports the agency as "Amazon Leo" while a name-pattern guess
 * would still label it "Kuiper".
 *
 * Returns a display label, not an authoritative contract party — the UI
 * labels it "derived" so it is never mistaken for source data.
 */
export function customersOf(launch: Launch): string[] {
  const explicit = launch.payloads.flatMap((p) => p.customers)
  if (explicit.length) return unique(explicit)

  // Starlink is SpaceX flying its own constellation; agency data would just
  // say "SpaceX" anyway, and this keeps the internal/commercial split clean.
  if (isStarlinkMission(launch)) return ['SpaceX (Starlink)']

  // Contract programs where the mission designator *is* the customer.
  // These outrank agency data because LL2 lists every participating agency:
  // Crew-13 reports the Canadian Space Agency (whose astronaut is aboard),
  // but the mission is flown under NASA's Commercial Crew contract.
  const fromProgram = matchRules(launch, PROGRAM_RULES)
  if (fromProgram) return [fromProgram]

  const agencies = launch.agencies
    .map((a) => a.name)
    // The launch provider is not a customer unless it's flying its own payload.
    .filter((n) => n.toLowerCase() !== 'spacex')
  if (agencies.length) return unique(agencies)

  const fromName = matchRules(launch, OPERATOR_RULES)
  if (fromName) return [fromName]

  if (launch.agencies.some((a) => a.name.toLowerCase() === 'spacex')) {
    return ['SpaceX (Internal)']
  }
  return ['Undisclosed']
}

/** Primary customer label for compact display on a card. */
export function primaryCustomer(launch: Launch): string {
  return customersOf(launch)[0] ?? 'Undisclosed'
}

/**
 * Contract-program rules, checked BEFORE agency data. A mission flying under
 * one of these programs has that program's sponsor as its customer
 * regardless of which other agencies participate.
 */
const PROGRAM_RULES: Array<[RegExp, string]> = [
  [/\baxiom|\bax-\d/i, 'Axiom Space'],
  [/\bcrew-\d+|\bcrew dragon|\bdemo-\d/i, 'NASA / Commercial Crew'],
  [/\bcrs[- ]?\d*|\bcargo dragon|\bresupply/i, 'NASA (CRS)'],
  [/\bussf[- ]?\d+|\bgps ?iii|\bspace force|\botv-\d|\bx-37/i, 'US Space Force'],
  [/\bnrol[- ]?\d+/i, 'NRO'],
  [/\btransporter[- ]?\d+/i, 'Rideshare (Transporter)'],
  [/\bbandwagon[- ]?\d+/i, 'Rideshare (Bandwagon)'],
  [/\bstarship|\bsn\d+|\bift-\d|\bflight \d+/i, 'SpaceX (Starship Test)'],
]

/**
 * Satellite-operator heuristics, used only when LL2 has no agency data.
 * Most specific first.
 */
const OPERATOR_RULES: Array<[RegExp, string]> = [
  [/\boneweb/i, 'OneWeb'],
  [/\beutelsat|\bhotbird/i, 'Eutelsat'],
  [/\bintelsat/i, 'Intelsat'],
  [/\bses[- ]?\d+|\bo3b/i, 'SES'],
  [/\biridium/i, 'Iridium'],
  [/\bglobalstar/i, 'Globalstar'],
  [/\bviasat/i, 'Viasat'],
  // Amazon's constellation has been rebranded Kuiper -> Amazon Leo; match
  // both since older mission names keep the original wording.
  [/\bamazon leo|\bamazon|\bkuiper/i, 'Amazon Leo'],
  [/\bkorea|\bkompsat|\banasis/i, 'Republic of Korea'],
  [/\bnasa|\btess\b|\bdart\b|\bimap\b|\bpace\b|\bsphereX/i, 'NASA'],
  [/\besa\b|\beuclid|\bhera\b/i, 'ESA'],
  [/\bnoaa|\bgoes|\bjpss/i, 'NOAA'],
  [/\bmaxar|\bworldview/i, 'Maxar'],
  [/\bplanet labs|\bskysat/i, 'Planet Labs'],
  [/\bintuitive machines|\bim-\d/i, 'Intuitive Machines'],
  [/\bispace|\bhakuto/i, 'ispace'],
  [/\bfirefly|\bblue ghost/i, 'Firefly Aerospace'],
  [/\bastrobotic|\bgriffin/i, 'Astrobotic'],
  [/\bspainsat|\bamazonas/i, 'Hisdesat / Hispasat'],
  [/\bturksat/i, 'Türksat'],
  [/\bnilesat|\begyptsat/i, 'Nilesat'],
  [/\barabsat|\bbadr/i, 'Arabsat'],
  [/\bthaicom/i, 'Thaicom'],
  // `jsat` (not just `jcsat`) — LL2 names these "JSAT-31", which the
  // narrower pattern missed entirely.
  [/\bjsat|\bjcsat|\bsuperbird/i, 'SKY Perfect JSAT'],
  [/\bsirius ?xm|\bsxm[- ]?\d/i, 'SiriusXM'],
  [/\bechostar/i, 'EchoStar'],
  [/\basiasat/i, 'AsiaSat'],
  [/\borbcomm/i, 'Orbcomm'],
  [/\bskynet ?6/i, 'UK Ministry of Defence'],
  [/\bsicral/i, 'Italian Ministry of Defence'],
  [/\boptus/i, 'Optus'],
  [/\btelkom|\bmerah putih/i, 'Telkom Indonesia'],
  [/\bastra ?\d|\bastranis/i, 'Astranis'],
  [/\bbluebird|\bast space/i, 'AST SpaceMobile'],
  [/\bpolaris|\binspiration4/i, 'Private (Polaris / Inspiration4)'],
  [/\broadster|\btesla/i, 'SpaceX (Demo)'],
]

function matchRules(launch: Launch, rules: Array<[RegExp, string]>): string | null {
  const haystack = `${launch.missionName ?? ''} ${launch.name}`
  for (const [re, label] of rules) {
    if (re.test(haystack)) return label
  }
  return null
}

/**
 * Coarse bucket used by the analytics view, so the customer chart doesn't
 * fragment into 80 one-off satellite operators.
 */
export type CustomerSegment =
  | 'Starlink'
  | 'NASA'
  | 'US Military'
  | 'Commercial'
  | 'International / Government'
  | 'SpaceX Internal'

/**
 * Agencies write their names out in full, so substring matching has to use
 * the expanded form: "National Reconnaissance Office" contains no "nro",
 * and "Space Development Agency" contains no "military". Matching on the
 * short forms alone silently dumped every NROL and SDA flight into
 * "International / Government".
 */
const US_MILITARY_RE =
  /space force|ussf|\bnro\b|nrol|national reconnaissance|space development agency|space systems command|missile defense|air force|\bnavy\b|\barmy\b|\bdod\b|defense advanced/i

// JPL is a NASA centre, not a separate international agency.
const NASA_RE = /\bnasa\b|national aeronautics|jet propulsion/i

export function customerSegment(launch: Launch): CustomerSegment {
  if (isStarlinkMission(launch)) return 'Starlink'

  const label = primaryCustomer(launch)
  // US military before NASA: some NRO/SDA payloads name NASA facilities.
  if (US_MILITARY_RE.test(label)) return 'US Military'
  if (NASA_RE.test(label)) return 'NASA'
  if (/spacex/i.test(label)) return 'SpaceX Internal'

  // Only treat a *non-US* government agency as international. Checking the
  // agency `type` alone would sweep up domestic government customers.
  const isGovernment = launch.agencies.some((a) =>
    (a.type ?? '').toLowerCase().includes('government'),
  )
  if (isGovernment && !/united states|\bu\.?s\.?\b/i.test(label)) {
    return 'International / Government'
  }
  if (
    /republic|korea|\besa\b|european space|noaa|türksat|turksat|nilesat|arabsat|hisdesat|hispasat|thaicom|jaxa|isro|indian space|italian|german|french|uae|saudi|qatar|israel/i.test(
      label,
    )
  ) {
    return 'International / Government'
  }
  return 'Commercial'
}

/* ------------------------------ boosters ---------------------------------- */

/** Did any booster on this flight touch down successfully? */
export function hasSuccessfulLanding(launch: Launch): boolean {
  return launch.boosters.some((b) => b.landingSuccess === true)
}

export function landingAttempted(launch: Launch): boolean {
  return launch.boosters.some((b) => b.landingAttempt === true)
}

/** Flew on a previously-used booster. */
export function isReflight(launch: Launch): boolean {
  return launch.boosters.some((b) => b.reused === true)
}

/**
 * LL2 uses placeholder serials like "Unknown F9" / "Unknown Falcon 9" for
 * cores it can't identify. Those carry no information, so treat them as
 * absent rather than rendering a meaningless badge.
 */
export function hasKnownSerial(serial: string | null): boolean {
  return serial != null && !/unknown/i.test(serial)
}

/**
 * Display label for a booster, e.g. "B1062.18" — serial plus the flight
 * count for that core, matching the community convention.
 */
export function boosterLabel(serial: string | null, flightNumber: number | null): string {
  if (!hasKnownSerial(serial)) return 'Unidentified core'
  if (flightNumber == null) return serial as string
  return `${serial}.${flightNumber}`
}

/* -------------------------------- misc ------------------------------------ */

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

export function launchYear(launch: Launch): number | null {
  const y = Number(launch.net.slice(0, 4))
  return Number.isFinite(y) && y > 1990 ? y : null
}

/**
 * Is `net` precise enough to justify a ticking second-level countdown?
 * LL2 marks far-future missions as Day/Month/Quarter/Year precision, where a
 * T-minus to the second would imply certainty that does not exist.
 */
export function hasPreciseNet(launch: Launch): boolean {
  const p = (launch.netPrecision ?? '').toLowerCase()
  if (!p) return true // LL2 omits precision on well-defined near-term launches
  return p.includes('minute') || p.includes('second') || p.includes('hour')
}
