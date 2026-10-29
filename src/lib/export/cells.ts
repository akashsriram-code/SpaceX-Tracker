/**
 * The cell layer both spreadsheet exports share: how a value becomes a typed
 * cell, how a header is named, and the About and Columns sheets every
 * workbook carries.
 *
 * Nothing here knows about launches or satellites. workbook.ts (the launch
 * snapshot) and starlinkWorkbook.ts (the satellite catalogue) each decide
 * WHICH rows and columns exist; this module decides what a blank, a date or a
 * stray control character turns into, so the two files can't disagree about
 * that.
 *
 * Like the builders that use it, it is format-neutral (no spreadsheet
 * library) and pure, so it runs unchanged under tsx in the verify scripts.
 */

import type { ColumnInfo, ColumnKind, RawValue } from './schema'

/**
 * The launch schema's kinds plus 'date': a calendar day with no time of day.
 * GCAT dates are day-precision, and showing them as "2026-10-27 00:00:00"
 * would claim a precision the source doesn't have. Kept here rather than in
 * schema.ts so the launch columns' type is untouched.
 */
export type CellKind = ColumnKind | 'date'

/** ColumnInfo, widened to accept every CellKind. */
export interface SheetColumnInfo extends Omit<ColumnInfo, 'kind'> {
  kind: CellKind
}

export interface SheetColumnSpec<R> extends SheetColumnInfo {
  value: (row: R) => RawValue
}

/** A cell after conversion. `null` is a blank cell — never FALSE, 0 or ''. */
export type CellValue = string | number | boolean | Date | null

export interface ModelColumn {
  /** Final header, including the " (derived)" suffix. */
  header: string
  kind: CellKind
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

/* ------------------------------ cell rules -------------------------------- */

const DERIVED_SUFFIX = ' (derived)'

/** The one place a derived column gets its " (derived)" header suffix. */
export function headerOf(column: Pick<SheetColumnInfo, 'header' | 'derived'>): string {
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
export class CellConverter {
  stats: BuildStats = { invalidDates: 0, strippedChars: 0, clampedCells: 0 }

  /**
   * Converts one value according to its column's declared kind. A value of
   * the wrong JS type means the schema is mapping the wrong field, so that
   * throws rather than writing something plausible-looking.
   */
  cell(kind: CellKind, value: RawValue | Date, header: string): CellValue {
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
      case 'date':
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
   * shows UTC wall-clock time whatever the viewer's time zone. A date-only
   * "YYYY-MM-DD" parses as UTC midnight, so 'date' cells need no special case.
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

/**
 * CelesTrak writes epochs in UTC but without a zone suffix
 * ("2026-10-28T06:47:15"), and JavaScript reads a zone-less date-time as
 * LOCAL time — which would shift every epoch by the exporter's offset. Marks
 * such strings as UTC; date-only strings are already UTC and are left alone.
 *
 * Also cuts CelesTrak's microseconds (meta.gp.maxEpoch is
 * "…07:55:53.549760") to milliseconds: the ECMAScript date format allows
 * exactly three fraction digits, and a longer string falls through to each
 * engine's own parser, which older Safari answers with Invalid Date — a
 * blank cell for some viewers only.
 */
export function zonelessAsUtc(iso: string | null): string | null {
  if (!iso || !iso.includes('T') || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso)) return iso
  return iso.replace(/(\.\d{3})\d+$/, '$1') + 'Z'
}

/* ------------------------------ sheet helpers ----------------------------- */

export const KIND_LABEL: Record<CellKind, string> = {
  text: 'Text',
  url: 'URL',
  integer: 'Whole number',
  number: 'Number',
  boolean: 'TRUE/FALSE',
  datetime: 'Date-time (UTC)',
  date: 'Date (UTC)',
}

export function modelColumns(columns: readonly SheetColumnInfo[]): ModelColumn[] {
  return columns.map((c) => ({
    header: headerOf(c),
    kind: c.kind,
    width: c.width,
    derived: c.derived === true,
  }))
}

/** For the About and Columns sheets, whose columns are fixed here. */
export function plainColumns(columns: [header: string, kind: CellKind, width: number][]): ModelColumn[] {
  return columns.map(([header, kind, width]) => ({ header, kind, width, derived: false }))
}

/** A data sheet's rows, one converted cell per column spec. */
export function specRows<R>(
  columns: readonly SheetColumnSpec<R>[],
  rows: readonly R[],
  cx: CellConverter,
): CellValue[][] {
  return rows.map((row) => columns.map((c) => cx.cell(c.kind, c.value(row), c.header)))
}

const COLUMNS_GRAIN = 'One row per column on the data sheets: its type, source and meaning'

/**
 * The data dictionary. Generated from the same column specs that built the
 * data sheets, so it can't drift from the data.
 */
export function columnsSheet(
  sheets: readonly { name: string; columns: readonly SheetColumnInfo[] }[],
  cx: CellConverter,
): ModelSheet {
  return {
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
    rows: sheets.flatMap((s) =>
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
}

/** Item | Value, with each value's kind chosen per row. */
export type AboutRow = [item: string, kind: CellKind, value: RawValue | Date]

/** "Sheet: X | <grain> - N rows" for every sheet after About. */
export function sheetRowCounts(sheets: readonly ModelSheet[]): AboutRow[] {
  return sheets.map((s): AboutRow => ['Sheet: ' + s.name, 'text', `${s.grain} - ${s.rows.length} rows`])
}

export function aboutSheet(rows: readonly AboutRow[], cx: CellConverter): ModelSheet {
  return {
    name: 'About',
    grain: 'One row per item of information about this file',
    columns: plainColumns([
      ['Item', 'text', 30],
      ['Value', 'text', 110],
    ]),
    rows: rows.map(([item, kind, value]) => [
      cx.cell('text', item, 'Item'),
      cx.cell(kind, value, item),
    ]),
    freezeColumns: 0,
    autoFilter: false,
  }
}

/**
 * e.g. "spacex-launches_2026-09-22_1657Z.xlsx". Sliced straight from the ISO
 * string so it is always UTC, needs no date library, and has no colons
 * (which Windows rejects in file names). Includes the time because the
 * snapshots refresh several times a day. Falls back to "<stem>.xlsx" when
 * the timestamp is missing or malformed.
 */
export function stampedFileName(stem: string, generatedAt: string): string {
  const g = generatedAt
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(g)) return `${stem}.xlsx`
  return `${stem}_${g.slice(0, 10)}_${g.slice(11, 13)}${g.slice(14, 16)}Z.xlsx`
}
