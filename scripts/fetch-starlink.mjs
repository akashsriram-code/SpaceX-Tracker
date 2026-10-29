#!/usr/bin/env node
/**
 * Builds the static Starlink satellite snapshot the Starlink tab reads.
 *
 * WHY THESE SOURCES
 * -----------------
 * Launch Library 2 (our launch source) has no satellite-level Starlink data at
 * all: /spacecraft, /payloads and /payload_flights return nothing for
 * Starlink, and no Starlink launch in our snapshot lists a payload.
 *
 * - GCAT (Jonathan McDowell, planet4589.org/space/gcat, CC BY 4.0) is the only
 *   free machine-readable catalogue that carries a per-satellite hardware
 *   version (psatcat `Program`, e.g. "Starlink 2MO S3"), keeps reentered
 *   satellites with their reentry dates, and records a Starlink-specific
 *   lifecycle flag (byte 8 of `Type`). Its counts reconcile exactly with
 *   McDowell's published Starlink statistics page.
 * - CelesTrak GP (no auth) supplies current SGP4 element sets: the freshest
 *   altitudes and everything the live map needs to place each satellite.
 *   It has no version, no launch date and no decayed objects, so it is joined
 *   onto GCAT by NORAD number. Always JSON/CSV, never TLE: five-digit catalogue
 *   numbers ran out on 2026-07-11 and new Starlinks have six-digit ones.
 *
 * POLITENESS / POLICY
 * -------------------
 * - GCAT is a one-person site updated about daily, and the four catalogues
 *   total ~43 MB. We hit the network for it at most once per GCAT_GATE_MS and
 *   send conditional requests (If-None-Match) so unchanged files cost a 304.
 * - CelesTrak allows one download of the Starlink group per update (~2 h)
 *   and firewalls IPs that rack up errors. So: one request per run, at most
 *   once per GP_GATE_MS, never retried, and never followed by a SupGP attempt
 *   against the same host. On any non-200 we keep the last good copy.
 * - Raw downloads, ETags and the last good outputs live in .cache/starlink,
 *   which CI persists between runs with actions/cache.
 *
 * Like fetch-data.mjs, this script is dumb transport: it downloads, filters
 * to Starlink rows, joins by GCAT id, trims fields and normalises GCAT's
 * "vague dates" lexically. Version, lifecycle phase, shell, altitude and every
 * other interpretation live in src/lib/starlink.ts.
 *
 * Usage:
 *   node --use-system-ca scripts/fetch-starlink.mjs            # normal run (gated)
 *   node --use-system-ca scripts/fetch-starlink.mjs --force    # ignore the GCAT/GP gates
 *   node --use-system-ca scripts/fetch-starlink.mjs --offline  # rebuild from .cache only
 *
 * `--use-system-ca` makes Node trust the OS certificate store as well as its
 * bundled one, which is what lets this run behind a TLS-inspecting corporate
 * proxy without exporting PEM files. It is harmless on CI.
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'public', 'data')
const CACHE_DIR = resolve(ROOT, '.cache', 'starlink')

const FORCE = process.argv.includes('--force')
const OFFLINE = process.argv.includes('--offline')

const GCAT = 'https://planet4589.org/space/gcat/tsv'
const MCDOWELL = 'https://planet4589.org/space/con/star'
/** celestrak.org, never .com: the .com host answers 301, which CelesTrak counts as an error. */
const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=csv'

/** GCAT updates about daily; checking more often only costs McDowell bandwidth. */
const GCAT_GATE_MS = 20 * 60 * 60 * 1000
/** CelesTrak refreshes GP every 2 h and allows one Starlink-group download per update. */
const GP_GATE_MS = 2 * 60 * 60 * 1000
const REQUEST_SPACING_MS = 1_000

