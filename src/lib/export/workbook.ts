/**
 * Builds the spreadsheet as plain data: sheets, headers and typed cells.
 *
 * Format-neutral on purpose — no spreadsheet library is imported here. That
 * keeps the interesting decisions (which sheets, which rows, what a blank
 * means) testable under tsx without a browser, and means swapping the .xlsx
 * writer in xlsx.ts never touches the data rules.
 *
 * The builder is also pure: it reads only its arguments and never calls
 * Date.now(), so the same snapshot and `exportedAt` always produce the same
 * model. That's what lets verify-export.mjs compare two builds for equality.
 */

import type { Launch, SnapshotMeta } from '../types'
import {
  AGENCY_COLUMNS,
  BOOSTER_COLUMNS,
  LAUNCH_COLUMNS,
  LINK_COLUMNS,
  PAYLOAD_COLUMNS,
  type AgencyRow,
  type BoosterRow,
  type ColumnInfo,
  type ColumnKind,
  type ColumnSpec,
  type LinkRow,
  type PayloadRow,
  type RawValue,
} from './schema'

/** A cell after conversion. `null` is a blank cell — never FALSE, 0 or ''. */
export type CellValue = string | number | boolean | Date | null

export interface ModelColumn {
  /** Final header, including the " (derived)" suffix. */
  header: string
  kind: ColumnKind
  width: number
  derived: boolean
}

export interface ModelSheet {
  name: string
  grain: string
  columns: ModelColumn[]
  /** Data rows only; the header row is written from `columns`. */
  rows: CellValue[][]
  /** Columns frozen beside the frozen header row: A:B on data sheets. */
  freezeColumns: 0 | 2
  autoFilter: boolean
}

export interface WorkbookModel {
  sheets: ModelSheet[]
}

/** Values the builder had to change. All zero for a healthy snapshot. */
export interface BuildStats {
  /** Non-empty date strings that didn't parse; written as blank cells. */
  invalidDates: number
  /** Characters removed because XML (and so .xlsx) can't hold them. */
  strippedChars: number
  /** Text cells cut to Excel's 32,767-character limit. */
  clampedCells: number
}

export interface WorkbookInput {
  meta: SnapshotMeta
  launches: readonly Launch[]
}

export interface BuildOptions {
  /** Injected rather than read from the clock, so builds are reproducible. */
  exportedAt: Date
  /** Set by a future "current view" export; adds a Scope row to About. */
  scopeNote?: string
}

/* ------------------------------ cell rules -------------------------------- */

const DERIVED_SUFFIX = ' (derived)'

/** The one place a derived column gets its " (derived)" header suffix. */
export function headerOf(column: ColumnInfo): string {
  return column.derived ? column.header + DERIVED_SUFFIX : column.header
}

/** Excel's hard limit on the length of a cell's text. */
const MAX_CELL_CHARS = 32_767

/**
 * Characters an .xlsx can't hold: XML 1.0 control characters, lone
 * surrogates, Unicode non-characters, and the C1 controls / U+FFFD that
 * write-excel-file strips as "discouraged". Removing them here rather than
 * leaving it to the library keeps the model identical to what lands in the
 * file, and lets us count what was lost.
 */
const UNWRITABLE_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F\uFFFD\p{Noncharacter_Code_Point}]|\p{Cs}/gu

/**
 * Any XML reader turns "\r\n" and a lone "\r" into "\n" when it opens the
 * file, so normalise up front: the model then matches what Excel shows.
 */
const LINE_BREAK = /\r\n?/g

/** Accumulates BuildStats while converting values to cells. */
class CellConverter {
  stats: BuildStats = { invalidDates: 0, strippedChars: 0, clampedCells: 0 }

  /**
   * Converts one value according to its column's declared kind. A value of
   * the wrong JS type means the schema is mapping the wrong field, so that
   * throws rather than writing something plausible-looking.
   */
  cell(kind: ColumnKind, value: RawValue | Date, header: string): CellValue {
    if (value == null) return null
    switch (kind) {
      case 'text':
      case 'url':
        if (typeof value !== 'string') break
        return this.text(value)
      case 'integer':
      case 'number':
        if (typeof value !== 'number') break
        return Number.isFinite(value) ? value : null
      case 'boolean':
        if (typeof value !== 'boolean') break
        return value
      case 'datetime':
        if (typeof value !== 'string' && !(value instanceof Date)) break
        return this.date(value)
    }
    throw new TypeError(
      `Export column "${header}" is ${kind} but got ${typeof value}: ${String(value)}`,
    )
  }

  private text(value: string): string | null {
    let s = value.replace(LINE_BREAK, '\n')
    const cleaned = s.replace(UNWRITABLE_CHARS, '')
    this.stats.strippedChars += s.length - cleaned.length
    s = cleaned
    if (s.length > MAX_CELL_CHARS) {
      this.stats.clampedCells++
      // Don't leave half a surrogate pair at the cut.
      const cutsPair = /[\uD800-\uDBFF]/.test(s[MAX_CELL_CHARS - 1])
      s = s.slice(0, cutsPair ? MAX_CELL_CHARS - 1 : MAX_CELL_CHARS)
    }
    return s === '' ? null : s
  }

