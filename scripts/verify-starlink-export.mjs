#!/usr/bin/env node
/**
 * Builds the Starlink satellite spreadsheet from the committed snapshot with
 * the SHIPPED code (decodeStarlink + buildStarlinkWorkbook + modelToBlob),
 * then reads the file back and checks it cell by cell.
 *
 * Same reasoning as verify-export.mjs: the failure modes are silent. A
 * CelesTrak epoch read as local time, an "approximate" flag written as blank
 * instead of FALSE, or a derived column that drifts from what the Starlink
 * tab shows all produce a file that opens fine and is quietly wrong. So the
 * .xlsx is re-read with an independent parser (read-excel-file), its raw XML
 * is inspected (fflate), and every cell is compared with the source JSON.
 * Expectations are computed from the data, never hardcoded, so this keeps
 * passing across daily data refreshes.
 *
 * Derived columns are recomputed here by calling src/lib/starlink.ts
 * directly; the Versions sheet is re-tallied here rather than through
 * versionBreakdown(), so a tallying bug can't hide behind itself. Raw columns
 * are resolved from their documented `source` field on the Satellite, and
 * that field must agree with SATELLITE_FIELDS about which header exports it.
 *
 * Runs in Pacific/Auckland unless TZ is set, so a date that shifts with the
 * machine's zone fails even on a UTC CI runner.
 *
 *   npm run verify:starlink-export
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { strFromU8, unzipSync } from 'fflate'
import readXlsxFile from 'read-excel-file/node'

import {
  VERSION_ORDER,
  ageDays,
  constellationFlag,
  decodeStarlink,
  displayName,
  fccOutOfService,
  indexStarlinkLaunches,
  isInOrbit,
  isOperationalShell,
  isOrbitStale,
  isWorking,
  launchFor,
  launchGroup,
  lifecyclePhase,
  lifetimeDays,
  orbitOf,
  reentryCause,
  shellOf,
  starlinkVersion,
  versionFamily,
  versionVariant,
} from '../src/lib/starlink.ts'
import { headerOf, zonelessAsUtc } from '../src/lib/export/cells.ts'
import { SATELLITE_FIELDS } from '../src/lib/export/starlinkSchema.ts'
import {
  STARLINK_DATA_SHEETS,
  STARLINK_SHEET_NAMES,
  buildStarlinkWorkbook,
  starlinkExportFileName,
} from '../src/lib/export/starlinkWorkbook.ts'
import { modelToBlob } from '../src/lib/export/xlsx.ts'

// See verify-export.mjs: a Date that drifts with the local zone reads back
// correctly on a UTC machine, so default to a zone far from UTC unless TZ was
// set explicitly. Node re-reads TZ when it's assigned.
if (!process.env.TZ) process.env.TZ = 'Pacific/Auckland'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(__dirname, '..', 'public', 'data')
const file = JSON.parse(readFileSync(join(dataDir, 'starlink.json'), 'utf8'))
const launches = JSON.parse(readFileSync(join(dataDir, 'launches.json'), 'utf8'))
const { meta, satellites } = decodeStarlink(file)

const EXPORTED_AT = new Date('2026-01-01T00:00:00Z')
const OUT_FILE = join(tmpdir(), 'starlink-export-check.xlsx')
const MAX_CELL_CHARS = 32_767
const DATA_SHEET_NAMES = STARLINK_DATA_SHEETS.map((s) => s.name)

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`PASS  ${name}`)
  } catch (err) {
    failures++
    const detail = String(err?.message ?? err).split('\n').slice(0, 12).join('\n      ')
    console.log(`FAIL  ${name}\n      ${detail}`)
  }
}

/* ------------------------------- build ------------------------------------ */

const t0 = performance.now()
const input = { meta, satellites, launches }
const { model, stats } = buildStarlinkWorkbook(input, { exportedAt: EXPORTED_AT })
const blob = await modelToBlob(model)
const buildMs = performance.now() - t0
const bytes = Buffer.from(await blob.arrayBuffer())
writeFileSync(OUT_FILE, bytes)

