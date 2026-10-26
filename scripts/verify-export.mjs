#!/usr/bin/env node
/**
 * Builds the spreadsheet export from the committed snapshot with the SHIPPED
 * code, then reads the file back and checks it cell by cell.
 *
 * Why not trust the writer: the failure modes here are silent. A null
 * landing flag written as FALSE, a Date that drifts with the machine's time
 * zone, or a library upgrade that drops the autofilter all produce a file
 * that opens fine and is quietly wrong. So this re-reads the .xlsx with an
 * independent parser (read-excel-file), inspects the raw XML (fflate), and
 * compares every cell with the source JSON — expectations are computed from
 * the data, never hardcoded, so it keeps passing across data refreshes.
 *
 * Derived columns are recomputed here by calling src/lib/launch.ts directly,
 * and raw columns by resolving their documented `source` path against the
 * snapshot. That path must also agree with the field-coverage maps in
 * schema.ts about which field a header exports, so a column that maps the
 * wrong field fails unless both declarations are changed to match.
 *
 * Runs in Pacific/Auckland unless TZ is set, so a date that shifts with the
 * machine's zone fails even on a UTC CI runner.
 *
 * Runs under tsx, like audit-attribution.mjs, and in CI after the build:
 *
 *   npm run verify:export
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
} from '../src/lib/launch.ts'
import { FIELD_COVERAGE, LIST_SEPARATOR } from '../src/lib/export/schema.ts'
import {
  DATA_SHEETS,
  SHEET_NAMES,
  buildWorkbook,
  exportFileName,
  headerOf,
} from '../src/lib/export/workbook.ts'
import { autoFilterFeature, modelToBlob } from '../src/lib/export/xlsx.ts'

// The time-zone checks only bite off UTC: a Date that drifts with the local
// zone reads back correctly on a UTC machine, and CI runs on one. So default
// to a zone far from UTC (+12/+13, with DST) unless TZ was set explicitly,
// which keeps the manual TZ=UTC vs TZ=Pacific/Auckland comparison possible.
// Node re-reads TZ when it's assigned, so this applies to everything below
// even though the imports above have already loaded.
if (!process.env.TZ) process.env.TZ = 'Pacific/Auckland'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(__dirname, '..', 'public', 'data')
const launches = JSON.parse(readFileSync(join(dataDir, 'launches.json'), 'utf8'))
const meta = JSON.parse(readFileSync(join(dataDir, 'meta.json'), 'utf8'))

const EXPORTED_AT = new Date('2026-01-01T00:00:00Z')
const OUT_FILE = join(tmpdir(), 'spacex-export-check.xlsx')
const MAX_CELL_CHARS = 32_767

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
const { model, stats } = buildWorkbook({ meta, launches }, { exportedAt: EXPORTED_AT })
const blob = await modelToBlob(model)
const buildMs = performance.now() - t0
const bytes = Buffer.from(await blob.arrayBuffer())
writeFileSync(OUT_FILE, bytes)

console.log(`\nSPREADSHEET EXPORT — ${launches.length} launches`)
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

// The source records behind each sheet's rows, flattened here independently
// of workbook.ts so a flattening bug can't hide behind itself.
const sourceRows = {
  Launches: launches.map((launch) => ({ launch })),
  Boosters: launches.flatMap((launch) => launch.boosters.map((child, index) => ({ launch, child, index }))),
  Payloads: launches.flatMap((launch) => launch.payloads.map((child, index) => ({ launch, child, index }))),
  Agencies: launches.flatMap((launch) => launch.agencies.map((child, index) => ({ launch, child, index }))),
  Links: launches.flatMap((launch) => [
    ...launch.vidUrls.map((child, index) => ({ launch, child, index, group: 'Video' })),
    ...launch.infoUrls.map((child, index) => ({ launch, child, index, group: 'Info' })),
  ]),
}

const join_ = (items) => (items.length ? items.join(LIST_SEPARATOR) : null)

// Every derived column, recomputed from launch.ts. Keyed by final header.
const DERIVED = {
  'NET is precise (derived)': (r) => hasPreciseNet(r.launch),
  'Year (derived)': (r) => launchYear(r.launch),
  'Outcome (derived)': (r) => outcomeOf(r.launch),
  'Launch outcome (derived)': (r) => outcomeOf(r.launch),
  'Upcoming (derived)': (r) => isUpcoming(r.launch),
  'Starlink (derived)': (r) => isStarlinkMission(r.launch),
  'Customers (derived)': (r) => customersOf(r.launch).join(LIST_SEPARATOR),
  'Primary customer (derived)': (r) => primaryCustomer(r.launch),
  'Customer segment (derived)': (r) => customerSegment(r.launch),
  'Boosters (derived)': (r) => join_(r.launch.boosters.map((b) => boosterLabel(b.serial, b.flightNumber))),
  'Reflight (derived)': (r) => isReflight(r.launch),
  'Landing attempted (derived)': (r) => landingAttempted(r.launch),
  'Landing succeeded (derived)': (r) => hasSuccessfulLanding(r.launch),
  'Serial known (derived)': (r) => hasKnownSerial(r.child.serial),
  'Booster label (derived)': (r) => boosterLabel(r.child.serial, r.child.flightNumber),
}

// Raw columns whose source isn't a plain field path.
const COMPUTED = {
  Agencies: (r) => join_(r.launch.agencies.map((a) => a.name)),
  'Customers (upstream)': (r) => join_(r.child.customers),
  'Booster position': (r) => r.index + 1,
  'Payload position': (r) => r.index + 1,
  'Agency position': (r) => r.index + 1,
  'Link position': (r) => r.index + 1,
  'Link group': (r) => r.group,
}

/**
 * Resolves a documented source path: "net" / "status.name" /
 * "boosters.length" against the launch, "boosters[].serial" (or the Links
 * form "vidUrls[].url, infoUrls[].url") against the row's child item.
 */
