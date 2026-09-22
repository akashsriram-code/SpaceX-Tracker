#!/usr/bin/env node
/**
 * Builds the static launch snapshot the dashboard reads at runtime.
 *
 * WHY A BUILD-TIME SNAPSHOT INSTEAD OF CLIENT-SIDE FETCHING
 * ---------------------------------------------------------
 * The dashboard was originally specced against the r-spacex SpaceX-API
 * (api.spacexdata.com). That project was archived on 2026-06-06 and its
 * origin now fails the Cloudflare TLS handshake (HTTP 525) on every
 * endpoint, so it cannot be used at all.
 *
 * Its upstream, Launch Library 2 (The Space Devs), is actively maintained
 * and is what SpaceX-API itself synced from — but anonymous access is
 * capped at 15 requests/hour per IP. A public GitHub Pages dashboard that
 * fetched LL2 from each visitor's browser would exhaust that budget after a
 * handful of page views and then serve errors to everyone else. LL2's own
 * guidance is to run a scheduled job that caches the data and serve visitors
 * from your own copy.
 *
 * So: this script runs in CI (scheduled + on push), pages through LL2 once,
 * slims each record (a single detailed LL2 launch is ~49 KB — 530 of those
 * is far too much to commit or ship), and writes public/data/*.json. The app
 * then loads a static file from its own origin: no rate limit, no API key in
 * the client, instant cold loads, and it keeps working if LL2 is briefly down.
 *
 * This script stays intentionally free of business logic. It only flattens
 * and nulls-guards the upstream shape; Starlink detection, customer
 * attribution and all KPI math live in src/lib so each rule has exactly one
 * implementation.
 *
 * Usage:
 *   node scripts/fetch-data.mjs           # production LL2 (ll.thespacedevs.com)
 *   node scripts/fetch-data.mjs --dev     # dev mirror, generous limits, may lag
 *
 * Env:
 *   LL2_API_TOKEN   optional LL2 token for a higher rate limit
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'data')

const USE_DEV = process.argv.includes('--dev')
const HOST = USE_DEV ? 'https://lldev.thespacedevs.com' : 'https://ll.thespacedevs.com'

/**
 * SpaceX's launch_service_provider id in LL2.
 *
 * The filter param is `lsp__id`, NOT `launch_service_provider__id`. LL2 is
 * Django-REST-Framework based and silently ignores unrecognised query
 * params, so the wrong name returns the *entire unfiltered* launch list with
 * a plausible-looking count. That shipped 530 records containing Long March,
 * Soyuz, PSLV, New Glenn and Electron flights before validation caught it —
 * hence the hard provider assertion in main().
 */
const SPACEX_LSP_ID = 121
const SPACEX_LSP_PARAM = 'lsp__id'
const PAGE_SIZE = 100
/** Spacing between requests, to stay comfortably inside LL2's budget. */
const REQUEST_SPACING_MS = 2_000
const MAX_RETRIES = 4