const SOURCES = {
  currentcat: { url: `${GCAT}/derived/currentcat.tsv`, kind: 'tsv' },
  psatcat: { url: `${GCAT}/cat/psatcat.tsv`, kind: 'tsv' },
  psatcat100k: { url: `${GCAT}/cat/psatcat100k.tsv`, kind: 'tsv' },
  satcat: { url: `${GCAT}/cat/satcat.tsv`, kind: 'tsv' },
  satcat100k: { url: `${GCAT}/cat/satcat100k.tsv`, kind: 'tsv' },
  auxcat: { url: `${GCAT}/cat/auxcat.tsv`, kind: 'tsv' },
  stats: { url: `${MCDOWELL}/stats.html`, kind: 'text' },
  log: { url: `${MCDOWELL}/log.dat`, kind: 'text' },
}

/** Columns each TSV must carry. A missing one means GCAT changed its schema. */
const REQUIRED_COLUMNS = {
  currentcat: ['JCAT', 'Satcat', 'Piece', 'Active', 'Type', 'Name', 'LDate', 'Owner', 'DDate', 'ODate', 'Period', 'Perigee', 'Apogee', 'Inc'],
  psatcat: ['JCAT', 'Piece', 'Name', 'TOp', 'Program', 'Plane'],
  psatcat100k: ['JCAT', 'Piece', 'Name', 'TOp', 'Program', 'Plane'],
  satcat: ['JCAT', 'Satcat', 'Launch_Tag', 'Piece', 'Type', 'Name', 'PLName', 'Owner', 'Bus', 'Mass'],
  satcat100k: ['JCAT', 'Satcat', 'Launch_Tag', 'Piece', 'Type', 'Name', 'PLName', 'Owner', 'Bus', 'Mass'],
  auxcat: ['JCAT', 'Satcat', 'Launch_Tag', 'Piece', 'Type', 'Name', 'PLName', 'Owner', 'Bus', 'Mass'],
}

const GP_COLUMNS = [
  'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT',
]

/**
 * Starlink entries that are not real constellation satellites: Starship mass
 * simulators and the two "Dodger Dog" test articles. McDowell's published
 * totals exclude both, and so do we.
 */
const TEST_ARTICLE_BUSES = new Set(['Starlink V3S', 'Starlink V2DD'])

const USER_AGENT =
  'spacex-tracker/1.0 (+https://github.com/; static dashboard build script, fetches at most daily)'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* --------------------------------- cache ---------------------------------- */

const cachePath = (name) => resolve(CACHE_DIR, name)

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function readCachedRaw(name) {
  try {
    return gunzipSync(await readFile(cachePath(`${name}.gz`))).toString('utf8')
  } catch {
    return null
  }
}

async function writeCachedRaw(name, text) {
  await writeFile(cachePath(`${name}.gz`), gzipSync(text))
}

/** Write via a temp file and rename, so a crash never leaves half a snapshot. */
async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/* --------------------------------- network -------------------------------- */

/**
 * Conditional GET. Returns { status: 200, body } or { status: 304 }.
 * `retry` is one retry on a network error only — never on an HTTP status,
 * which for CelesTrak would add to the error count that gets IPs blocked.
 */