function resolveSource(source, row) {
  let m = /^\w+\[\]\.(\w+)(?:, \w+\[\]\.\1)*$/.exec(source)
  if (m) {
    assert.ok(row.child, `"${source}" names a child field but this sheet has no child items`)
    assert.ok(m[1] in row.child, `"${source}": no field ${m[1]} on the source item`)
    return row.child[m[1]]
  }
  m = /^(\w+)(?:\.(\w+))?$/.exec(source)
  if (m) {
    assert.ok(m[1] in row.launch, `"${source}": no field ${m[1]} on Launch`)
    const v = row.launch[m[1]]
    return m[2] ? v?.[m[2]] : v
  }
  return undefined
}

function expectedFor(sheet, column) {
  const header = headerOf(column)
  if (column.derived) {
    const fn = DERIVED[header]
    assert.ok(fn, `${sheet}: derived column "${header}" has no recomputation in verify-export.mjs`)
    return fn
  }
  if (COMPUTED[header]) return COMPUTED[header]
  assert.ok(
    /^\w+(\[\])?\./.test(column.source) || /^\w+$/.test(column.source),
    `${sheet}: don't know how to check "${header}" (source "${column.source}") — add it to COMPUTED`,
  )
  return (row) => resolveSource(column.source, row)
}

/**
 * Characters no .xlsx can carry (C0 controls, C1 controls other than U+0085,
 * U+FFFD, non-characters, lone surrogates). Restated here rather than
 * imported so the check is independent of workbook.ts. The snapshot does
 * contain a couple — upstream mojibake such as "â€\u009d" — so the count is
 * compared, not assumed to be zero.
 */
const UNWRITABLE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFFFD\p{Noncharacter_Code_Point}]|\p{Cs}/gu
let expectedStripped = 0

/** The source value as it should appear in the file (null = blank cell). */
function normalise(kind, v) {
  if (v == null || v === '') return null
  if (kind === 'datetime') return Date.parse(v)
  if (typeof v === 'string') {
    // XML readers turn \r\n and \r into \n, so the export does too.
    const s = v.replace(/\r\n?/g, '\n')
    const cleaned = s.replace(UNWRITABLE, '')
    expectedStripped += s.length - cleaned.length
    return cleaned || null
  }
  return v
}

/**
 * Excel stores a date-time as a binary-float day count, so an exact second
 * is only representable to within a few microseconds, and read-excel-file
 * truncates (not rounds) when converting back to milliseconds. A reading
 * up to 1 ms out is the same instant; anything more is a real shift.
 */
const sameInstant = (a, b) => Math.abs(a - b) <= 1