console.log(`\nSTARLINK EXPORT — ${satellites.length} satellites, ${launches.length} launches`)
console.log(`Wrote ${OUT_FILE}`)
console.log(`${(bytes.length / 1024).toFixed(0)} KB, built in ${buildMs.toFixed(0)} ms`)
console.log(`TZ=${process.env.TZ ?? '(unset)'}  resolved=${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
console.log('='.repeat(62))

const sheets = await readXlsxFile(bytes, { trim: false })
const read = new Map(sheets.map((s) => [s.sheet, s.data]))
const zip = unzipSync(new Uint8Array(bytes))
const xmlFiles = Object.fromEntries(
  Object.entries(zip)
    .filter(([path]) => path.endsWith('.xml') || path.endsWith('.rels'))
    .map(([path, data]) => [path, strFromU8(data)]),
)

/* ------------------------- independent expectations ----------------------- */

const asOf = meta.generatedAt
const index = indexStarlinkLaunches(launches)

// Rows behind each data sheet, built here rather than by starlinkWorkbook.ts.
const satRows = satellites.map((sat) => ({ sat, launch: launchFor(sat, index) }))
const versionRows = VERSION_ORDER.flatMap((version) => {
  const of = satellites.filter((s) => starlinkVersion(s) === version)
  if (!of.length) return []
  const up = of.filter(isInOrbit)
  return [
    {
      version,
      launched: of.length,
      inOrbit: up.length,
      working: up.filter(isWorking).length,
      operational: up.filter(isOperationalShell).length,
      reentered: of.length - up.length,
    },
  ]
})
const sourceRows = { Satellites: satRows, Versions: versionRows }

const tenth = (x) => (x == null ? null : Math.round(x * 10) / 10)

// Every derived column, recomputed from starlink.ts. Keyed by sheet, then
// final header (In orbit appears on both sheets with different meanings).
const DERIVED = {
  Satellites: {
    'Display name (derived)': (r) => displayName(r.sat),
    'Version (derived)': (r) => starlinkVersion(r.sat),
    'Version detail (derived)': (r) => versionVariant(r.sat),
    'Family (derived)': (r) => versionFamily(starlinkVersion(r.sat)),
    'In orbit (derived)': (r) => isInOrbit(r.sat),
    'Working (derived)': (r) => isWorking(r.sat),
    'In operational shell (derived)': (r) => isOperationalShell(r.sat),
    'Status flag (derived)': (r) => constellationFlag(r.sat),
    'Lifecycle phase (derived)': (r) => lifecyclePhase(r.sat),
    'Reentry cause (derived)': (r) => reentryCause(r.sat),
    'Shell (derived)': (r) => shellOf(r.sat)?.label,
    'Orbit source (derived)': (r) => orbitOf(r.sat)?.source,
    'Current orbit date (UTC) (derived)': (r) => orbitOf(r.sat)?.epoch,
    'Mean altitude (km) (derived)': (r) => tenth(orbitOf(r.sat)?.meanKm),
    'Current perigee (km) (derived)': (r) => tenth(orbitOf(r.sat)?.perigeeKm),
    'Current apogee (km) (derived)': (r) => tenth(orbitOf(r.sat)?.apogeeKm),
    'Orbit stale (derived)': (r) => isOrbitStale(r.sat, asOf),
    'Age (days) (derived)': (r) => ageDays(r.sat, asOf),
    'Lifetime (days) (derived)': (r) => lifetimeDays(r.sat),
    'Launch group (derived)': (r) => launchGroup(r.sat),
    'FCC out of service (derived)': (r) => fccOutOfService(r.sat),
    'LL2 launch ID (derived)': (r) => r.launch?.id,
    'LL2 launch name (derived)': (r) => r.launch?.name,
  },
  Versions: {
    'Version (derived)': (r) => r.version,
    'Launched (derived)': (r) => r.launched,
    'In orbit (derived)': (r) => r.inOrbit,
    'Working (derived)': (r) => r.working,
    'Operational (derived)': (r) => r.operational,
    'Reentered (derived)': (r) => r.reentered,
  },
}

function expectedFor(sheet, column) {
  const header = headerOf(column)
  if (column.derived) {
    const fn = DERIVED[sheet]?.[header]
    assert.ok(fn, `${sheet}: derived column "${header}" has no recomputation in verify-starlink-export.mjs`)
    return fn
  }
  assert.equal(sheet, 'Satellites', `${sheet}: raw column "${header}" — only Satellites has raw columns`)
  assert.ok(/^\w+$/.test(column.source), `${header}: source "${column.source}" is not a Satellite field`)
  assert.ok(column.source in satellites[0], `${header}: no field ${column.source} on Satellite`)
  return (row) => row.sat[column.source]
}

/** Restated from cells.ts so the check is independent of it. */
const UNWRITABLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFFFD\p{Noncharacter_Code_Point}]|\p{Cs}/gu
let expectedStripped = 0

/**
 * Every timestamp in the source is UTC. Date-only strings parse as UTC
 * natively; CelesTrak's zone-less date-times would parse as LOCAL time, so
 * they're marked UTC explicitly here — which is exactly what the export must
 * have done too.
 */
function utcMillis(v) {
  const s = String(v)
  const zoned = !s.includes('T') || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
  return Date.parse(zoned ? s : s + 'Z')
}

/** The source value as it should appear in the file (null = blank cell). */
function normalise(kind, v) {
  if (v == null || v === '') return null
  if (kind === 'datetime' || kind === 'date') return utcMillis(v)
  if (typeof v === 'string') {
    const s = v.replace(/\r\n?/g, '\n')
    const cleaned = s.replace(UNWRITABLE, '')
    expectedStripped += s.length - cleaned.length
    return cleaned || null
  }
  return v
}

/** See verify-export.mjs: read-excel-file truncates to the millisecond. */
const sameInstant = (a, b) => Math.abs(a - b) <= 1

function cellMatches(kind, cell, expected) {
  if (expected === null) return cell === null || cell === undefined
  switch (kind) {
    case 'datetime':
    case 'date':
      return cell instanceof Date && sameInstant(cell.getTime(), expected)
    case 'integer':
      return Number.isInteger(cell) && cell === expected
    case 'number':
      return typeof cell === 'number' && cell === expected
    case 'boolean':
      return typeof cell === 'boolean' && cell === expected
    default:
      return typeof cell === 'string' && cell === expected
  }
}

const show = (v) => (v instanceof Date ? v.toISOString() : JSON.stringify(v))

/* -------------------------------- checks ---------------------------------- */

check('sheet names and order', () => {
  assert.deepEqual(
    sheets.map((s) => s.sheet),
    ['About', 'Satellites', 'Versions', 'Columns'],
  )
  assert.deepEqual(STARLINK_SHEET_NAMES, sheets.map((s) => s.sheet))
})

check('row counts (including header) match the source', () => {
  const totalColumns = STARLINK_DATA_SHEETS.reduce((n, s) => n + s.columns.length, 0)
  const expected = {
    Satellites: satellites.length + 1,
    Versions: versionRows.length + 1,
    Columns: totalColumns + 1,
  }
  for (const [name, n] of Object.entries(expected)) {
    assert.equal(read.get(name).length, n, `${name}: ${read.get(name).length} rows, expected ${n}`)
  }
  assert.equal(satellites.length, meta.satelliteCount, 'decoded satellites disagree with meta.satelliteCount')
  console.log('      ' + Object.entries(expected).map(([k, n]) => `${k} ${n}`).join(' · '))
})

check('header row of every data sheet equals its specs, and headers are unique', () => {
  for (const s of STARLINK_DATA_SHEETS) {
    const headers = s.columns.map(headerOf)
    assert.deepEqual(read.get(s.name)[0], headers, `${s.name} header row`)
    assert.equal(new Set(headers).size, headers.length, `${s.name} has duplicate headers`)
  }
  assert.equal(read.get('Satellites')[0][0], 'NORAD', 'NORAD must be the first column')
  assert.deepEqual(read.get('Columns')[0], ['Sheet', 'Column', 'Type', 'Derived', 'Source', 'Description'])
  assert.deepEqual(read.get('About')[0], ['Item', 'Value'])
})

// Types, null fidelity and derived fidelity, every cell.
const dateTimes = []
for (const s of STARLINK_DATA_SHEETS) {
  const rows = read.get(s.name).slice(1)
  const src = sourceRows[s.name]
  s.columns.forEach((column, c) => {
    const header = headerOf(column)
    check(`${s.name} / ${header}: ${column.kind}${column.derived ? ', derived' : ''}`, () => {
      assert.equal(rows.length, src.length)
      const expectedOf = expectedFor(s.name, column)
      const bad = []
      let blanks = 0
      let expectedBlanks = 0
      let trues = 0
      let expectedTrues = 0
      rows.forEach((row, i) => {
        const cell = row[c] ?? null
        const expected = normalise(column.kind, expectedOf(src[i]))
        if (cell === null) blanks++
        if (expected === null) expectedBlanks++
        if (cell === true) trues++
        if (expected === true) expectedTrues++
        if (cell instanceof Date) dateTimes.push(cell.getTime())
        if (!cellMatches(column.kind, cell, expected) && bad.length < 5) {
          bad.push(`row ${i + 2}: got ${show(cell)} (${typeof cell}), expected ${show(expected)}`)
        }
      })
      assert.equal(blanks, expectedBlanks, `${blanks} blank cells, source has ${expectedBlanks} nulls`)
      if (column.kind === 'boolean') {
        assert.equal(trues, expectedTrues, `${trues} TRUE, source has ${expectedTrues}`)
      }
      if (column.kind === 'date') {
        const offMidnight = rows.filter((r) => r[c] instanceof Date && r[c].getTime() % 86_400_000 !== 0)
        assert.equal(offMidnight.length, 0, `${offMidnight.length} date cells not at UTC midnight`)
      }
      assert.equal(bad.length, 0, bad.join('\n'))
    })
  })
}

check('Versions sheet totals equal the Satellites sheet', () => {
  const [header, ...rows] = read.get('Versions')
  const col = (h) => header.indexOf(h)
  const sum = (h) => rows.reduce((n, r) => n + r[col(h)], 0)
  assert.equal(sum('Launched (derived)'), satellites.length)
  assert.equal(sum('In orbit (derived)'), satellites.filter(isInOrbit).length)
  assert.equal(sum('Reentered (derived)'), satellites.length - satellites.filter(isInOrbit).length)
  const unclassified = rows.find((r) => r[col('Version (derived)')] === 'Unclassified')
  console.log(
    `      ${rows.length} versions; Unclassified ${unclassified ? unclassified[col('Launched (derived)')] : 0}`,
  )
})

check('Columns sheet describes every data-sheet column', () => {
  const rows = read.get('Columns').slice(1)
  const expected = STARLINK_DATA_SHEETS.flatMap((s) =>
    s.columns.map((c) => [s.name, headerOf(c), c.derived === true]),
  )
  assert.deepEqual(rows.map((r) => [r[0], r[1], r[3]]), expected)
  for (const r of rows) {
    assert.ok(
      ['Text', 'URL', 'Whole number', 'Number', 'TRUE/FALSE', 'Date-time (UTC)', 'Date (UTC)'].includes(r[2]),
      `bad type ${r[2]}`,
    )
    assert.ok(typeof r[4] === 'string' && typeof r[5] === 'string', `${r[1]}: missing source/description`)
  }
})

check('About: timestamps are Dates, counts are numbers, attribution present', () => {
  const about = new Map(read.get('About').slice(1).map((r) => [r[0], r[1]]))
  const dateItem = (item, iso) => {
    const v = about.get(item)
    assert.ok(v instanceof Date, `${item} is not a Date: ${show(v)}`)
    assert.ok(sameInstant(v.getTime(), utcMillis(iso)), `${item}: ${show(v)}, expected ${iso}`)
    dateTimes.push(v.getTime())
  }
  dateItem('Snapshot generated (UTC)', meta.generatedAt)
  dateItem('Exported (UTC)', EXPORTED_AT.toISOString())
  if (meta.gcatUpdated) dateItem('GCAT updated (UTC)', meta.gcatUpdated)
  if (meta.gp) dateItem('GP newest epoch (UTC)', meta.gp.maxEpoch)

  const up = satellites.filter(isInOrbit)
  assert.equal(about.get('Satellites in this file'), satellites.length)
  assert.equal(about.get('Satellites in orbit'), up.length)
  assert.equal(about.get('Satellites working'), up.filter(isWorking).length)
  assert.equal(about.get('Satellites in operational shell'), up.filter(isOperationalShell).length)
  assert.equal(about.get('Satellites reentered'), satellites.length - up.length)
  assert.equal(about.get('Satellites linked to an LL2 launch'), satRows.filter((r) => r.launch).length)

  if (meta.reference) {
    if (meta.reference.asOf) dateItem('Reference: McDowell stats as of (UTC)', meta.reference.asOf)
    assert.equal(about.get('Reference: launched'), meta.reference.total.launched)
    assert.equal(about.get('Reference: in orbit'), meta.reference.total.inOrbit)
    assert.equal(about.get('Reference: working'), meta.reference.total.working)
    assert.equal(about.get('Reference: in operational shell'), meta.reference.total.operational)
  }
  const exclusions = [...about].filter(([k]) => k.startsWith('Excluded: '))
  assert.equal(exclusions.length, Object.keys(meta.excluded).length)
  for (const [k, v] of exclusions) assert.ok(Number.isInteger(v), `${k} is not a number`)
  assert.equal(
    exclusions.reduce((n, [, v]) => n + v, 0),
    Object.values(meta.excluded).reduce((n, v) => n + v, 0),
  )

  assert.equal(about.get('Attribution'), meta.attribution)
  assert.match(about.get('Licence and changes'), /CC BY 4\.0/)
  assert.match(about.get('Licence and changes'), /filtered and reformatted/)
  for (const item of [
    'Definition: Working',
    'Definition: In operational shell',
    'Definition: Reentry cause',
    'Caveat: version',
    'Caveat: altitude',
    'Caveat: uncatalogued losses',
    'Caveat: Gen1 / Gen2',
  ]) {
    assert.ok(typeof about.get(item) === 'string', `About is missing "${item}"`)
  }
  for (const name of STARLINK_SHEET_NAMES.slice(1)) {
    const rows = read.get(name).length - 1
    assert.ok(about.get(`Sheet: ${name}`)?.endsWith(` - ${rows} rows`), `About row for ${name}`)
  }
})

check('reconciliation: in-orbit / working / operational within 1% of McDowell', () => {
  const t = meta.reference?.total
  if (!t) {
    console.log('      no reference totals in this snapshot; skipped')
    return
  }
  const up = satellites.filter(isInOrbit)
  const pairs = {
    launched: [satellites.length, t.launched],
    inOrbit: [up.length, t.inOrbit],
    working: [up.filter(isWorking).length, t.working],
    operational: [up.filter(isOperationalShell).length, t.operational],
  }
  for (const [k, [ours, theirs]] of Object.entries(pairs)) {
    assert.ok(Math.abs(ours - theirs) <= theirs * 0.01, `${k}: ${ours} vs reference ${theirs}`)
  }
  console.log('      ' + Object.entries(pairs).map(([k, [a, b]]) => `${k} ${a}/${b}`).join(' · '))
})

check('SATELLITE_FIELDS names real headers, and covers exactly the Satellite fields', () => {
  const headers = new Set(STARLINK_DATA_SHEETS[0].columns.map(headerOf))
  for (const [field, target] of Object.entries(SATELLITE_FIELDS)) {
    assert.ok(headers.has(target), `Satellite.${field} -> "${target}" is not a header on Satellites`)
  }
  assert.deepEqual(Object.keys(SATELLITE_FIELDS).sort(), Object.keys(satellites[0]).sort())
})

// Each raw column's `source` and SATELLITE_FIELDS are two statements of
// which field a header exports; the per-cell checks trust the first, so make
// it agree with the second.
check('raw columns read the field SATELLITE_FIELDS assigns to their header', () => {
  const bad = []
  const raw = STARLINK_DATA_SHEETS[0].columns.filter((c) => !c.derived)
  for (const column of raw) {
    const covered = SATELLITE_FIELDS[column.source]
    if (covered !== headerOf(column)) {
      bad.push(`${headerOf(column)}: source "${column.source}" is the field for "${covered}"`)
    }
  }
  assert.equal(raw.length, Object.keys(SATELLITE_FIELDS).length, 'one raw column per Satellite field')
  assert.equal(bad.length, 0, bad.join('\n'))
})

check('joins: LL2 launch IDs exist in launches.json, GCAT IDs unique', () => {
  const [header, ...rows] = read.get('Satellites')
  const known = new Set(launches.map((l) => l.id))
  const col = header.indexOf('LL2 launch ID (derived)')
  const orphans = rows.filter((r) => r[col] != null && !known.has(r[col]))
  assert.equal(orphans.length, 0, `${orphans.length} LL2 launch IDs not in launches.json`)
  const jcat = rows.map((r) => r[header.indexOf('GCAT ID')])
  assert.equal(new Set(jcat).size, jcat.length, 'duplicate GCAT IDs')
  const norad = rows.map((r) => r[0]).filter((v) => v != null)
  assert.equal(new Set(norad).size, norad.length, 'duplicate NORAD ids')
  const linked = rows.filter((r) => r[col] != null).length
  console.log(`      ${linked}/${rows.length} satellites linked to an LL2 launch`)
})

check('spot check: zone-less GP epoch, 6-digit NORAD, uncatalogued loss', () => {
  const [header, ...rows] = read.get('Satellites')
  const byJcat = new Map(rows.map((r) => [r[header.indexOf('GCAT ID')], r]))
  const withGp = satellites.find((s) => s.gpEpoch && !/Z$/.test(s.gpEpoch))
  assert.ok(withGp, 'no zone-less GP epoch in the snapshot to check')
  const epoch = byJcat.get(withGp.jcat)[header.indexOf('GP epoch (UTC)')]
  assert.ok(
    epoch instanceof Date && epoch.toISOString().startsWith(withGp.gpEpoch.slice(0, 19)),
    `GP epoch ${show(epoch)} for source ${withGp.gpEpoch} (shifted by the local zone?)`,
  )
  const big = satellites.find((s) => s.norad != null && s.norad > 99_999)
  if (big) assert.equal(byJcat.get(big.jcat)[0], big.norad)
  const lost = satellites.find((s) => s.norad == null)
  if (lost) {
    const row = byJcat.get(lost.jcat)
    assert.equal(row[0] ?? null, null, 'uncatalogued satellite should have a blank NORAD')
    assert.ok(lost.jcat.startsWith('A'), `uncatalogued GCAT id ${lost.jcat}`)
  }
  console.log(`      ${withGp.jcat} epoch ${withGp.gpEpoch} -> ${epoch.toISOString()}`)
})

check('first and last Satellites rows match the model exactly', () => {
  const sheet = model.sheets.find((s) => s.name === 'Satellites')
  const rows = read.get('Satellites')
  const same = (fileRow, modelRow) => {
    assert.equal(fileRow.length, modelRow.length)
    modelRow.forEach((v, i) => {
      const got = fileRow[i] ?? null
      if (v instanceof Date) assert.ok(got instanceof Date && sameInstant(got.getTime(), v.getTime()), `col ${i + 1}`)
      else assert.equal(got, v, `col ${i + 1}`)
    })
  }
  same(rows[1], sheet.rows[0])
  same(rows.at(-1), sheet.rows.at(-1))
  // Snapshot order is kept: newest launch first. The builder relies on
  // fetch-starlink.mjs's sort, so check every row, not just the two ends.
  const lCol = rows[0].indexOf('Launch date (UTC)')
  const days = rows.slice(1).map((r) => r[lCol]?.getTime() ?? -Infinity)
  const firstOut = days.findIndex((t, i) => i > 0 && t > days[i - 1])
  assert.equal(firstOut, -1, `Satellites not newest launch first at row ${firstOut + 2}`)
})

/* ------------------------------- raw XML ---------------------------------- */

const sheetFiles = new Map(
  [...xmlFiles['xl/workbook.xml'].matchAll(/<sheet [^>]*sheetId="(\d+)"[^>]*name="([^"]+)"/g)].map((m) => [
    m[2],
    `xl/worksheets/sheet${m[1]}.xml`,
  ]),
)

check('raw XML: one autoFilter per filtered sheet, directly after </sheetData>', () => {
  model.sheets.forEach((s) => {
    const xml = xmlFiles[sheetFiles.get(s.name)]
    assert.ok(xml, `no XML part for ${s.name}`)
    const count = (xml.match(/<autoFilter\b/g) ?? []).length
    if (!s.autoFilter) {
      assert.equal(count, 0, `${s.name} should have no autoFilter`)
      return
    }
    const ref = `A1:${columnLetter(s.columns.length)}${read.get(s.name).length}`
    assert.equal(count, 1, `${s.name}: ${count} autoFilter elements`)
    assert.ok(xml.includes(`</sheetData><autoFilter ref="${ref}"/>`), `${s.name}: expected autoFilter ${ref}`)
  })
  assert.deepEqual(
    model.sheets.filter((s) => s.autoFilter).map((s) => s.name),
    ['Satellites', 'Versions', 'Columns'],
  )
})

check('raw XML: frozen header row everywhere, and columns A:B on data sheets', () => {
  model.sheets.forEach((s) => {
    const pane = xmlFiles[sheetFiles.get(s.name)].match(/<pane [^>]*\/>/)?.[0]
    assert.ok(pane, `${s.name}: no <pane>`)
    assert.match(pane, /state="frozen"/, `${s.name}: ${pane}`)
    assert.match(pane, /ySplit="1"/, `${s.name}: ${pane}`)
    const xSplit = DATA_SHEET_NAMES.includes(s.name) ? '2' : '0'
    assert.match(pane, new RegExp(`xSplit="${xSplit}"`), `${s.name}: ${pane}`)
  })
})

check('raw XML: workbook defines a hidden _FilterDatabase per filtered sheet', () => {
  const xml = xmlFiles['xl/workbook.xml']
  const names = [...xml.matchAll(/<definedName ([^>]*)>([^<]*)<\/definedName>/g)]
  const filtered = model.sheets.map((s, i) => [s, i]).filter(([s]) => s.autoFilter)
  assert.equal(names.length, filtered.length)
  for (const [s, i] of filtered) {
    const range = `'${s.name}'!$A$1:$${columnLetter(s.columns.length)}$${read.get(s.name).length}`
    const hit = names.find((m) => m[1].includes(`localSheetId="${i}"`))
    assert.ok(hit, `no definedName for ${s.name} (localSheetId ${i})`)
    assert.match(hit[1], /name="_xlnm\._FilterDatabase"/)
    assert.match(hit[1], /hidden="1"/)
    assert.equal(hit[2], range)
  }
})

check('raw XML: no formulas anywhere', () => {
  for (const [path, xml] of Object.entries(xmlFiles)) {
    assert.ok(!/<f[\s>]/.test(xml), `${path} contains a formula`)
  }
})

// read-excel-file reports a Date for any date-like format, so it can't tell
// "2026-10-27" from "2026-10-27 00:00:00". Resolve each column's cell style
// through styles.xml to check date columns really show a day only.
check('raw XML: date columns use yyyy-mm-dd, date-time columns keep the time', () => {
  const styles = xmlFiles['xl/styles.xml']
  const numFmts = new Map(
    [...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  )
  // Every <xf> counts towards the index, including ones with no numFmtId.
  const cellXfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? ''
  const xfs = [...cellXfs.matchAll(/<xf\b([^>]*)>/g)].map((m) => /numFmtId="(\d+)"/.exec(m[1])?.[1])
  const sheet = model.sheets.find((s) => s.name === 'Satellites')
  const xml = xmlFiles[sheetFiles.get('Satellites')]
  sheet.columns.forEach((column, c) => {
    if (column.kind !== 'date' && column.kind !== 'datetime') return
    const r = sheet.rows.findIndex((row) => row[c] instanceof Date)
    if (r < 0) return
    const ref = `${columnLetter(c + 1)}${r + 2}`
    const style = xml.match(new RegExp(`<c r="${ref}"[^>]*? s="(\\d+)"`))?.[1]
    assert.ok(style, `${column.header}: no style on ${ref}`)
    const format = numFmts.get(xfs[Number(style)])
    const want = column.kind === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss'
    assert.equal(format, want, `${column.header} (${ref})`)
  })
})

check('build stats: no invalid dates, no clamped cells, stripped chars as expected', () => {
  assert.equal(stats.invalidDates, 0, `${stats.invalidDates} unparsable dates in the snapshot`)
  assert.equal(stats.clampedCells, 0, `${stats.clampedCells} cells over 32,767 characters`)
  assert.equal(stats.strippedChars, expectedStripped, 'stripped-character count disagrees with the source')
  console.log(`      ${stats.strippedChars} unwritable character(s) removed from source text`)
  for (const [name, rows] of read) {
    for (const row of rows) {
      for (const cell of row) {
        if (typeof cell === 'string') assert.ok(cell.length <= MAX_CELL_CHARS, `${name}: oversized cell`)
        if (cell instanceof Date) assert.ok(!Number.isNaN(cell.getTime()), `${name}: invalid Date`)
      }
    }
  }
})

check('file name is true UTC from generatedAt, with a fallback', () => {
  const d = new Date(meta.generatedAt)
  const pad = (n) => String(n).padStart(2, '0')
  const expected =
    `starlink-satellites_${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z.xlsx`
  assert.equal(starlinkExportFileName(meta), expected)
  assert.equal(
    starlinkExportFileName({ generatedAt: '2026-10-29T15:18:39.713Z' }),
    'starlink-satellites_2026-10-29_1518Z.xlsx',
  )
  assert.equal(starlinkExportFileName({ generatedAt: 'not a date' }), 'starlink-satellites.xlsx')
  assert.equal(starlinkExportFileName({ generatedAt: '' }), 'starlink-satellites.xlsx')
  console.log(`      ${starlinkExportFileName(meta)}`)
})

check('determinism: two builds with the same exportedAt are deep-equal', () => {
  const again = buildStarlinkWorkbook(
    { meta, satellites: decodeStarlink(file).satellites, launches },
    { exportedAt: new Date(EXPORTED_AT) },
  )
  assert.deepEqual(again.model, model)
  assert.deepEqual(again.stats, stats)
})

/* ---------------------------- guard rails --------------------------------- */

// The cell rules exist for data the current snapshot doesn't happen to
// contain, so exercise them on a doctored copy of one satellite.
const doctored = { ...satellites[0], launchDate: 'not a date', plName: 'Bad\u0001chars\uFFFE here' }
const doctoredBuild = buildStarlinkWorkbook(
  { meta, satellites: [doctored], launches },
  { exportedAt: EXPORTED_AT },
)
const doctoredBlob = await modelToBlob(doctoredBuild.model)
const doctoredRead = await readXlsxFile(Buffer.from(await doctoredBlob.arrayBuffer()), { trim: false })

check('guard: invalid date -> blank cell (not a NaN serial), and counted', () => {
  assert.equal(doctoredBuild.stats.invalidDates, 1)
  const sheet = doctoredRead.find((s) => s.sheet === 'Satellites').data
  assert.equal(sheet[1][sheet[0].indexOf('Launch date (UTC)')] ?? null, null)
})

check('guard: unwritable characters stripped, and counted', () => {
  // Payload name feeds Launch group (derived) too, so both cells lose 2.
  assert.equal(doctoredBuild.stats.strippedChars, 4)
  const sheet = doctoredRead.find((s) => s.sheet === 'Satellites').data
  assert.equal(sheet[1][sheet[0].indexOf('Payload name')], 'Badchars here')
})

// V8 accepts microseconds, so the cells above can't catch a browser that
// doesn't; check the string handed to Date is in the spec's own format.
check('guard: CelesTrak epochs become spec-format UTC strings (ms, Z)', () => {
  assert.equal(zonelessAsUtc('2026-10-29T07:55:53.549760'), '2026-10-29T07:55:53.549Z')
  assert.equal(zonelessAsUtc('2026-10-28T12:00:02'), '2026-10-28T12:00:02Z')
  assert.equal(zonelessAsUtc('2026-10-28'), '2026-10-28')
  assert.equal(zonelessAsUtc('2026-10-28T12:00:02.5+01:00'), '2026-10-28T12:00:02.5+01:00')
  assert.equal(zonelessAsUtc(null), null)
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/
  const epochs = satellites.map((s) => zonelessAsUtc(s.gpEpoch)).filter(Boolean)
  if (meta.gp) epochs.push(zonelessAsUtc(meta.gp.maxEpoch))
  const bad = epochs.filter((e) => !iso.test(e))
  assert.equal(bad.length, 0, `${bad.length} epoch(s) not in spec format, e.g. ${bad[0]}`)
})

/* --------------------------------- done ----------------------------------- */

function columnLetter(n) {
  let s = ''
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s
  return s
}

// Compare this line between TZ=UTC and TZ=Pacific/Auckland runs: identical
// digests mean no date moved with the machine's time zone.
const digest = createHash('sha256').update(dateTimes.join(',')).digest('hex').slice(0, 16)
console.log('='.repeat(62))
console.log(`${dateTimes.length} date-time cells, digest ${digest}`)

if (failures) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll checks passed.')
