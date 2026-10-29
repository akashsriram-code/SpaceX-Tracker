/**
 * Builds the Starlink satellite spreadsheet as plain data: About,
 * Satellites, Versions and Columns.
 *
 * The satellite counterpart of workbook.ts, sharing its cell rules through
 * cells.ts and its guarantees: no spreadsheet library, no DOM, and pure — it
 * reads only its arguments (ages are measured to the snapshot's generatedAt,
 * never the clock), so scripts/verify-starlink-export.mjs can compare two
 * builds for equality.
 *
 * Kept a separate workbook from the launch export on purpose: the two are
 * different grains from different sources, refreshed on different schedules,
 * and the launch file is already one people rely on as is.
 */

import { indexStarlinkLaunches, launchFor } from '../starlink'
import { computeStarlinkKpis, versionBreakdown } from '../starlinkStats'
import type { Launch, Satellite, StarlinkMeta } from '../types'
import {
  CellConverter,
  aboutSheet,
  columnsSheet,
  modelColumns,
  sheetRowCounts,
  specRows,
  stampedFileName,
  zonelessAsUtc,
  type AboutRow,
  type BuildStats,
  type ModelSheet,
  type WorkbookModel,
} from './cells'
import { SATELLITE_COLUMNS, VERSION_COLUMNS, type SatelliteRow } from './starlinkSchema'

export interface StarlinkWorkbookInput {
  meta: StarlinkMeta
  satellites: readonly Satellite[]
  /** The launch snapshot, used only to link each satellite to its LL2 launch. */
  launches: readonly Launch[]
}

export interface StarlinkBuildOptions {
  /** Injected rather than read from the clock, so builds are reproducible. */
  exportedAt: Date
}

export const STARLINK_DATA_SHEETS = [
  {
    name: 'Satellites',
    grain: 'One row per Starlink satellite ever launched, newest launch first. Key: GCAT ID (NORAD where catalogued)',
    columns: SATELLITE_COLUMNS,
  },
  {
    name: 'Versions',
    grain: 'One row per hardware version, oldest first. Key: Version',
    columns: VERSION_COLUMNS,
  },
] as const

export const STARLINK_SHEET_NAMES: readonly string[] = [
  'About',
  ...STARLINK_DATA_SHEETS.map((s) => s.name),
  'Columns',
]

/** fetch-starlink.mjs's exclusion counters, as a reader would name them. */
const EXCLUSION_LABEL: Record<string, string> = {
  testArticles: 'test articles and simulators',
  starshield: 'Starshield',
  nonPayload: 'non-payload objects (deployment rails, adapters, debris)',
  nonSpaceX: 'not SpaceX-owned',
}

