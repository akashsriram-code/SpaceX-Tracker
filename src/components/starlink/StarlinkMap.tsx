import { Pause, Play, Radio, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStarlinkGp } from '../../hooks/useStarlink'
import {
  MAP_SPEEDS,
  MAX_ELEMENT_AGE_MS,
  useSatellitePositions,
  type PositionStats,
  type SatellitePositions,
} from '../../hooks/useSatellitePositions'
import {
  ageDays,
  displayName,
  isInOrbit,
  lifecyclePhase,
  PHASE_COLORS,
  PHASE_ORDER,
  starlinkVersion,
  VERSION_ORDER,
  versionColor,
  versionVariant,
  type LifecyclePhase,
  type StarlinkVersion,
} from '../../lib/starlink'
import type { GpElements, Satellite } from '../../lib/types'
import { cn, formatInt } from '../../lib/utils'
import { ErrorState, LoadingState } from '../ui/States'
import { StarlinkMap2D } from './StarlinkMap2D'

/**
 * The globe pulls in three.js (~100 KB gzip), so it is its own chunk and is
 * only requested the first time someone switches to 3D.
 */
const StarlinkGlobe3D = lazy(() =>
  import('./StarlinkGlobe3D').then((m) => ({ default: m.StarlinkGlobe3D })),
)

/**
 * Everything a view needs to draw and label satellite i, where i indexes the
 * worker's arrays. Rebuilt only when the worker is re-initialised, never per
 * tick.
 */
export interface MapLayer {
  norads: Int32Array
  sats: Satellite[]
  /** Index into VERSION_ORDER per satellite. */
  version: Uint8Array
  /** Satellite indexes per VERSION_ORDER entry, so views can draw by colour batch. */
  byVersion: Int32Array[]
  /** Satellite count per PHASE_ORDER entry, for the legend. */
  phaseCounts: number[]
  indexOf: Map<number, number>
}

export interface MapViewProps {
  layer: MapLayer
  positions: SatellitePositions | null
  /** 1 where satellite i passes the legend's version and phase filters. */
  shown: Uint8Array
  /** -1 when nothing (plottable) is selected. */
  selectedIndex: number
  track: Float32Array | null
  onSelect: (norad: number | null) => void
  /** Text alternative for the canvas; the satellite table is the full equivalent. */
  label: string
  reducedMotion: boolean
}

type ViewMode = '2d' | '3d'

/** Re-request the ground track once the clock has moved this far from its centre. */
const TRACK_REFRESH_MS = 20 * 60_000

let webglSupport: boolean | null = null

/** Probed once, and the probe context released, so it doesn't count against the browser's limit. */
function hasWebGL(): boolean {
  if (webglSupport != null) return webglSupport
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
    webglSupport = gl != null
  } catch {
    webglSupport = false
  }
  return webglSupport
}

/** GP epochs are UTC with no zone suffix, e.g. 2026-10-28T06:47:15.987552. */
const formatEpoch = (epoch: string) => `${epoch.slice(0, 16).replace('T', ' ')} UTC`
const formatClock = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`
const epochMs = (epoch: string) => Date.parse(epoch.endsWith('Z') ? epoch : `${epoch}Z`)

function toggled<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set)
  if (next.has(item)) next.delete(item)
  else next.add(item)
  return next
}

function formatLatLon(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S'
  const ew = lon >= 0 ? 'E' : 'W'
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`
}

function ToggleButton({
  active,
  onClick,
  disabled,
  children,
  title,
  pressable = true,
}: {
  active: boolean
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
  title?: string
  /**
   * False for a button whose label already flips (Pause ↔ Play): announcing
   * "Play, pressed" as well would contradict what it does.
   */
  pressable?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={pressable ? active : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-all disabled:opacity-40',
        active
          ? 'bg-accent/15 text-accent shadow-[inset_0_0_0_1px_rgba(56,189,248,0.25)]'
          : 'text-white/45 hover:bg-white/5 hover:text-white/75',
      )}
    >
      {children}
    </button>
  )
}

