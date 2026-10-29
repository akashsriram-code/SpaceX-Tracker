import { FileSpreadsheet, Loader2 } from 'lucide-react'
import { useState } from 'react'
import type { Launch, Snapshot, StarlinkSnapshot } from '../lib/types'

/**
 * "Download spreadsheet": the whole snapshot as one multi-sheet .xlsx, built
 * in the browser from the same data the header is showing. "Download
 * satellites" on the Starlink tab does the same for the satellite catalogue.
 *
 * The builder lives in src/lib/export/ and is only ever imported
 * dynamically below — never statically — so the writer stays out of the
 * initial bundle (see the note in src/lib/export/xlsx.ts). Hovering or
 * focusing the button starts that download early, so it's usually loaded
 * by the time of the click.
 */

type State = 'idle' | 'working' | 'error'

type Built = { blob: Blob; fileName: string }

const prefetchExporter = () => {
  // Vite dedupes this with the import in each build(); a failure here is
  // retried (and reported) there.
  void import('../lib/export/xlsx').catch(() => {})
}

/**
 * GitHub Pages redeploys every 4 hours and old hashed chunks disappear, so
 * a tab opened before a deploy can fail to load the exporter. Each browser
 * words that differently.
 */
function isChunkLoadError(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    /dynamically imported module|Failed to fetch|Importing a module script failed/i.test(err.message)
  )
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

interface SpreadsheetButtonProps {
  /** Loads the exporter and builds the file; called once per click. */
  build: () => Promise<Built>
  label: string
  hint: string
  /** Unique per page, so two buttons' aria-describedby never collide. */
  hintId: string
  prefetch: () => void
}

/** The shared idle → working → idle/error state machine behind both buttons. */
function SpreadsheetButton({ build, label, hint, hintId, prefetch }: SpreadsheetButtonProps) {
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const working = state === 'working'

  async function run() {
    // aria-disabled (not `disabled`) keeps keyboard focus on the button
    // while it works, so double clicks are guarded here instead.
    if (working) return
    setState('working')
    setError(null)
    setAnnouncement('Preparing spreadsheet…')

    // Let the browser paint "Preparing…" first. Once the chunk is prefetched
    // the import below resolves at once, and building the workbook then
    // blocks the main thread for a few hundred ms; without this yield the
    // spinner never shows and the page just looks frozen. A frame callback
    // runs before the paint, so the timeout it schedules runs after it.
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))

    try {
      const { blob, fileName } = await build()
      saveBlob(blob, fileName)
      setState('idle')
      setAnnouncement(`Download started: ${fileName}`)
    } catch (err) {
      console.error('Spreadsheet export failed', err)
      const message = isChunkLoadError(err)
        ? "The exporter couldn't load — a newer version of the site may have been deployed. Reload the page and try again."
        : "Couldn't build the spreadsheet. Please try again."
      setState('error')
      setError(message)
      setAnnouncement('')
    }
  }

  return (
    <div className="mt-2 flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        aria-disabled={working}
        aria-busy={working}
        aria-describedby={hintId}
        className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-disabled:cursor-progress aria-disabled:opacity-70"
      >
        {working ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <FileSpreadsheet className="size-3.5" aria-hidden />
        )}
        {working ? 'Preparing…' : state === 'error' ? 'Try again' : label}
      </button>
      <p id={hintId} className="font-mono text-[0.6rem] text-white/25">
        {hint}
      </p>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      {error && (
        <p role="alert" className="max-w-64 text-right text-[0.7rem] text-crimson/80">
          {error}
        </p>
      )}
    </div>
  )
}

/** The header button: every launch in the snapshot. */
export function DownloadButton({ snapshot }: { snapshot: Snapshot }) {
  return (
    <SpreadsheetButton
      build={async () => {
        const { buildSnapshotXlsx } = await import('../lib/export/xlsx')
        return buildSnapshotXlsx(snapshot, { exportedAt: new Date() })
      }}
      label="Download spreadsheet"
      hint={`All ${snapshot.meta.launchCount} launches · every field · .xlsx`}
      hintId="dl-hint"
      prefetch={prefetchExporter}
    />
  )
}

/**
 * The Starlink tab's button: every satellite, reentered ones included.
 * `launches` is only used to link each satellite to its LL2 launch.
 */
export function StarlinkDownloadButton({
  snapshot,
  launches,
}: {
  snapshot: StarlinkSnapshot
  launches: Launch[]
}) {
  return (
    <SpreadsheetButton
      build={async () => {
        const { buildStarlinkXlsx } = await import('../lib/export/xlsx')
        return buildStarlinkXlsx(snapshot, launches, { exportedAt: new Date() })
      }}
      label="Download satellites"
      hint={`All ${snapshot.satellites.length.toLocaleString('en-US')} satellites · every field · .xlsx`}
      hintId="dl-hint-starlink"
      prefetch={prefetchExporter}
    />
  )
}