function cellMatches(kind, cell, expected) {
  if (expected === null) return cell === null || cell === undefined
  switch (kind) {
    case 'datetime':
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

// (a)
check('sheet names and order', () => {
  assert.deepEqual(
    sheets.map((s) => s.sheet),
    ['About', 'Launches', 'Boosters', 'Payloads', 'Agencies', 'Links', 'Columns'],
  )
  assert.deepEqual(SHEET_NAMES, sheets.map((s) => s.sheet))
})

// (b)
check('row counts (including header) match the source', () => {
  const totalColumns = DATA_SHEETS.reduce((n, s) => n + s.columns.length, 0)
  const expected = {
    Launches: launches.length + 1,
    Boosters: sourceRows.Boosters.length + 1,
    Payloads: sourceRows.Payloads.length + 1,
    Agencies: sourceRows.Agencies.length + 1,
    Links: sourceRows.Links.length + 1,
    Columns: totalColumns + 1,
  }
  for (const [name, n] of Object.entries(expected)) {
    assert.equal(read.get(name).length, n, `${name}: ${read.get(name).length} rows, expected ${n}`)
  }
  console.log(
    '      ' + Object.entries(expected).map(([k, n]) => `${k} ${n}`).join(' · '),
  )
})

// (c)
check('header row of every data sheet equals its specs, and headers are unique', () => {
  for (const s of DATA_SHEETS) {
    const headers = s.columns.map(headerOf)
    assert.deepEqual(read.get(s.name)[0], headers, `${s.name} header row`)
    assert.equal(new Set(headers).size, headers.length, `${s.name} has duplicate headers`)
  }
  assert.deepEqual(read.get('Columns')[0], ['Sheet', 'Column', 'Type', 'Derived', 'Source', 'Description'])
  assert.deepEqual(read.get('About')[0], ['Item', 'Value'])
})

// (d) types, (e) null fidelity and (f) derived fidelity, every cell.
const dateTimes = []
for (const s of DATA_SHEETS) {
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
      assert.equal(bad.length, 0, bad.join('\n'))
    })
  })
}

check('Starlink (derived) TRUE count equals the npm run audit figure', () => {
  const col = DATA_SHEETS[0].columns.findIndex((c) => headerOf(c) === 'Starlink (derived)')
  const trues = read.get('Launches').slice(1).filter((r) => r[col] === true).length
  assert.equal(trues, launches.filter(isStarlinkMission).length)
  console.log(`      Starlink detection: ${trues}/${launches.length}`)
})

check('Columns sheet describes every data-sheet column', () => {
  const rows = read.get('Columns').slice(1)
  const expected = DATA_SHEETS.flatMap((s) => s.columns.map((c) => [s.name, headerOf(c), c.derived === true]))
  assert.deepEqual(
    rows.map((r) => [r[0], r[1], r[3]]),
    expected,
  )
  for (const r of rows) {
    assert.ok(
      ['Text', 'URL', 'Whole number', 'Number', 'TRUE/FALSE', 'Date-time (UTC)'].includes(r[2]),
      `bad type ${r[2]}`,
    )
    assert.ok(typeof r[4] === 'string' && typeof r[5] === 'string', `${r[1]}: missing source/description`)
  }
})

check('About: snapshot and export timestamps are Dates, counts are numbers', () => {
  const about = new Map(read.get('About').slice(1).map((r) => [r[0], r[1]]))
  const generated = about.get('Snapshot generated (UTC)')
  assert.ok(generated instanceof Date, 'Snapshot generated is not a Date')
  assert.ok(sameInstant(generated.getTime(), Date.parse(meta.generatedAt)), show(generated))
  assert.ok(sameInstant(about.get('Exported (UTC)').getTime(), EXPORTED_AT.getTime()))
  assert.equal(about.get('Launches in this file'), launches.length)
  assert.equal(about.get('Launches reported upstream'), meta.upstreamCount)
  for (const name of SHEET_NAMES.slice(1)) {
    const rows = read.get(name).length - 1
    assert.ok(about.get(`Sheet: ${name}`)?.endsWith(` - ${rows} rows`), `About row for ${name}`)
  }
  dateTimes.push(generated.getTime())
})