  /**
   * write-excel-file writes an Invalid Date as a NaN serial, which corrupts
   * the file, so anything unparsable becomes a blank cell and is counted.
   * The library converts with getTime() / 86400000 + 25569, so the cell
   * shows UTC wall-clock time whatever the viewer's time zone.
   */
  private date(value: string | Date): Date | null {
    if (value === '') return null
    const d = new Date(value instanceof Date ? value.getTime() : value)
    if (Number.isNaN(d.getTime())) {
      this.stats.invalidDates++
      return null
    }
    return d
  }
}

/* ------------------------------ sheet registry ---------------------------- */

/** A data sheet with its row type erased, so the registry can be one list. */
interface DataSheet {
  name: string
  grain: string
  columns: readonly ColumnInfo[]
  rows: (launches: readonly Launch[], cx: CellConverter) => CellValue[][]
}

function dataSheet<R>(
  name: string,
  grain: string,
  columns: ColumnSpec<R>[],
  rowsOf: (launches: readonly Launch[]) => R[],
): DataSheet {
  return {
    name,
    grain,
    columns,
    rows: (launches, cx) =>
      rowsOf(launches).map((row) =>
        columns.map((c) => cx.cell(c.kind, c.value(row), c.header)),
      ),
  }
}

/**
 * The five data sheets, in workbook order. Each nested array is flattened
 * onto its own sheet — one row per item, in launch order then array order —
 * so nothing is lost to a joined-up cell and every child row joins back to
 * Launches on Launch ID.
 */
export const DATA_SHEETS: readonly DataSheet[] = [
  dataSheet(
    'Launches',
    'One row per launch, newest NET first. Key: Launch ID',
    LAUNCH_COLUMNS,
    (launches) => [...launches],
  ),
  dataSheet(
    'Boosters',
    'One row per booster on a launch. Key: Launch ID + Booster position',
    BOOSTER_COLUMNS,
    (launches) =>
      launches.flatMap((launch) =>
        launch.boosters.map((booster, index): BoosterRow => ({ launch, booster, index })),
      ),
  ),
  dataSheet(
    'Payloads',
    'One row per payload on a launch. Key: Launch ID + Payload position',
    PAYLOAD_COLUMNS,
    (launches) =>
      launches.flatMap((launch) =>
        launch.payloads.map((payload, index): PayloadRow => ({ launch, payload, index })),
      ),
  ),
  dataSheet(
    'Agencies',
    'One row per mission agency on a launch. Key: Launch ID + Agency position',
    AGENCY_COLUMNS,
    (launches) =>
      launches.flatMap((launch) =>
        launch.agencies.map((agency, index): AgencyRow => ({ launch, agency, index })),
      ),
  ),
  dataSheet(
    'Links',
    'One row per video or info link on a launch. Key: Launch ID + Link group + Link position',
    LINK_COLUMNS,
    (launches) =>
      launches.flatMap((launch) => [
        ...launch.vidUrls.map((link, index): LinkRow => ({ launch, link, group: 'Video', index })),
        ...launch.infoUrls.map((link, index): LinkRow => ({ launch, link, group: 'Info', index })),
      ]),
  ),
]

const COLUMNS_GRAIN = 'One row per column on the data sheets: its type, source and meaning'

export const SHEET_NAMES: readonly string[] = [
  'About',
  ...DATA_SHEETS.map((s) => s.name),
  'Columns',
]

const KIND_LABEL: Record<ColumnKind, string> = {
  text: 'Text',
  url: 'URL',
  integer: 'Whole number',
  number: 'Number',
  boolean: 'TRUE/FALSE',
  datetime: 'Date-time (UTC)',
}

function modelColumns(columns: readonly ColumnInfo[]): ModelColumn[] {
  return columns.map((c) => ({
    header: headerOf(c),
    kind: c.kind,
    width: c.width,
    derived: c.derived === true,
  }))
}

/** For the About and Columns sheets, whose columns are fixed here. */
function plainColumns(columns: [header: string, kind: ColumnKind, width: number][]): ModelColumn[] {
  return columns.map(([header, kind, width]) => ({ header, kind, width, derived: false }))
}

/* -------------------------------- builder --------------------------------- */

type AboutRow = [item: string, kind: ColumnKind, value: RawValue | Date]