export function buildStarlinkWorkbook(
  input: StarlinkWorkbookInput,
  opts: StarlinkBuildOptions,
): { model: WorkbookModel; stats: BuildStats } {
  const { meta, satellites, launches } = input
  const asOf = meta.generatedAt
  const cx = new CellConverter()

  const index = indexStarlinkLaunches([...launches])
  const satelliteRows = satellites.map(
    (sat): SatelliteRow => ({ sat, asOf, launch: launchFor(sat, index) }),
  )
  const versions = versionBreakdown([...satellites])

  const [satSpec, versionSpec] = STARLINK_DATA_SHEETS
  const dataSheets: ModelSheet[] = [
    {
      name: satSpec.name,
      grain: satSpec.grain,
      columns: modelColumns(satSpec.columns),
      rows: specRows(satSpec.columns, satelliteRows, cx),
      freezeColumns: 2,
      autoFilter: true,
    },
    {
      name: versionSpec.name,
      grain: versionSpec.grain,
      columns: modelColumns(versionSpec.columns),
      rows: specRows(versionSpec.columns, versions, cx),
      freezeColumns: 2,
      autoFilter: true,
    },
  ]

  const columns = columnsSheet(STARLINK_DATA_SHEETS, cx)

  // Counts come from the same rules as the tab's KPI row, so the About sheet
  // and the dashboard header can't show different totals.
  const kpis = computeStarlinkKpis([...satellites], asOf)
  const linked = satelliteRows.filter((r) => r.launch).length

  const ref = meta.reference
  const referenceRows: AboutRow[] = ref
    ? [
        ['Reference: McDowell stats as of (UTC)', 'datetime', ref.asOf],
        ['Reference: launched', 'integer', ref.total.launched],
        ['Reference: in orbit', 'integer', ref.total.inOrbit],
        ['Reference: working', 'integer', ref.total.working],
        ['Reference: in operational shell', 'integer', ref.total.operational],
        [
          'Reference note',
          'text',
          "Totals published on McDowell's Starlink stats page (planet4589.org/space/con/star/stats.html), for reconciliation only. Small differences are timing: the two are updated separately.",
        ],
      ]
    : []

  const exclusionRows = Object.entries(meta.excluded).map(
    ([key, n]): AboutRow => [`Excluded: ${EXCLUSION_LABEL[key] ?? key}`, 'integer', n],
  )

  const gpRows: AboutRow[] = meta.gp
    ? [
        ['GP newest epoch (UTC)', 'datetime', zonelessAsUtc(meta.gp.maxEpoch)],
        ['GP element sets', 'integer', meta.gp.rows],
        ['GP fetch status', 'text', String(meta.gp.status)],
      ]
    : []

  const fileRows = Object.entries(meta.files).map(
    ([key, f]): AboutRow => [
      `Source file: ${key}`,
      'text',
      `${f.url} - updated ${f.updated ?? 'not stated'}, fetch status ${String(f.status)}`,
    ],
  )

  const about: AboutRow[] = [
    ['Dataset', 'text', 'Starlink satellites - GCAT catalogue joined with CelesTrak GP orbits'],
    ['Snapshot generated (UTC)', 'datetime', meta.generatedAt],
    ['GCAT updated (UTC)', 'datetime', meta.gcatUpdated],
    ['Exported (UTC)', 'datetime', opts.exportedAt],
    ['Source', 'text', meta.source],
    ['Satellites in this file', 'integer', satellites.length],
    ['Satellites in orbit', 'integer', kpis.inOrbit],
    ['Satellites working', 'integer', kpis.working],
    ['Satellites in operational shell', 'integer', kpis.operational],
    ['Satellites reentered', 'integer', kpis.reentered],
    ['Satellites linked to an LL2 launch', 'integer', linked],
    ...referenceRows,
    ...exclusionRows,
    [
      'Exclusions',
      'text',
      'Every Starlink ever launched is included, reentered ones and launch failures too. Starshield, simulators/test articles and non-payload objects are left out; Tintin prototypes are kept (Version = Tintin).',
    ],
    ...gpRows,
    ...fileRows,
    ['Attribution', 'text', meta.attribution],
    [
      'Licence and changes',
      'text',
      'GCAT is licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/), filtered and reformatted: this file keeps only SpaceX Starlink satellites, joins them to CelesTrak GP elements and LL2 launches, and adds derived columns. The derived columns are this dashboard\'s interpretation, not McDowell\'s.',
    ],
    ['Time zone', 'text', 'All dates and date-times are UTC, stored as real Excel dates. GCAT dates are day precision.'],
    ['Blank cells', 'text', 'A blank cell means the source has no value (null). It never means FALSE or 0.'],
    [
      'Derived columns',
      'text',
      "Headers ending in (derived), with an amber fill, are computed by this dashboard's rules (src/lib/starlink.ts and src/lib/starlinkStats.ts), not supplied by GCAT or CelesTrak.",
    ],
    [
      'Definition: Working',
      'text',
      "McDowell's \"working\": in orbit and not failed (flag F screened, M failed and decaying, or G graveyard). Satellites being raised, drifted or lowered still count.",
    ],
    [
      'Definition: In operational shell',
      'text',
      'In orbit with GCAT lifecycle flag O (Type byte 8): in its operational shell right now. The strictest meaning of "active".',
    ],
    [
      'Definition: Reentry cause',
      'text',
      'Failed to orbit (GCAT launch-failure designator), Disposal (flag R, controlled lowering), Early deorbit (F), Reentry after failure (M), otherwise Other.',
    ],
    [
      'Caveat: version',
      'text',
      'Version is derived from GCAT psatcat Program, falling back to Bus and the payload name. v1.5 is never written out by GCAT: it is inferred from launch Groups 2-5 on the V1 bus.',
    ],
    [
      'Caveat: altitude',
      'text',
      'Altitudes are the latest catalogued orbit (GCAT) or CelesTrak GP mean elements, whichever is newer - not a live position. Orbit stale (derived) flags orbits more than 14 days older than the snapshot.',
    ],
    [
      'Caveat: uncatalogued losses',
      'text',
      'Satellites lost before the US catalogue numbered them (e.g. the Feb 2022 storm batch) have no NORAD id; GCAT ID still identifies them.',
    ],
    [
      'Caveat: Gen1 / Gen2',
      'text',
      'FCC "Gen1/Gen2" are licence authorisations, not hardware; some v2 Minis fly in Gen1-licensed shells. Version and Family describe hardware only.',
    ],
    [
      'Joining to the launch workbook',
      'text',
      'COSPAR launch matches COSPAR launch ID on its Launches sheet, and LL2 launch ID (derived) matches Launch ID.',
    ],
    ['Column reference', 'text', "See the Columns sheet for every column's type, source and meaning."],
    ...sheetRowCounts([...dataSheets, columns]),
  ]

  return { model: { sheets: [aboutSheet(about, cx), ...dataSheets, columns] }, stats: cx.stats }
}

/** e.g. "starlink-satellites_2026-10-29_1518Z.xlsx"; see stampedFileName(). */
export function starlinkExportFileName(meta: Pick<StarlinkMeta, 'generatedAt'>): string {
  return stampedFileName('starlink-satellites', meta.generatedAt)
}