async function fetchConditional(url, { etag = null, retry = false } = {}) {
  const headers = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' }
  if (etag) headers['If-None-Match'] = etag

  let res
  let body
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(180_000) })
    // Read the body inside the try: proxies can drop a large transfer
    // mid-stream ("terminated"), which is a network error like any other.
    if (res.status === 200) body = await res.text()
  } catch (err) {
    if (!retry) throw err
    console.warn(`  ! network error (${err.cause?.code ?? err.message}); one retry in 5s`)
    await sleep(5_000)
    return fetchConditional(url, { etag, retry: false })
  }

  if (res.status === 304) return { status: 304, etag }
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}`)
  }

  // A body that stops mid-line is a truncated transfer, not a smaller file.
  if (!body.endsWith('\n') && !url.includes('.html')) {
    throw new Error(`Truncated response (no trailing newline): ${url}`)
  }
  return { status: 200, body, etag: res.headers.get('etag') }
}

/* ------------------------------ normalization ----------------------------- */

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 }

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * GCAT "vague dates": "2020 Oct  1 1300?", "2026 Jul 14 0230:21", "2026 Jul",
 * "2022 Feb  5?", "*", "-". Returns { iso: 'YYYY-MM-DD', approx } or null.
 * Day precision is all the app uses (age, lifetime, per-month charts).
 * `approx` is set for a trailing '?' or a missing day. Lexical only.
 */
function vagueDate(value) {
  if (value == null) return null
  const s = String(value).trim()
  if (!s || s === '-' || s === '*') return null
  const m = s.match(/^(\d{4})(?:\s+([A-Z][a-z]{2}))?(?:\s+(\d{1,2}))?/)
  if (!m) return null
  const [, y, mon, d] = m
  const month = mon ? MONTHS[mon] : null
  if (mon && !month) return null
  return {
    iso: `${y}-${pad2(month ?? 1)}-${pad2(d ? Number(d) : 1)}`,
    approx: s.includes('?') || !d,
  }
}

const str = (v) => {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' || s === '-' ? null : s
}

const num = (v) => {
  const s = str(v)
  if (s == null) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** "Starlink Group 15-14-01" -> "Group 15-14-01". Purely lexical, saves ~9 B per row. */
const stripStarlink = (v) => {
  const s = str(v)
  return s && s.startsWith('Starlink ') ? s.slice('Starlink '.length) : s
}

/**
 * Parse a GCAT TSV. Line 1 is the '#'-prefixed header, line 2 is
 * "# Updated YYYY Mon DD HHMM:SS". Fields are trimmed except `Type`, which is
 * positional (byte 8 is the Starlink lifecycle flag) and must stay intact.
 */
function parseTsv(name, text) {
  const lines = text.split('\n')
  const header = lines[0].replace(/^#/, '').split('\t').map((h) => h.trim())
  const missing = (REQUIRED_COLUMNS[name] ?? []).filter((c) => !header.includes(c))
  if (missing.length) {
    throw new Error(`${name}: GCAT schema changed, missing column(s) ${missing.join(', ')}`)
  }
  const updatedMatch = (lines[1] ?? '').match(/^#\s*Updated\s+(.+?)\s*$/)
  const updated = updatedMatch ? updatedMatch[1] : null

  const typeIdx = header.indexOf('Type')
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.startsWith('#')) continue
    const cells = line.split('\t')
    const row = {}
    for (let c = 0; c < header.length; c++) {
      row[header[c]] = c === typeIdx ? (cells[c] ?? '') : str(cells[c])
    }
    rows.push(row)
  }
  return { header, updated, rows }
}

/** "2026 Oct 29 0118:11" -> ISO, for meta. */
function gcatStampToIso(stamp) {
  const m = stamp?.match(/^(\d{4}) ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2})(\d{2})(?::(\d{2}))?/)
  if (!m || !MONTHS[m[2]]) return null
  const [, y, mon, d, hh, mm, ss] = m
  return `${y}-${pad2(MONTHS[mon])}-${pad2(Number(d))}T${hh}:${mm}:${ss ?? '00'}Z`
}

function parseGpCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const header = lines[0].split(',')
  const missing = GP_COLUMNS.filter((c) => !header.includes(c))
  if (missing.length) throw new Error(`GP CSV missing column(s): ${missing.join(', ')}`)
  const idx = Object.fromEntries(GP_COLUMNS.map((c) => [c, header.indexOf(c)]))
  const rows = []
  for (const line of lines.slice(1)) {
    const cells = line.split(',')
    if (cells.length !== header.length) {
      throw new Error(`GP CSV row has ${cells.length} cells, expected ${header.length}: ${line}`)
    }
    const epoch = cells[idx.EPOCH]
    const numbers = GP_COLUMNS.slice(2).map((c) => Number(cells[idx[c]]))
    const norad = Number(cells[idx.NORAD_CAT_ID])
    if (!Number.isInteger(norad) || !epoch || numbers.some((n) => !Number.isFinite(n))) {
      throw new Error(`GP CSV row has a non-finite SGP4 field: ${line}`)
    }
    rows.push([norad, epoch, ...numbers])
  }
  return rows
}

/**
 * McDowell's stats.html summary table, used only as a reconciliation target.
 * Rows look like "Starlink Gen1 4714 0 114 1335 ... 2379" and "Total 13069 ...".
 * Soft-fail: returns null on any surprise rather than breaking the build.
 */
const REFERENCE_COLUMNS = [
  'launched', 'failedToOrbit', 'earlyDeorbit', 'disposalComplete', 'reentryAfterFail', 'down',
  'inOrbit', 'screened', 'failedDecaying', 'graveyard', 'working', 'disposalUnderway',
  'outOfConstellation', 'anomalous', 'relocating', 'special', 'drift', 'ascent', 'operational',
]

function parseReference(html) {
  try {
    const text = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ')
    const asOf = text.match(/Data last updated:\s*(\d{4} [A-Z][a-z]{2}\s+\d{1,2} \d{4}(?::\d{2})?)/)?.[1] ?? null
    const rows = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      // Label, then exactly 19 counts to end of line. The lazy label lets
      // labels end in a digit ("Starlink V3") without swallowing a count.
      const m = line.match(/^(.+?) ((?:\[?\d+\]? ){18}\[?\d+\]?)$/)
      if (!m) continue
      const values = m[2].split(' ')
      if (values.some((v) => v.startsWith('['))) continue // dummy rows: excluded from totals
      rows.push({ label: m[1].trim(), values: Object.fromEntries(REFERENCE_COLUMNS.map((c, i) => [c, Number(values[i])])) })
      // The summary table ends at its Total row; a per-launch table follows that we don't need.
      if (m[1].trim() === 'Total') break
    }
    const pick = (label) => rows.find((r) => r.label === label)?.values ?? null
    const total = pick('Total')
    if (!total || !Number.isFinite(total.launched)) return null
    return {
      asOf: gcatStampToIso(asOf),
      total,
      gen1: pick('Starlink Gen1'),
      gen2: pick('Starlink Gen2'),
      gen3: pick('Starlink Gen3'),
      rows: rows.filter((r) => !/^(Total|Starlink Gen\dD?)$/.test(r.label)),
    }
  } catch (err) {
    console.warn(`  ! could not parse stats.html reference (${err.message}); skipping`)
    return null
  }
}

/**
 * McDowell's daily constellation status log, reduced to a weekly sample (plus
 * the latest day) from the first launch onwards. Columns are kept verbatim;
 * their letters match GCAT Type byte 8.
 */
function parseHistory(text) {
  const lines = text.split('\n')
  const header = lines[0].replace(/^#/, '').trim().split(/\s+/)
  const keep = header.filter((h) => h !== 'Bin' && h !== 'Date')
  const rows = []
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s+/)
    if (cells.length < header.length) continue
    const date = vagueDate(cells.slice(header.length, header.length + 3).join(' '))
    if (!date) continue
    const values = keep.map((k) => Number(cells[header.indexOf(k)]))
    if (values.some((v) => !Number.isFinite(v))) continue
    rows.push([date.iso, ...values])
  }
  const started = rows.findIndex((r) => r[1] > 0)
  if (started < 0) throw new Error('log.dat has no non-zero rows')
  const live = rows.slice(started)
  const sampled = live.filter((_, i) => i % 7 === 0)
  if (sampled.at(-1) !== live.at(-1)) sampled.push(live.at(-1))
  return { fields: ['date', ...keep], rows: sampled }
}

/* --------------------------------- build ---------------------------------- */

const FIELDS = [
  'jcat', 'norad', 'piece', 'launchTag', 'name', 'plName', 'program', 'bus', 'plane', 'type',
  'active', 'lDate', 'lApprox', 'dDate', 'dApprox', 'tOp', 'mass', 'perigee', 'apogee', 'inc',
  'period', 'oDate', 'gpEpoch', 'gpMeanMotion', 'gpEcc',
]
/** Low-cardinality columns stored as indexes into `dict`. */
const DICT_FIELDS = ['program', 'bus', 'plane', 'type', 'active']

function buildSnapshot(tables, gpRows) {
  const byJcat = (rows) => new Map(rows.map((r) => [r.JCAT, r]))
  const payload = byJcat([...tables.psatcat.rows, ...tables.psatcat100k.rows])
  const catalog = byJcat([...tables.satcat.rows, ...tables.satcat100k.rows, ...tables.auxcat.rows])
  const gpByNorad = new Map((gpRows ?? []).map((r) => [r[0], r]))

  const excluded = { testArticles: 0, starshield: 0, nonPayload: 0, nonSpaceX: 0 }
  const satellites = []

  for (const cur of tables.currentcat.rows) {
    const p = payload.get(cur.JCAT)
    const c = catalog.get(cur.JCAT)
    const program = p?.Program ?? null
    const bus = c?.Bus ?? null
    const looksStarlink =
      (program?.startsWith('Starlink ') ?? false) ||
      (bus?.startsWith('Starlink') ?? false) ||
      (str(cur.Name)?.startsWith('Starlink') ?? false)
    if (!looksStarlink) continue

    if (cur.Type[0] !== 'P') {
      excluded.nonPayload += 1 // deployment rails, adapters, debris
      continue
    }
    if (program?.startsWith('NRO Star') || bus === 'Starshield') {
      excluded.starshield += 1
      continue
    }
    if (program === 'Starlink V3Sim' || TEST_ARTICLE_BUSES.has(bus) || /Simulator/.test(cur.Name ?? '')) {
      excluded.testArticles += 1
      continue
    }
    if (!(cur.Owner ?? '').includes('SPXS')) {
      excluded.nonSpaceX += 1
      continue
    }

    const norad = /^\d+$/.test(cur.Satcat ?? '') ? Number(cur.Satcat) : null
    const l = vagueDate(cur.LDate)
    const d = vagueDate(cur.DDate)
    const gp = norad != null ? gpByNorad.get(norad) : null

    satellites.push({
      // Null when it is just "S" + NORAD (all but the ~70 uncatalogued losses); decoders rebuild it.
      jcat: norad != null && cur.JCAT === `S${norad}` ? null : cur.JCAT,
      norad,
      piece: str(cur.Piece) ?? c?.Piece ?? null,
      launchTag: c?.Launch_Tag ?? null,
      name: stripStarlink(cur.Name),
      plName: stripStarlink(c?.PLName),
      program,
      bus,
      plane: p?.Plane ?? null,
      type: cur.Type.padEnd(12).slice(0, 12),
      active: str(cur.Active),
      lDate: l?.iso ?? null,
      lApprox: l?.approx ? 1 : 0,
      dDate: d?.iso ?? null,
      dApprox: d?.approx ? 1 : 0,
      tOp: vagueDate(p?.TOp)?.iso ?? null,
      mass: num(c?.Mass),
      perigee: num(cur.Perigee),
      apogee: num(cur.Apogee),
      inc: num(cur.Inc),
      period: num(cur.Period),
      oDate: vagueDate(cur.ODate)?.iso ?? null,
      // To the second is plenty for altitude; starlink-gp.json keeps full precision for SGP4.
      gpEpoch: gp ? gp[1].slice(0, 19) : null,
      gpMeanMotion: gp ? gp[2] : null,
      gpEcc: gp ? gp[3] : null,
    })
  }

  // Newest launch first, then by catalogue id for a stable order.
  const key = (s) => s.jcat ?? `S${s.norad}`
  satellites.sort(
    (a, b) => (b.lDate ?? '').localeCompare(a.lDate ?? '') || key(a).localeCompare(key(b)),
  )
  return { satellites, excluded }
}

function encodeColumnar(satellites) {
  const dict = Object.fromEntries(DICT_FIELDS.map((f) => [f, []]))
  const index = Object.fromEntries(DICT_FIELDS.map((f) => [f, new Map()]))
  const code = (field, value) => {
    if (value == null) return null
    let i = index[field].get(value)
    if (i === undefined) {
      i = dict[field].length
      dict[field].push(value)
      index[field].set(value, i)
    }
    return i
  }
  const rows = satellites.map((s) =>
    FIELDS.map((f) => (DICT_FIELDS.includes(f) ? code(f, s[f]) : s[f])),
  )
  return { dict, rows }
}

/* ------------------------------- guard rails ------------------------------ */

function assertSane(satellites, previousCount) {
  const problems = []
  const inOrbit = satellites.filter((s) => s.dDate == null).length
  const sixDigit = satellites.filter((s) => (s.norad ?? 0) >= 100_000).length
  const catalogued = satellites.filter((s) => s.norad != null)
  const withProgram = catalogued.filter((s) => s.program).length
  const norads = satellites.map((s) => s.norad).filter((n) => n != null)
  // GCAT gives launch failures letter-prefixed designators (2025-F01, 2026-U04).
  const badPiece = satellites.filter((s) => s.piece && !/^\d{4}-(\d{3}|[A-Z]\d{2})[A-Z]{0,3}$/.test(s.piece))
  const notSpaceX = satellites.filter((s) => !s.type.startsWith('P'))

  if (satellites.length < 12_000) problems.push(`only ${satellites.length} satellites (expected ≥ 12,000)`)
  if (previousCount && satellites.length < previousCount * 0.98) {
    problems.push(`${satellites.length} satellites is < 98% of the previous snapshot's ${previousCount} — the constellation only grows`)
  }
  if (inOrbit < 10_000) problems.push(`only ${inOrbit} in orbit (expected ≥ 10,000)`)
  // Without the *100k files every satellite launched since 2026-07-14 (all V3 included) silently vanishes.
  if (sixDigit < 400) problems.push(`only ${sixDigit} satellites with NORAD ≥ 100000 — were satcat100k/psatcat100k merged?`)
  if (withProgram < catalogued.length * 0.99) {
    problems.push(`only ${withProgram}/${catalogued.length} catalogued satellites joined to a psatcat Program`)
  }
  if (new Set(norads).size !== norads.length) problems.push('duplicate NORAD ids')
  if (badPiece.length) problems.push(`${badPiece.length} malformed COSPAR ids, e.g. ${badPiece.slice(0, 3).map((s) => s.piece).join(', ')}`)
  if (notSpaceX.length) problems.push(`${notSpaceX.length} non-payload rows slipped through`)

  if (problems.length) {
    throw new Error(`Refusing to write the Starlink snapshot:\n  - ${problems.join('\n  - ')}`)
  }
  return { inOrbit, sixDigit }
}