// (g)
check('joins: Launch IDs unique, equal to the source, and every child ID exists', () => {
  const ids = read.get('Launches').slice(1).map((r) => r[0])
  assert.equal(new Set(ids).size, ids.length, 'duplicate Launch IDs')
  assert.deepEqual(new Set(ids), new Set(launches.map((l) => l.id)))
  const known = new Set(ids)
  for (const name of ['Boosters', 'Payloads', 'Agencies', 'Links']) {
    const orphans = read.get(name).slice(1).filter((r) => !known.has(r[0]))
    assert.equal(orphans.length, 0, `${name}: ${orphans.length} rows with no matching launch`)
  }
})

// (h)
check('field coverage maps name real headers on the right sheet', () => {
  for (const { type, sheet, fields } of FIELD_COVERAGE) {
    const headers = new Set(DATA_SHEETS.find((s) => s.name === sheet).columns.map(headerOf))
    for (const [field, target] of Object.entries(fields)) {
      const isSheet = target.endsWith(' sheet') && SHEET_NAMES.includes(target.slice(0, -' sheet'.length))
      assert.ok(isSheet || headers.has(target), `${type}.${field} -> "${target}" is not a header on ${sheet}`)
    }
  }
})

// The coverage map a source path's first segment points into.
const coverage = Object.fromEntries(FIELD_COVERAGE.map((c) => [c.type, c.fields]))
const COVERAGE_OF = {
  status: 'LaunchStatus',
  boosters: 'Booster',
  payloads: 'LaunchPayload',
  agencies: 'Agency',
  vidUrls: 'MediaLink',
  infoUrls: 'MediaLink',
}

/** The header FIELD_COVERAGE says exports the field `source` names. */
function coveredHeader(source) {
  const m = /^(\w+)(?:\[\])?\.(\w+)\b/.exec(source)
  if (!m) return coverage.Launch[source]
  assert.ok(COVERAGE_OF[m[1]], `"${source}": no coverage map for ${m[1]} — add it to COVERAGE_OF`)
  return coverage[COVERAGE_OF[m[1]]][m[2]]
}

// Each column's `source` and the FIELD_COVERAGE maps are two separate
// statements of which field a header exports. Check (f) trusts the first, so
// make it agree with the second: remapping "Rocket" to rocketFullName then
// fails unless LAUNCH_FIELDS is changed too.
check('raw columns read the field FIELD_COVERAGE assigns to their header', () => {
  const bad = []
  for (const s of DATA_SHEETS) {
    for (const column of s.columns) {
      const header = headerOf(column)
      // Derived and computed columns aren't a single field; counts like
      // "boosters.length" are checked by value in (f).
      if (column.derived || COMPUTED[header] || column.source.endsWith('.length')) continue
      const covered = coveredHeader(column.source)
      if (covered !== header) {
        bad.push(`${s.name} / ${header}: source "${column.source}" is the field for "${covered}"`)
      }
    }
  }
  assert.equal(bad.length, 0, bad.join('\n'))
})

// (i)
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
})

