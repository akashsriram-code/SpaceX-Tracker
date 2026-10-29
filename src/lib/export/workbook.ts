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
 *
 * The cell rules themselves (blanks, dates, unwritable text) and the About /
 * Columns sheet shapes live in cells.ts, shared with the Starlink workbook.
 */

import type { Launch, SnapshotMeta } from '../types'
import {
  CellConverter,
  aboutSheet,
  columnsSheet,
  modelColumns,
  sheetRowCounts,
  specRows,
  stampedFileName,
  type AboutRow,
  type BuildStats,
  type CellValue,
  type ModelSheet,
  type WorkbookModel,
} from './cells'
import {
  AGENCY_COLUMNS,
  BOOSTER_COLUMNS,
  LAUNCH_COLUMNS,
  LINK_COLUMNS,
  PAYLOAD_COLUMNS,
  type AgencyRow,
  type BoosterRow,
  type ColumnInfo,
  type ColumnSpec,
  type LinkRow,
  type PayloadRow,
} from './schema'

// Re-exported so existing imports (xlsx.ts, verify-export.mjs) keep working.
export { headerOf } from './cells'
export type { BuildStats, CellValue, ModelColumn, ModelSheet, WorkbookModel } from './cells'

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
    rows: (launches, cx) => specRows(columns, rowsOf(launches), cx),
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

export const SHEET_NAMES: readonly string[] = [
  'About',
  ...DATA_SHEETS.map((s) => s.name),
  'Columns',
]

/* -------------------------------- builder --------------------------------- */

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

  const columns = columnsSheet(DATA_SHEETS, cx)

  // Payload data is sparse upstream; say how sparse from the data itself
  // rather than from a number in the docs that goes stale.
  const payloads = launches.flatMap((l) => l.payloads)
  const withMass = payloads.filter((p) => p.massKg != null).length

  const scopeRows: AboutRow[] = opts.scopeNote ? [['Scope', 'text', opts.scopeNote]] : []

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
    ...sheetRowCounts([...dataSheets, columns]),
  ]

  return { model: { sheets: [aboutSheet(about, cx), ...dataSheets, columns] }, stats: cx.stats }
}

/** e.g. "spacex-launches_2026-09-22_1657Z.xlsx"; see stampedFileName(). */
export function exportFileName(meta: Pick<SnapshotMeta, 'generatedAt'>): string {
  return stampedFileName('spacex-launches', meta.generatedAt)
}