function assertGpSane(rows, generatedAt) {
  if (rows.length < 10_000) throw new Error(`GP has only ${rows.length} rows (expected ≥ 10,000)`)
  const maxEpoch = rows.reduce((m, r) => (r[1] > m ? r[1] : m), '')
  const ageDays = (Date.parse(generatedAt) - Date.parse(`${maxEpoch}Z`)) / 86_400_000
  if (!(ageDays < 3)) throw new Error(`GP newest epoch ${maxEpoch} is ${ageDays.toFixed(1)} days old`)
  return maxEpoch
}

/* ---------------------------------- main ---------------------------------- */

async function loadSources(state) {
  const now = Date.now()
  const gcatDue = FORCE || !state.lastCheckedAt || now - Date.parse(state.lastCheckedAt) >= GCAT_GATE_MS
  const files = {}
  let touchedNetwork = false

  for (const [name, src] of Object.entries(SOURCES)) {
    const cached = await readCachedRaw(name)
    const prev = state.files?.[name] ?? {}

    if (OFFLINE || (!gcatDue && cached)) {
      if (!cached) throw new Error(`--offline but no cached copy of ${name}`)
      files[name] = { text: cached, status: 'cached', etag: prev.etag ?? null }
      continue
    }

    if (touchedNetwork) await sleep(REQUEST_SPACING_MS)
    touchedNetwork = true
    console.log(`  ${name}: GET ${src.url}`)
    try {
      const res = await fetchConditional(src.url, { etag: cached ? prev.etag : null, retry: true })
      if (res.status === 304) {
        console.log('    304 not modified (using cache)')
        files[name] = { text: cached, status: 304, etag: res.etag }
      } else {
        console.log(`    200 ${(res.body.length / 1024).toFixed(0)} KB`)
        await writeCachedRaw(name, res.body)
        files[name] = { text: res.body, status: 200, etag: res.etag }
      }
    } catch (err) {
      if (!cached) throw err
      console.warn(`    ! ${err.message}; falling back to cached copy`)
      files[name] = { text: cached, status: 'cached', etag: prev.etag ?? null }
    }
  }
  if (gcatDue && !OFFLINE) state.lastCheckedAt = new Date(now).toISOString()
  return files
}