const USER_AGENT =
  'spacex-tracker/1.0 (+https://github.com/; static dashboard build script)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchJson(url, attempt = 1) {
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (process.env.LL2_API_TOKEN) {
    headers.Authorization = `Token ${process.env.LL2_API_TOKEN}`
  }

  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) })
  } catch (err) {
    if (attempt > MAX_RETRIES) throw err
    const backoff = 2_000 * 2 ** (attempt - 1)
    console.warn(`  ! network error (${err.message}); retry ${attempt}/${MAX_RETRIES} in ${backoff}ms`)
    await sleep(backoff)
    return fetchJson(url, attempt + 1)
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt > MAX_RETRIES) {
      throw new Error(`${res.status} ${res.statusText} after ${MAX_RETRIES} retries: ${url}`)
    }
    // Honour Retry-After when LL2 sends it, otherwise exponential backoff.
    const retryAfter = Number(res.headers.get('retry-after'))
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : 5_000 * 2 ** (attempt - 1)
    console.warn(`  ! HTTP ${res.status}; retry ${attempt}/${MAX_RETRIES} in ${backoff}ms`)
    await sleep(backoff)
    return fetchJson(url, attempt + 1)
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`)
  }

  return res.json()
}

/* ------------------------------ normalization ------------------------------ */

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v) => (typeof v === 'boolean' ? v : null)

function normalizeBooster(stage) {
  const launcher = stage?.launcher ?? {}
  const landing = stage?.landing ?? {}
  return {
    serial: str(launcher.serial_number),
    flightNumber: num(stage?.launcher_flight_number),
    totalFlights: num(launcher.flights),
    reused: bool(stage?.reused),
    landingAttempt: bool(landing.attempt),
    landingSuccess: bool(landing.success),
    landingType: str(landing.type?.name),
    // NOTE: LL2 calls this `landing_location`, not `location`.
    landingLocation: str(landing.landing_location?.name),
    turnAroundTimeDays: parseTurnaroundDays(stage?.turn_around_time),
    previousFlightDate: str(stage?.previous_flight_date),
  }
}

/**
 * LL2 returns turnaround as an ISO-8601 duration-ish string
 * (e.g. "P23DT4H51M") or occasionally a plain day count. We only surface
 * whole days, which is the granularity that reads meaningfully in the UI.
 */
function parseTurnaroundDays(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value !== 'string') return null
  const m = value.match(/P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?/)
  if (!m) return null
  const [, y, mo, d] = m
  const days = Number(y ?? 0) * 365 + Number(mo ?? 0) * 30 + Number(d ?? 0)
  return days > 0 ? days : null
}

function normalizePayload(p) {
  return {
    name: str(p?.name),
    massKg: num(p?.mass_kg),
    orbit: str(p?.orbit?.name),
    manufacturer: str(p?.manufacturer?.name),
    customers: Array.isArray(p?.customers)
      ? p.customers.map((c) => (typeof c === 'string' ? c : str(c?.name))).filter(Boolean)
      : [],
  }
}

function normalizeLinks(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((l) => ({
      url: str(l?.url),
      title: str(l?.title),
      source: str(l?.source),
      type: str(l?.type?.name),
    }))
    .filter((l) => l.url)
}

function dedupeByUrl(links) {
  const seen = new Set()
  const out = []
  for (const l of links) {
    if (seen.has(l.url)) continue
    seen.add(l.url)
    out.push(l)
  }
  return out
}

function normalizeLaunch(raw) {
  const rocket = raw?.rocket ?? {}
  const config = rocket.configuration ?? {}
  const mission = raw?.mission ?? {}
  const pad = raw?.pad ?? {}

  // LL2 can return several patches; lower `priority` wins in their data,
  // falling back to whatever is first.
  const patches = Array.isArray(raw?.mission_patches) ? [...raw.mission_patches] : []
  patches.sort((a, b) => (num(a?.priority) ?? 999) - (num(b?.priority) ?? 999))

  return {
    id: String(raw?.id ?? ''),
    slug: str(raw?.slug),
    name: str(raw?.name) ?? 'Unnamed launch',
    missionName: str(mission.name),
    missionDescription: str(mission.description),
    missionType: str(mission.type),

    net: str(raw?.net) ?? '',
    netPrecision: str(raw?.net_precision?.name) ?? str(raw?.net_precision),
    windowStart: str(raw?.window_start),
    windowEnd: str(raw?.window_end),

    status: {
      id: num(raw?.status?.id) ?? 0,
      name: str(raw?.status?.name) ?? 'Unknown',
      abbrev: str(raw?.status?.abbrev) ?? '—',
    },
    failReason: str(raw?.failreason),

    rocketName: str(config.name),
    rocketFullName: str(config.full_name),
    rocketVariant: str(config.variant),
    rocketWikiUrl: str(config.wiki_url),

    boosters: Array.isArray(rocket.launcher_stage)
      ? rocket.launcher_stage.map(normalizeBooster)
      : [],
    payloads: Array.isArray(rocket.payloads) ? rocket.payloads.map(normalizePayload) : [],

    orbitName: str(mission.orbit?.name),
    orbitAbbrev: str(mission.orbit?.abbrev),

    padName: str(pad.name),
    padLocation: str(pad.location?.name),
    padWikiUrl: str(pad.wiki_url),

    agencies: Array.isArray(mission.agencies)
      ? mission.agencies
          .map((a) => ({
            name: str(a?.name),
            abbrev: str(a?.abbrev),
            type: str(a?.type?.name) ?? str(a?.type),
          }))
          .filter((a) => a.name)
      : [],
    lspName: str(raw?.launch_service_provider?.name),

    patchUrl: str(patches[0]?.image_url),
    imageUrl: str(raw?.image?.image_url) ?? str(raw?.image),
    // Merge launch-level and mission-level media; LL2 populates either.
    vidUrls: dedupeByUrl([
      ...normalizeLinks(raw?.vid_urls),
      ...normalizeLinks(mission.vid_urls),
    ]),
    infoUrls: dedupeByUrl([
      ...normalizeLinks(raw?.info_urls),
      ...normalizeLinks(mission.info_urls),
    ]),

    probability: num(raw?.probability),
    weatherConcerns: str(raw?.weather_concerns),
    padLaunchAttemptCount: num(raw?.pad_launch_attempt_count),
  }
}

/**
 * Fail the build if anything that isn't a SpaceX launch made it in.
 *
 * This exists because the provider filter can silently stop filtering (see
 * SPACEX_LSP_PARAM above) and the result still *looks* like a valid launch
 * feed — the dashboard would just quietly show Long March and Soyuz flights
 * as SpaceX missions. Cheap assertion, catches a whole class of regression.
 */
function assertAllSpaceX(launches) {
  const foreign = launches.filter((l) => (l.lspName ?? '').toLowerCase() !== 'spacex')
  if (foreign.length === 0) return

  const sample = foreign.slice(0, 8).map((l) => `${l.lspName} — ${l.name}`)
  throw new Error(
    `${foreign.length}/${launches.length} records are not SpaceX launches. ` +
      `The provider filter is not being applied — check that LL2 still ` +
      `honours "${SPACEX_LSP_PARAM}".\n  ` +
      sample.join('\n  '),
  )
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  console.log('='.repeat(64))
  console.log('SpaceX launch snapshot builder')
  console.log(`  host: ${HOST}${USE_DEV ? '  (dev mirror — data may lag production)' : ''}`)
  console.log(`  auth: ${process.env.LL2_API_TOKEN ? 'token supplied' : 'anonymous (15 req/hr)'}`)
  console.log('='.repeat(64))

  const first =
    `${HOST}/2.3.0/launches/?${SPACEX_LSP_PARAM}=${SPACEX_LSP_ID}` +
    `&mode=detailed&limit=${PAGE_SIZE}&ordering=-net`

  const launches = []
  let url = first
  let upstreamCount = 0
  let page = 0

  while (url) {
    page += 1
    console.log(`\nPage ${page}: fetching…`)
    const data = await fetchJson(url)

    if (page === 1) {
      upstreamCount = num(data?.count) ?? 0
      console.log(`  upstream reports ${upstreamCount} SpaceX launches`)
    }

    const results = Array.isArray(data?.results) ? data.results : []
    for (const raw of results) {
      const normalized = normalizeLaunch(raw)
      // A record with no id or no NET is unusable downstream (can't key it,
      // can't place it on a timeline) — drop rather than ship a broken row.
      if (!normalized.id || !normalized.net) {
        console.warn(`  ! skipping record missing id/net: ${normalized.name}`)
        continue
      }
      launches.push(normalized)
    }
    console.log(`  +${results.length} (total ${launches.length})`)

    url = str(data?.next)
    if (url) await sleep(REQUEST_SPACING_MS)
  }

  // Newest first; undated last (defensive — NET-less records are dropped above).
  launches.sort((a, b) => (b.net ?? '').localeCompare(a.net ?? ''))

  if (upstreamCount && launches.length < upstreamCount * 0.9) {
    // Writing a badly truncated snapshot over a good one would silently gut
    // the dashboard, so fail the build instead of shipping partial data.
    throw new Error(
      `Fetched only ${launches.length} of ${upstreamCount} launches (<90%). ` +
        `Refusing to overwrite the snapshot with likely-truncated data.`,
    )
  }

  assertAllSpaceX(launches)

  const meta = {
    generatedAt: new Date().toISOString(),
    source: `${HOST}/2.3.0/launches/`,
    sourceNote:
      'Launch Library 2 by The Space Devs. Snapshotted at build time because ' +
      'anonymous LL2 access is limited to 15 requests/hour, which cannot support ' +
      'per-visitor fetching. The legacy r-spacex SpaceX-API was archived 2026-06-06 ' +
      'and its origin no longer responds.',
    launchCount: launches.length,
    upstreamCount,
  }

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(resolve(OUT_DIR, 'launches.json'), JSON.stringify(launches), 'utf8')
  await writeFile(resolve(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8')

  const bytes = Buffer.byteLength(JSON.stringify(launches))
  console.log('\n' + '='.repeat(64))
  console.log(`Wrote ${launches.length} launches (${(bytes / 1024).toFixed(0)} KB) to public/data/`)
  console.log(`Generated at ${meta.generatedAt}`)
  console.log('='.repeat(64))
}

main().catch((err) => {
  console.error('\nFATAL:', err.message)
  process.exit(1)
})
