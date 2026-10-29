/**
 * Writes a WorkbookModel as an .xlsx file, and is the entry point both
 * Download buttons lazy-load (launches in the header, satellites on the
 * Starlink tab).
 *
 * Loaded on demand so the initial bundle is unchanged; never import
 * statically from app code. Like Recharts in App.tsx: the writer and its zip
 * library are ~26 KB gzip that only someone clicking "Download spreadsheet"
 * should pay for. A static import from anywhere in the main bundle would
 * quietly pull all of it into the entry chunk — and, through
 * starlinkWorkbook.ts, every Starlink interpretation rule with it.
 *
 * This is the ONLY module that touches write-excel-file. If the library is
 * ever replaced, only this file changes. It's imported from the 'universal'
 * entry so the exact same code runs in the browser and under tsx in
 * scripts/verify-export.mjs.
 */

import writeXlsxFile, { type Cell, type Feature, type Sheet } from 'write-excel-file/universal'
import type { Launch, Snapshot, StarlinkSnapshot } from '../types'
import type { BuildStats, CellValue, ModelColumn, ModelSheet, WorkbookModel } from './cells'
import { buildStarlinkWorkbook, starlinkExportFileName } from './starlinkWorkbook'
import { buildWorkbook, exportFileName, type BuildOptions } from './workbook'

/**
 * Set on EVERY sheet, not just the ones with dates: write-excel-file throws
 * on a Date cell in a sheet without a dateFormat. Seconds are kept because
 * the snapshot has second-precision NETs.
 */
const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss'

/** For 'date' columns: day-precision source dates shouldn't show a fake 00:00:00. */
const DAY_FORMAT = 'yyyy-mm-dd'

const HEADER_FILL = '#D9E2F3'
/** Amber, so derived columns stand out from data supplied by LL2. */
const DERIVED_FILL = '#FCE8B2'

function headerCell(column: ModelColumn): Cell {
  return {
    value: column.header,
    fontWeight: 'bold',
    backgroundColor: column.derived ? DERIVED_FILL : HEADER_FILL,
    wrap: true,
  }
}

/** Wide enough for the header, up to a point; long headers wrap instead. */
function columnWidth(column: ModelColumn): number {
  return Math.max(column.width, Math.min(column.header.length + 2, 24))
}

/** 1 -> A, 26 -> Z, 27 -> AA, 46 -> AT. */
function columnLetter(n: number): string {
  let s = ''
  for (let i = n; i > 0; i = Math.floor((i - 1) / 26)) {
    s = String.fromCharCode(65 + ((i - 1) % 26)) + s
  }
  return s
}

/**
 * write-excel-file has no autofilter, so this adds one through the
 * library's supported `features` hook:
 *
 *  - each filtered sheet gets <autoFilter ref="A1:AT861"/> straight after
 *    </sheetData>, which is where the OOXML schema wants it (the library
 *    writes mergeCells, pageMargins etc. after sheetData);
 *  - xl/workbook.xml gets the hidden _xlnm._FilterDatabase name Excel
 *    expects alongside every autofilter.
 *
 * Both are text edits of the library's output, so if an upgrade changes the
 * markers this throws instead of quietly shipping a file without filters —
 * and verify-export fails the deploy.
 */
export function autoFilterFeature(sheets: readonly ModelSheet[]): Feature<Blob> {
  const filters = sheets.map((s) => {
    if (!s.autoFilter) return null
    // The name is quoted with apostrophes in the defined name below.
    if (s.name.includes("'")) throw new Error(`Sheet name can't contain an apostrophe: ${s.name}`)
    return { name: s.name, lastColumn: columnLetter(s.columns.length), lastRow: s.rows.length + 1 }
  })

  return {
    files: {
      transform: {
        'xl/worksheets/sheet{id}.xml': {
          transform: (xml, _sheetOptions, { sheetIndex }) => {
            const f = filters[sheetIndex]
            if (!f) return xml
            const autoFilter = `<autoFilter ref="A1:${f.lastColumn}${f.lastRow}"/>`
            return insertAfter(xml, '</sheetData>', autoFilter)
          },
        },
        'xl/workbook.xml': {
          transform: (xml) => {
            const names = filters.map((f, i) =>
              f
                ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">` +
                  `'${f.name}'!$A$1:$${f.lastColumn}$${f.lastRow}</definedName>`
                : '',
            )
            if (!names.some(Boolean)) return xml
            const definedNames = `<definedNames>${names.join('')}</definedNames>`
            return replaceOnce(xml, '<definedNames/>', definedNames)
          },
        },
      },
    },
  }
}