/**
 * CelesTrak GP: one request, no retry, gated. Returns parsed rows (fresh or
 * cached) or null if we have never had a good copy.
 */
async function loadGp(state) {
  const cached = await readCachedRaw('gp')
  const due = FORCE || !state.lastGpAttemptAt || Date.now() - Date.parse(state.lastGpAttemptAt) >= GP_GATE_MS
  let text = cached
  let status = cached ? 'cached' : 'none'

  if (!OFFLINE && due) {
    state.lastGpAttemptAt = new Date().toISOString()
    console.log(`  gp: GET ${GP_URL}  (single attempt, no retry)`)
    try {
      const res = await fetchConditional(GP_URL, { retry: false })
      parseGpCsv(res.body) // validate before it can replace a good cached copy
      await writeCachedRaw('gp', res.body)
      text = res.body
      status = 200
      console.log(`    200 ${(res.body.length / 1024).toFixed(0)} KB`)
    } catch (err) {
      console.warn(`    ! CelesTrak GP unavailable (${err.message}). Not retrying; using ${cached ? 'cached copy' : 'no GP data'}.`)
      if (process.env.GITHUB_ACTIONS) console.log(`::warning::CelesTrak GP fetch failed: ${err.message}`)
    }
  } else if (!OFFLINE) {
    console.log('  gp: last attempt < 2 h ago; using cached copy')
  }

  return text ? { rows: parseGpCsv(text), status } : null
}