export function StarlinkMap({
  satellites,
  asOf,
  selectedNorad,
  onSelect,
}: {
  satellites: Satellite[]
  /** The catalogue's generatedAt — ages are measured to it, as everywhere on the tab. */
  asOf: string
  selectedNorad: number | null
  onSelect: (norad: number | null) => void
}) {
  const gp = useStarlinkGp()
  const sectionRef = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(true)
  const [mode, setMode] = useState<ViewMode>('2d')
  const [notice, setNotice] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<StarlinkVersion>>(() => new Set())
  const [hiddenPhases, setHiddenPhases] = useState<ReadonlySet<LifecyclePhase>>(() => new Set())

  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    // A margin so ticks resume just before the map scrolls into view.
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '200px 0px',
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const byNorad = useMemo(() => {
    const m = new Map<number, Satellite>()
    for (const s of satellites) if (s.norad != null) m.set(s.norad, s)
    return m
  }, [satellites])

  // Only satellites the catalogue says are still up get a dot. CelesTrak can
  // briefly keep elements for something GCAT has already marked reentered,
  // and plotting it would contradict every count on the tab.
  const join = useMemo(() => {
    if (!gp.data) return null
    const elements: GpElements[] = []
    const elementOf = new Map<number, GpElements>()
    let newest = ''
    let unmatched = 0
    for (const e of gp.data.elements) {
      if (e.epoch > newest) newest = e.epoch
      const s = byNorad.get(e.norad)
      if (s && isInOrbit(s)) {
        elements.push(e)
        elementOf.set(e.norad, e)
      } else {
        unmatched++
      }
    }
    let inOrbit = 0
    let noElements = 0
    for (const s of satellites) {
      if (!isInOrbit(s)) continue
      inOrbit++
      if (s.norad == null || !elementOf.has(s.norad)) noElements++
    }
    return { elements, elementOf, newest, unmatched, inOrbit, noElements }
  }, [gp.data, byNorad, satellites])

  const map = useSatellitePositions({ elements: join?.elements ?? null, visible })
  const { positions, ready, simTimeMs, requestTrack, stats } = map

  const norads = positions?.norads ?? null
  const layer = useMemo((): MapLayer | null => {
    if (!norads) return null
    const n = norads.length
    const sats: Satellite[] = new Array(n)
    const version = new Uint8Array(n)
    const buckets: number[][] = VERSION_ORDER.map(() => [])
    const phaseCounts = PHASE_ORDER.map(() => 0)
    const indexOf = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      // Every element passed to the worker was matched to a catalogue entry above.
      const s = byNorad.get(norads[i]) as Satellite
      const v = VERSION_ORDER.indexOf(starlinkVersion(s))
      sats[i] = s
      version[i] = v
      buckets[v].push(i)
      phaseCounts[PHASE_ORDER.indexOf(lifecyclePhase(s))]++
      indexOf.set(norads[i], i)
    }
    return { norads, sats, version, byVersion: buckets.map((b) => Int32Array.from(b)), phaseCounts, indexOf }
  }, [norads, byNorad])

  // One per-satellite mask, so neither view has to know which filters exist.
  const shown = useMemo(() => {
    if (!layer) return new Uint8Array(0)
    const mask = new Uint8Array(layer.sats.length)
    for (let i = 0; i < mask.length; i++) {
      mask[i] =
        !hidden.has(VERSION_ORDER[layer.version[i]]) && !hiddenPhases.has(lifecyclePhase(layer.sats[i])) ? 1 : 0
    }
    return mask
  }, [layer, hidden, hiddenPhases])
  const toggleVersion = useCallback((v: StarlinkVersion) => setHidden((prev) => toggled(prev, v)), [])
  const togglePhase = useCallback((p: LifecyclePhase) => setHiddenPhases((prev) => toggled(prev, p)), [])

  const selectedIndex = selectedNorad != null ? (layer?.indexOf.get(selectedNorad) ?? -1) : -1

  // Ground track for the selection, from the table or a click on the map.
  // Kept centred on the clock so it still leads the dot at ×600.
  const [track, setTrack] = useState<{ norad: number; points: Float32Array } | null>(null)
  const trackReq = useRef<{ norad: number; centerMs: number } | null>(null)
  useEffect(() => {
    if (!ready || selectedNorad == null || selectedIndex < 0) {
      trackReq.current = null
      setTrack(null)
      return
    }
    const req = trackReq.current
    if (req && req.norad === selectedNorad && Math.abs(simTimeMs - req.centerMs) < TRACK_REFRESH_MS) return
    const next = { norad: selectedNorad, centerMs: simTimeMs }
    trackReq.current = next
    requestTrack(selectedNorad).then((points) => {
      if (trackReq.current === next) setTrack({ norad: next.norad, points })
    })
  }, [ready, selectedNorad, selectedIndex, simTimeMs, requestTrack])

  const chooseMode = (next: ViewMode) => {
    if (next === '3d' && !hasWebGL()) {
      setNotice('The 3D globe needs WebGL, which this browser has turned off — showing the flat map instead.')
      setMode('2d')
      return
    }
    setNotice(null)
    setMode(next)
  }
  const onGlobeUnavailable = useCallback(() => {
    setNotice('Couldn’t start WebGL for the 3D globe — showing the flat map instead.')
    setMode('2d')
  }, [])

  const clock = formatClock(simTimeMs)
  const label = `${formatInt(stats.plotted)} Starlink satellites plotted, positions as of ${clock}. The satellite table below lists the same satellites.`
  // A track is only as trustworthy as the dot: once the element set is past
  // the age cut-off (or SGP4 fails) neither is drawn.
  const selectedPlotted = selectedIndex >= 0 && positions?.ok[selectedIndex] === 1
  const viewProps: MapViewProps | null = layer
    ? {
        layer,
        positions,
        shown,
        selectedIndex,
        track: track && track.norad === selectedNorad && selectedPlotted ? track.points : null,
        onSelect,
        label,
        reducedMotion: map.reducedMotion,
      }
    : null

  const selected = selectedNorad != null ? (byNorad.get(selectedNorad) ?? null) : null

  return (
    <section ref={sectionRef} className="panel p-4 sm:p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-2xl">
          <h3 className="text-sm font-semibold text-white/85">Live positions</h3>
          <p className="mt-0.5 text-[0.7rem] text-white/40">
            Positions are computed in your browser with SGP4 from CelesTrak element sets
            {join?.newest ? ` as of ${formatEpoch(join.newest)}` : ''}. They are accurate to roughly
            a few km, and are a prediction from published orbits — not live telemetry.
          </p>
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Map view">
          <span className="label-caps mr-1">View</span>
          <ToggleButton active={mode === '2d'} onClick={() => chooseMode('2d')}>
            2D
          </ToggleButton>
          <ToggleButton active={mode === '3d'} onClick={() => chooseMode('3d')}>
            3D
          </ToggleButton>
        </div>
      </header>

      {gp.isPending ? (
        <LoadingState label="Loading orbital elements…" />
      ) : gp.isError ? (
        <ErrorState error={gp.error} onRetry={() => gp.refetch()} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1" role="group" aria-label="Clock">
              <ToggleButton
                active={map.live}
                onClick={map.resetToLive}
                disabled={!ready}
                title="Follow the current time"
              >
                <Radio className="size-3.5" aria-hidden />
                Live
              </ToggleButton>
              <ToggleButton
                active={!map.playing}
                onClick={() => map.setPlaying(!map.playing)}
                disabled={!ready}
                pressable={false}
              >
                {map.playing ? (
                  <Pause className="size-3.5" aria-hidden />
                ) : (
                  <Play className="size-3.5" aria-hidden />
                )}
                {map.playing ? 'Pause' : 'Play'}
              </ToggleButton>
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Speed">
              <span className="label-caps mr-1">Speed</span>
              {MAP_SPEEDS.map((s) => (
                <ToggleButton key={s} active={map.speed === s} onClick={() => map.setSpeed(s)} disabled={!ready}>
                  ×{s}
                </ToggleButton>
              ))}
            </div>
            <p className="font-mono text-xs tnum text-white/70" aria-live="off">
              {clock}
              {map.reducedMotion && (
                <span className="ml-2 text-white/35">updates every 10 s (reduced motion)</span>
              )}
            </p>
          </div>

          {notice && <p className="mb-2 text-[0.7rem] text-amber">{notice}</p>}

          {map.error ? (
            <ErrorState error={map.error} />
          ) : !viewProps ? (
            <LoadingState label="Propagating orbits…" />
          ) : mode === '3d' ? (
            <Suspense
              fallback={
                <div className="aspect-[4/3] w-full rounded-lg border border-white/[0.08] bg-space sm:aspect-[2/1]">
                  <LoadingState label="Loading 3D globe…" />
                </div>
              }
            >
              <StarlinkGlobe3D {...viewProps} visible={visible} onUnavailable={onGlobeUnavailable} />
            </Suspense>
          ) : (
            <StarlinkMap2D {...viewProps} />
          )}

          {layer && (
            <div className="mt-3 space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Versions shown">
                <span className="label-caps mr-1">Version</span>
                {VERSION_ORDER.map((v, vi) => (
                  <LegendChip
                    key={v}
                    label={v}
                    color={versionColor(v)}
                    count={layer.byVersion[vi].length}
                    on={!hidden.has(v)}
                    onToggle={() => toggleVersion(v)}
                  />
                ))}
              </div>
              {/* Dots stay coloured by version; phase only filters, so the
                  two legends never compete for the same colour channel. */}
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Phases shown">
                <span className="label-caps mr-1">Phase</span>
                {PHASE_ORDER.map((p, pi) => (
                  <LegendChip
                    key={p}
                    label={p}
                    color={PHASE_COLORS[p]}
                    count={layer.phaseCounts[pi]}
                    on={!hiddenPhases.has(p)}
                    onToggle={() => togglePhase(p)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {join && <NotPlotted stats={stats} join={join} ready={ready} />}
            {selected && (
              <SelectedCard
                sat={selected}
                index={selectedIndex}
                positions={positions}
                element={join?.elementOf.get(selected.norad ?? -1) ?? null}
                simTimeMs={simTimeMs}
                asOf={asOf}
                onClear={() => onSelect(null)}
              />
            )}
          </div>
        </>
      )}
    </section>
  )
}

/** A legend entry that toggles its category on the map; hidden when the category is empty. */
function LegendChip({
  label,
  color,
  count,
  on,
  onToggle,
}: {
  label: string
  color: string
  count: number
  on: boolean
  onToggle: () => void
}) {
  if (count === 0) return null
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[0.7rem] transition-colors',
        on
          ? 'border-white/10 bg-surface/60 text-white/75 hover:border-white/20'
          : 'border-white/[0.05] text-white/30 line-through hover:text-white/50',
      )}
    >
      <span className="size-2 rounded-full" style={{ background: color, opacity: on ? 1 : 0.35 }} />
      {label}
      <span className="font-mono tnum text-white/40">{formatInt(count)}</span>
    </button>
  )
}

/**
 * Why the dot count is below the in-orbit count. The newest launches lag
 * because CelesTrak only publishes elements once the US catalogue has
 * identified each object, which can take days.
 */
function NotPlotted({
  stats,
  join,
  ready,
}: {
  stats: PositionStats
  join: { inOrbit: number; noElements: number; unmatched: number }
  ready: boolean
}) {
  const missing = join.inOrbit - stats.plotted
  const rows: Array<[string, number]> = [
    ['In orbit per the catalogue, but no public element set yet', join.noElements],
    [`Element set older than ${MAX_ELEMENT_AGE_MS / 86_400_000} days at this time`, stats.stale],
    ['SGP4 propagation error (e.g. already decayed)', stats.failed],
  ]
  return (
    <div className="rounded-lg border border-white/[0.08] bg-surface/60 px-3 py-2.5">
      <p className="text-xs text-white/70">
        <span className="font-mono font-semibold tnum text-white/85">{ready ? formatInt(stats.plotted) : '—'}</span>{' '}
        of <span className="font-mono tnum">{formatInt(join.inOrbit)}</span> satellites in orbit plotted
        {ready && missing > 0 && (
          <>
            {' · '}
            <span className="font-mono tnum">{formatInt(missing)}</span> not plotted
          </>
        )}
      </p>
      <ul className="mt-1.5 space-y-0.5">
        {rows.map(([label, n]) => (
          <li key={label} className="flex items-baseline justify-between gap-3 text-[0.7rem] text-white/45">
            <span>{label}</span>
            <span className="font-mono tnum text-white/60">{ready ? formatInt(n) : '—'}</span>
          </li>
        ))}
      </ul>
      {join.unmatched > 0 && (
        <p className="mt-1.5 text-[0.65rem] leading-relaxed text-white/30">
          {formatInt(join.unmatched)} CelesTrak element set{join.unmatched === 1 ? '' : 's'} matched no
          satellite the catalogue lists as in orbit, and {join.unmatched === 1 ? 'is' : 'are'} not drawn.
        </p>
      )}
    </div>
  )
}

function SelectedCard({
  sat,
  index,
  positions,
  element,
  simTimeMs,
  asOf,
  onClear,
}: {
  sat: Satellite
  index: number
  positions: SatellitePositions | null
  element: GpElements | null
  simTimeMs: number
  asOf: string
  onClear: () => void
}) {
  const version = starlinkVersion(sat)
  const variant = versionVariant(sat)
  const phase = lifecyclePhase(sat)
  const lonLatH = index >= 0 && positions?.ok[index] === 1 ? positions.lonLatH : null
  const plotted = lonLatH != null
  const lon = lonLatH ? lonLatH[index * 3] : null
  const lat = lonLatH ? lonLatH[index * 3 + 1] : null
  const alt = lonLatH ? lonLatH[index * 3 + 2] : null
  const age = ageDays(sat, asOf)

  let reason: string | null = null
  if (!plotted) {
    if (!isInOrbit(sat)) reason = `Reentered ${sat.decayDate}${sat.decayDateApprox ? ' (approx.)' : ''}, so it isn’t on the map.`
    else if (!element) reason = 'No public element set yet, so it can’t be placed on the map.'
    else if (simTimeMs - epochMs(element.epoch) > MAX_ELEMENT_AGE_MS)
      reason = `Its element set (${formatEpoch(element.epoch)}) is more than a week older than the map time.`
    else if (index >= 0) reason = 'SGP4 couldn’t propagate its element set to this time.'
    else reason = 'Not on the map.'
  }

  const rows: Array<[string, React.ReactNode]> = [
    [
      'Version',
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full" style={{ background: versionColor(version) }} />
        {version}
        {variant && <span className="text-white/40">{variant}</span>}
      </span>,
    ],
    [
      'Phase',
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2 rounded-full" style={{ background: PHASE_COLORS[phase] }} />
        {phase}
      </span>,
    ],
    ['Altitude', alt != null ? `${formatInt(alt)} km` : '—'],
    ['Position', lat != null && lon != null ? formatLatLon(lat, lon) : '—'],
    ['NORAD', sat.norad != null ? String(sat.norad) : '—'],
    [
      'Launched',
      sat.launchDate
        ? `${sat.launchDateApprox ? '≈ ' : ''}${sat.launchDate}${age != null ? ` · ${formatInt(age)} d ago` : ''}`
        : '—',
    ],
  ]

  return (
    <div className="rounded-lg border border-accent/25 bg-surface/60 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label-caps">Selected</p>
          <p className="mt-0.5 truncate text-sm font-semibold text-white/90">{displayName(sat)}</p>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md p-1 text-white/40 transition-colors hover:bg-white/5 hover:text-white/80"
          aria-label="Clear selection"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[0.7rem]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-white/40">{k}</dt>
            <dd className="font-mono tnum text-white/75">{v}</dd>
          </div>
        ))}
      </dl>
      {reason && <p className="mt-2 text-[0.7rem] text-amber/80">{reason}</p>}
    </div>
  )
}