function insertAfter(xml: string, marker: string, markup: string): string {
  const at = xml.indexOf(marker)
  if (at < 0) throw markerMissing(marker)
  const end = at + marker.length
  return xml.slice(0, end) + markup + xml.slice(end)
}

// indexOf + slice rather than String.replace: the replacement contains "$",
// which replace() would treat as a substitution pattern.
function replaceOnce(xml: string, marker: string, replacement: string): string {
  const at = xml.indexOf(marker)
  if (at < 0) throw markerMissing(marker)
  return xml.slice(0, at) + replacement + xml.slice(at + marker.length)
}

function markerMissing(marker: string): Error {
  return new Error(`write-excel-file output changed: autoFilter hook could not find ${marker}`)
}

/**
 * Gives the Dates in 'date' columns the day-only format; every other cell is
 * passed through untouched. A sheet without 'date' columns (all of the
 * launch workbook) keeps its original row arrays.
 */
function withDayFormat(sheet: ModelSheet): Cell[][] {
  const dayColumns = sheet.columns.flatMap((c, i) => (c.kind === 'date' ? [i] : []))
  if (dayColumns.length === 0) return sheet.rows
  return sheet.rows.map((row) => {
    const out: Cell[] = [...row]
    for (const i of dayColumns) {
      const v: CellValue = row[i]
      if (v instanceof Date) out[i] = { value: v, format: DAY_FORMAT }
    }
    return out
  })
}

export function modelToBlob(model: WorkbookModel): Promise<Blob> {
  const sheets: Sheet<Blob>[] = model.sheets.map((s) => ({
    sheet: s.name,
    // Data cells go in as-is. The model already holds the right JS type for
    // each cell (workbook.ts chose it from the column kind), and
    // write-excel-file writes strings, numbers, booleans and Dates natively.
    // The one exception is 'date' columns, which get a per-cell day format.
    //
    // Text is never escaped with a leading apostrophe: strings go in as
    // shared strings, which Excel never evaluates, so a value like "=1+1"
    // stays text without altering the data.
    //
    // Numbers get no number format on purpose. '#,##0' would show a 1.33 kg
    // mass as "1", and '#,##0.###' leaves a stray "." on whole numbers, so
    // Excel's General format is the one that shows every value as it is.
    data: [s.columns.map(headerCell), ...withDayFormat(s)],
    columns: s.columns.map((c) => ({ width: columnWidth(c) })),
    dateFormat: DATE_FORMAT,
    stickyRowsCount: 1,
    stickyColumnsCount: s.freezeColumns,
  }))
  return writeXlsxFile(sheets, { features: [autoFilterFeature(model.sheets)] }).toBlob()
}

/** The whole snapshot as a ready-to-save .xlsx. */
export async function buildSnapshotXlsx(
  snapshot: Snapshot,
  opts: BuildOptions,
): Promise<{ blob: Blob; fileName: string; stats: BuildStats }> {
  const { model, stats } = buildWorkbook(snapshot, opts)
  const blob = await modelToBlob(model)
  return { blob, fileName: exportFileName(snapshot.meta), stats }
}

/**
 * Every Starlink satellite as a ready-to-save .xlsx. `launches` is the
 * launch snapshot, used only to link each satellite to its LL2 launch.
 */
export async function buildStarlinkXlsx(
  snapshot: StarlinkSnapshot,
  launches: readonly Launch[],
  opts: { exportedAt: Date },
): Promise<{ blob: Blob; fileName: string; stats: BuildStats }> {
  const { model, stats } = buildStarlinkWorkbook(
    { meta: snapshot.meta, satellites: snapshot.satellites, launches },
    opts,
  )
  const blob = await modelToBlob(model)
  return { blob, fileName: starlinkExportFileName(snapshot.meta), stats }
}