async function main() {
  console.log('='.repeat(64))
  console.log('Starlink satellite snapshot builder')
  console.log(`  mode: ${OFFLINE ? 'offline (cache only)' : FORCE ? 'forced refresh' : 'gated refresh'}`)
  console.log('='.repeat(64))

  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(OUT_DIR, { recursive: true })
  const state = (await readJsonFile(cachePath('state.json'))) ?? {}
  const previous = await readJsonFile(resolve(OUT_DIR, 'starlink.json'))

  console.log('\nSources:')
  const files = await loadSources(state)
  const gp = await loadGp(state)

  const tables = {}
  for (const name of Object.keys(REQUIRED_COLUMNS)) tables[name] = parseTsv(name, files[name].text)

  const { satellites, excluded } = buildSnapshot(tables, gp?.rows)
  const { inOrbit, sixDigit } = assertSane(satellites, previous?.meta?.satelliteCount)

  const generatedAt = new Date().toISOString()
  let gpMeta = null
  let gpFile = null
  if (gp) {
    try {
      const maxEpoch = assertGpSane(gp.rows, generatedAt)
      gpMeta = { status: gp.status, rows: gp.rows.length, maxEpoch, attemptedAt: state.lastGpAttemptAt ?? null }
      gpFile = {
        v: 1,
        generatedAt,
        source: GP_URL,
        fields: ['norad', 'epoch', 'meanMotion', 'ecc', 'inc', 'raan', 'argp', 'meanAnomaly', 'bstar', 'mmDot', 'mmDdot'],
        rows: gp.rows,
      }
    } catch (err) {
      // Stale GP never blocks the catalogue; the map just keeps the last good file.
      console.warn(`  ! GP rejected: ${err.message}`)
    }
  }

  const gcatUpdated = Object.keys(REQUIRED_COLUMNS)
    .map((n) => gcatStampToIso(tables[n].updated))
    .filter(Boolean)
    .sort()
    .at(-1) ?? null

  const reference = parseReference(files.stats.text) ?? previous?.meta?.reference ?? null
  let history = null
  try {
    history = parseHistory(files.log.text)
  } catch (err) {
    console.warn(`  ! could not parse log.dat (${err.message}); keeping previous history file`)
  }

  const { dict, rows } = encodeColumnar(satellites)
  const meta = {
    generatedAt,
    gcatUpdated,
    satelliteCount: satellites.length,
    inOrbitCount: inOrbit,
    excluded,
    reference,
    gp: gpMeta,
    files: Object.fromEntries(
      Object.entries(SOURCES).map(([name, src]) => [
        name,
        {
          url: src.url,
          status: files[name].status,
          updated: tables[name]?.updated ? gcatStampToIso(tables[name].updated) : null,
          rows: tables[name]?.rows.length ?? null,
        },
      ]),
    ),
    source: 'GCAT (J. McDowell, planet4589.org/space/gcat) + CelesTrak GP',
    attribution:
      'Satellite catalogue: GCAT, Jonathan C. McDowell, planet4589.org/space/gcat, CC BY 4.0 (filtered and reformatted). ' +
      'Orbital elements: CelesTrak (celestrak.org), sourced from USSPACECOM / 18 SDS via Space-Track.org.',
  }

  const snapshot = JSON.stringify({ v: 1, meta, fields: FIELDS, dict, rows })
  await writeAtomic(resolve(OUT_DIR, 'starlink.json'), snapshot)
  await copyFile(resolve(OUT_DIR, 'starlink.json'), cachePath('starlink.json'))
  if (gpFile) {
    await writeAtomic(resolve(OUT_DIR, 'starlink-gp.json'), JSON.stringify(gpFile))
    await copyFile(resolve(OUT_DIR, 'starlink-gp.json'), cachePath('starlink-gp.json'))
  }
  if (history) {
    const historyFile = JSON.stringify({ v: 1, generatedAt, source: SOURCES.log.url, ...history })
    await writeAtomic(resolve(OUT_DIR, 'starlink-history.json'), historyFile)
    await copyFile(resolve(OUT_DIR, 'starlink-history.json'), cachePath('starlink-history.json'))
  }
  state.files = Object.fromEntries(Object.entries(files).map(([n, f]) => [n, { etag: f.etag }]))
  await writeFile(cachePath('state.json'), JSON.stringify(state, null, 2), 'utf8')

  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB (${(gzipSync(s).length / 1024).toFixed(0)} KB gzip)`
  console.log('\n' + '='.repeat(64))
  console.log(`Satellites: ${satellites.length} (${inOrbit} in orbit, ${sixDigit} with 6-digit NORAD ids)`)
  console.log(`Excluded:   ${JSON.stringify(excluded)}`)
  if (reference) {
    console.log(`Reference:  McDowell ${reference.total.launched} launched / ${reference.total.inOrbit} in orbit (as of ${reference.asOf})`)
  }
  console.log(`Wrote starlink.json ${kb(snapshot)}`)
  if (gpFile) console.log(`Wrote starlink-gp.json ${gpFile.rows.length} element sets, newest epoch ${gpMeta.maxEpoch}`)
  console.log(`GCAT updated ${gcatUpdated} · generated ${generatedAt}`)
  console.log('='.repeat(64))
}

/**
 * On failure, publish the newest known-good outputs from the cache if they
 * beat what is committed, so CI serves yesterday's data rather than whatever
 * was last committed by hand. Then fail, so the problem is visible.
 */
async function restoreLastGood() {
  for (const file of ['starlink.json', 'starlink-gp.json', 'starlink-history.json']) {
    const cached = await readJsonFile(cachePath(file))
    const published = await readJsonFile(resolve(OUT_DIR, file))
    const stamp = (d) => d?.meta?.generatedAt ?? d?.generatedAt ?? ''
    if (cached && stamp(cached) > stamp(published)) {
      await copyFile(cachePath(file), resolve(OUT_DIR, file))
      console.warn(`  restored last good ${file} from cache (${stamp(cached)})`)
    }
  }
}

main().catch(async (err) => {
  console.error('\nFATAL:', err.message)
  try {
    await restoreLastGood()
  } catch (restoreErr) {
    console.error('  could not restore from cache:', restoreErr.message)
  }
  process.exit(1)
})