check('raw XML: frozen header row everywhere, and columns A:B on data sheets', () => {
  model.sheets.forEach((s) => {
    const pane = xmlFiles[sheetFiles.get(s.name)].match(/<pane [^>]*\/>/)?.[0]
    assert.ok(pane, `${s.name}: no <pane>`)
    assert.match(pane, /state="frozen"/, `${s.name}: ${pane}`)
    assert.match(pane, /ySplit="1"/, `${s.name}: ${pane}`)
    const xSplit = DATA_SHEETS.some((d) => d.name === s.name) ? '2' : '0'
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

// (j)
check('build stats: no invalid dates, no clamped cells, stripped chars as expected', () => {
  assert.equal(stats.invalidDates, 0, `${stats.invalidDates} unparsable dates in the snapshot`)
  assert.equal(stats.clampedCells, 0, `${stats.clampedCells} cells over 32,767 characters`)
  assert.equal(stats.strippedChars, expectedStripped, 'stripped-character count disagrees with the source')
  console.log(`      ${stats.strippedChars} unwritable character(s) removed from source text`)
  for (const [name, rows] of read) {
    for (const row of rows) {
      for (const cell of row) {
        if (typeof cell === 'string') assert.ok(cell.length <= MAX_CELL_CHARS, `${name}: oversized cell`)
      }
    }
  }
})

// (k)
check('spot check: Falcon Heavy launch 521f3a1c... has 3 Boosters rows', () => {
  const id = '521f3a1c-f977-4306-9b7f-495858719adf'
  const source = launches.find((l) => l.id === id)
  assert.ok(source, 'spot-check launch missing from snapshot')
  const [header, ...data] = read.get('Boosters')
  const rows = data.filter((r) => r[0] === id)
  assert.equal(rows.length, source.boosters.length)
  assert.equal(rows.length, 3)
  const position = header.indexOf('Booster position')
  assert.deepEqual(rows.map((r) => r[position]), [1, 2, 3])
})

check('first and last Launches rows match the model exactly', () => {
  const sheet = model.sheets.find((s) => s.name === 'Launches')
  const rows = read.get('Launches')
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
})

// (l)
check('file name is true UTC from generatedAt, with a fallback', () => {
  const d = new Date(meta.generatedAt)
  const pad = (n) => String(n).padStart(2, '0')
  const expected =
    `spacex-launches_${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z.xlsx`
  assert.equal(exportFileName(meta), expected)
  assert.equal(
    exportFileName({ generatedAt: '2026-09-22T16:57:04.737Z' }),
    'spacex-launches_2026-09-22_1657Z.xlsx',
  )
  assert.equal(exportFileName({ generatedAt: 'not a date' }), 'spacex-launches.xlsx')
  console.log(`      ${exportFileName(meta)}`)
})

// (m)
check('determinism: two builds with the same exportedAt are deep-equal', () => {
  const again = buildWorkbook({ meta, launches }, { exportedAt: new Date(EXPORTED_AT) })
  assert.deepEqual(again.model, model)
  assert.deepEqual(again.stats, stats)
})

/* ---------------------------- guard rails --------------------------------- */

// The cell rules exist for data the current snapshot doesn't happen to
// contain, so exercise them on a doctored copy of one launch.
const doctored = {
  ...launches[0],
  windowStart: 'not a date',
  missionName: 'Bad\u0001chars\uFFFE here',
  missionDescription: 'x'.repeat(MAX_CELL_CHARS + 10),
}
const doctoredBuild = buildWorkbook({ meta, launches: [doctored] }, { exportedAt: EXPORTED_AT })
const doctoredBlob = await modelToBlob(doctoredBuild.model)
const doctoredRead = await readXlsxFile(Buffer.from(await doctoredBlob.arrayBuffer()), { trim: false })

check('guard: invalid date -> blank cell (not a NaN serial), and counted', () => {
  assert.equal(doctoredBuild.stats.invalidDates, 1)
  const launchesSheet = doctoredRead.find((s) => s.sheet === 'Launches').data
  const col = launchesSheet[0].indexOf('Window start (UTC)')
  assert.equal(launchesSheet[1][col] ?? null, null)
})

check('guard: unwritable characters stripped and over-long text clamped, both counted', () => {
  assert.equal(doctoredBuild.stats.strippedChars, 2)
  assert.equal(doctoredBuild.stats.clampedCells, 1)
  const row = doctoredRead.find((s) => s.sheet === 'Launches').data
  assert.equal(row[1][row[0].indexOf('Mission')], 'Badchars here')
  assert.equal(row[1][row[0].indexOf('Mission description')].length, MAX_CELL_CHARS)
})

check('guard: autoFilter hook throws loudly if write-excel-file output changes', () => {
  const feature = autoFilterFeature(model.sheets)
  const t = feature.files.transform
  assert.throws(
    () => t['xl/worksheets/sheet{id}.xml'].transform('<worksheet/>', {}, { sheetIndex: 1, sheetId: '2' }),
    /autoFilter hook could not find <\/sheetData>/,
  )
  assert.throws(() => t['xl/workbook.xml'].transform('<workbook/>', []), /could not find <definedNames\/>/)
})

/* --------------------------------- done ----------------------------------- */

function columnLetter(n) {
  let s = ''
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s
  return s
}

// Compare this line between TZ=UTC and TZ=Pacific/Auckland runs: identical
// digests mean no date moved with the machine's time zone. (A plain run
// already uses Pacific/Auckland; see the top of the file.)
const digest = createHash('sha256').update(dateTimes.join(',')).digest('hex').slice(0, 16)
console.log('='.repeat(62))
console.log(`${dateTimes.length} date-time cells, digest ${digest}`)

if (failures) {
  console.log(`\n${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nAll checks passed.')