export function buildWorkbook(
  input: WorkbookInput,
  opts: BuildOptions,
): { model: WorkbookModel; stats: BuildStats } {
  const { meta, launches } = input
  const cx = new CellConverter()

  const dataSheets: ModelSheet[] = DATA_SHEETS.map((s) => ({
    name: s.name,
    grain: s.grain,
    columns: modelColumns(s.columns),
    rows: s.rows(launches, cx),
    freezeColumns: 2,
    autoFilter: true,
  }))

  // Generated from the same column specs that built the sheets above, so the
  // data dictionary can't drift from the data.
  const columnsSheet: ModelSheet = {
    name: 'Columns',
    grain: COLUMNS_GRAIN,
    columns: plainColumns([
      ['Sheet', 'text', 12],
      ['Column', 'text', 30],
      ['Type', 'text', 16],
      ['Derived', 'boolean', 9],
      ['Source', 'text', 40],
      ['Description', 'text', 80],
    ]),
    rows: DATA_SHEETS.flatMap((s) =>
      s.columns.map((c) => [
        cx.cell('text', s.name, 'Sheet'),
        cx.cell('text', headerOf(c), 'Column'),
        cx.cell('text', KIND_LABEL[c.kind], 'Type'),
        cx.cell('boolean', c.derived === true, 'Derived'),
        cx.cell('text', c.source, 'Source'),
        cx.cell('text', c.description, 'Description'),
      ]),
    ),
    freezeColumns: 0,
    autoFilter: true,
  }

  // Payload data is sparse upstream; say how sparse from the data itself
  // rather than from a number in the docs that goes stale.
  const payloads = launches.flatMap((l) => l.payloads)
  const withMass = payloads.filter((p) => p.massKg != null).length

  const scopeRows: AboutRow[] = opts.scopeNote ? [['Scope', 'text', opts.scopeNote]] : []
  const sheetRows = [...dataSheets, columnsSheet].map(
    (s): AboutRow => ['Sheet: ' + s.name, 'text', `${s.grain} - ${s.rows.length} rows`],
  )

  // Item | Value, with each value's kind chosen per row: the two timestamps
  // are real date-times and the counts are numbers.
  const about: AboutRow[] = [
    ['Dataset', 'text', 'SpaceX launches - Launch Library 2 snapshot'],
    ['Snapshot generated (UTC)', 'datetime', meta.generatedAt],
    ['Exported (UTC)', 'datetime', opts.exportedAt],
    ['Source', 'text', meta.source],
    ['Source note', 'text', meta.sourceNote],
    ['Launches in this file', 'integer', launches.length],
    ...scopeRows,
    ['Launches reported upstream', 'integer', meta.upstreamCount],
    [
      'Attribution',
      'text',
      'Launch data (c) The Space Devs - Launch Library 2, https://thespacedevs.com/. Mission patches and imagery belong to their respective owners.',
    ],
    ['Time zone', 'text', 'All date-times are UTC, stored as real Excel date-times.'],
    ['Blank cells', 'text', 'A blank cell means the source has no value (null). It never means FALSE or 0.'],
    [
      'Derived columns',
      'text',
      "Headers ending in (derived), with an amber fill, are computed by this dashboard's rules (src/lib/launch.ts), not supplied by Launch Library 2.",
    ],
    [
      'Customer attribution',
      'text',
      'Launch Library 2 has no customer field. Customers are inferred from payload customers, then Starlink detection, then contract-program name patterns, then mission agencies, then operator name patterns, then SpaceX (Internal) when SpaceX is the only agency, otherwise Undisclosed. Treat it as a label, not a contract record.',
    ],
    [
      'NET precision',
      'text',
      'NET = No Earlier Than. At Day/Month/Quarter/Year/Decade/Fiscal Year precision the date-time is a placeholder (e.g. 2029-12-31 00:00:00). Filter on NET is precise (derived).',
    ],
    [
      'Landing flags',
      'text',
      'Launch-level Reflight / Landing attempted / Landing succeeded (derived) are FALSE when Booster records = 0, because no booster data is not the same as unknown.',
    ],
    ['Turnaround', 'text', 'Turnaround (days) is converted at fetch time from LL2 ISO-8601 durations.'],
    [
      'Payload data',
      'text',
      `Payload details are rarely filled in upstream: this file has ${payloads.length} payload rows, ${withMass} with mass.`,
    ],
    [
      'Joining sheets',
      'text',
      'Every data sheet starts with Launch ID. Example: =XLOOKUP(A2, Launches!A:A, Launches!B:B)',
    ],
    ['Column reference', 'text', "See the Columns sheet for every column's type, source and meaning."],
    ...sheetRows,
  ]

  const aboutSheet: ModelSheet = {
    name: 'About',
    grain: 'One row per item of information about this file',
    columns: plainColumns([
      ['Item', 'text', 30],
      ['Value', 'text', 110],
    ]),
    rows: about.map(([item, kind, value]) => [
      cx.cell('text', item, 'Item'),
      cx.cell(kind, value, item),
    ]),
    freezeColumns: 0,
    autoFilter: false,
  }

  return { model: { sheets: [aboutSheet, ...dataSheets, columnsSheet] }, stats: cx.stats }
}

/**
 * e.g. "spacex-launches_2026-09-22_1657Z.xlsx". Sliced straight from the ISO
 * string so it is always UTC, needs no date library, and has no colons
 * (which Windows rejects in file names). Includes the time because the
 * snapshot refreshes several times a day.
 */
export function exportFileName(meta: Pick<SnapshotMeta, 'generatedAt'>): string {
  const g = meta.generatedAt
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(g)) return 'spacex-launches.xlsx'
  return `spacex-launches_${g.slice(0, 10)}_${g.slice(11, 13)}${g.slice(14, 16)}Z.xlsx`
}
