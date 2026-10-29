import { useCallback, useEffect, useRef, useState } from 'react'
import type { GpElements } from '../lib/types'
import type { Sgp4Request, Sgp4Response } from '../workers/sgp4.worker'

/**
 * Drives the SGP4 worker for the live map: owns its lifecycle, a simulated
 * UTC clock (live, paused or sped up) and the tick loop.
 *
 * Ticks are skipped entirely while the tab is hidden or the map is scrolled
 * off-screen — there is nothing to look at, and 11k propagations a second
 * would otherwise run for as long as the page stays open. The clock itself
 * keeps running, so coming back shows the right moment rather than resuming
 * from where it stopped.
 */

export type MapSpeed = 1 | 60 | 600
export const MAP_SPEEDS: MapSpeed[] = [1, 60, 600]

/** SGP4 error grows from ~1 km at 6 h to ~38 km at 7 d; past that a dot would mislead. */
export const MAX_ELEMENT_AGE_MS = 7 * 86_400_000

const TICK_MS = 1_000
/** Under prefers-reduced-motion the dots still move, but in steps a user can follow. */
const REDUCED_MOTION_TICK_MS = 10_000

export interface SatellitePositions {
  /** NORAD id per index; shared by `lonLatH` and `ok`. */
  norads: Int32Array
  /** lon (deg), lat (deg), height (km) triples. */
  lonLatH: Float32Array
  /** 1 where index i was propagated and is fresh enough to plot. */
  ok: Uint8Array
  /** Sub-solar point [lon, lat] in degrees. */
  sun: [number, number]
  timeMs: number
}

export interface PositionStats {
  plotted: number
  /** Element sets older than MAX_ELEMENT_AGE_MS at the simulated time. */
  stale: number
  /** Rejected by SGP4 at initialisation, or failing at this time (e.g. decayed). */
  failed: number
  computeMs: number
}

interface Frame {
  positions: SatellitePositions
  stats: PositionStats
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

export function useSatellitePositions({
  elements,
  visible,
}: {
  /** Already restricted to the satellites the map should show. */
  elements: GpElements[] | null
  /** Whether the map is on screen (the caller's IntersectionObserver). */
  visible: boolean
}) {
  const workerRef = useRef<Worker | null>(null)
  const noradsRef = useRef<Int32Array>(new Int32Array(0))
  const droppedRef = useRef(0)
  const tracksRef = useRef(new Map<number, (points: Float32Array) => void>())
  const seqRef = useRef(0)
  const inFlightRef = useRef(false)
  // A tick asked for while one is still computing; sent as soon as it lands
  // so a pause or speed change is reflected without waiting a full interval.
  const pendingRef = useRef(false)

  const [ready, setReady] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [frame, setFrame] = useState<Frame | null>(null)
  const [playing, setPlayingState] = useState(true)
  const [speed, setSpeedState] = useState<MapSpeed>(1)
  const [live, setLive] = useState(true)

  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
  const pageVisible = usePageVisible()

  // The simulated clock: `sim` at wall-clock `real`, advancing at `speed`
  // while playing. Refs, not state — reading the time must never re-render.
  const clockRef = useRef({ sim: Date.now(), real: performance.now(), playing: true, speed: 1, live: true })

  const simNow = useCallback(() => {
    const c = clockRef.current
    if (c.live) return Date.now()
    return c.playing ? c.sim + (performance.now() - c.real) * c.speed : c.sim
  }, [])

  const sendTick = useCallback(() => {
    const worker = workerRef.current
    if (!worker) return
    if (inFlightRef.current) {
      pendingRef.current = true
      return
    }
    inFlightRef.current = true
    seqRef.current += 1
    worker.postMessage({ type: 'tick', timeMs: simNow(), seq: seqRef.current } satisfies Sgp4Request)
  }, [simNow])

  // Worker lifecycle: one per mounted map.
  useEffect(() => {
    const worker = new Worker(new URL('../workers/sgp4.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    const tracks = tracksRef.current

    worker.onmessage = (e: MessageEvent<Sgp4Response>) => {
      const msg = e.data
      if (msg.type === 'ready') {
        noradsRef.current = msg.norads
        droppedRef.current = msg.dropped
        setReady(true)
      } else if (msg.type === 'positions') {
        inFlightRef.current = false
        const norads = noradsRef.current
        // A tick posted before a re-init answers for the old satellite set.
        if (msg.lonLatH.length === norads.length * 3) {
          setFrame({
            positions: { norads, lonLatH: msg.lonLatH, ok: msg.ok, sun: msg.sun, timeMs: msg.timeMs },
            stats: {
              plotted: norads.length - msg.stale - msg.failed,
              stale: msg.stale,
              failed: msg.failed + droppedRef.current,
              computeMs: msg.computeMs,
            },
          })
        }
        if (import.meta.env.DEV && msg.seq % 30 === 1) {
          console.debug(`[sgp4] ${norads.length} satellites in ${msg.computeMs.toFixed(1)} ms`)
        }
        if (pendingRef.current) {
          pendingRef.current = false
          sendTick()
        }
      } else if (msg.type === 'track') {
        tracks.get(msg.seq)?.(msg.points)
        tracks.delete(msg.seq)
      }
    }
    // A worker that fails to load, or throws mid-tick, never answers again:
    // without this the panel would sit on "Propagating orbits…" (or freeze
    // with a tick forever in flight) and give no hint why.
    worker.onerror = (e) => {
      setError(new Error(e.message || 'The orbit propagator failed to start.'))
    }

    return () => {
      worker.terminate()
      workerRef.current = null
      inFlightRef.current = false
      pendingRef.current = false
      // Settle outstanding track requests so callers' promises don't hang.
      for (const resolve of tracks.values()) resolve(new Float32Array(0))
      tracks.clear()
    }
  }, [sendTick])

  useEffect(() => {
    const worker = workerRef.current
    if (!worker || !elements) return
    setReady(false)
    worker.postMessage({ type: 'init', elements, maxAgeMs: MAX_ELEMENT_AGE_MS } satisfies Sgp4Request)
  }, [elements])

  // The tick loop. One tick on every change (so a pause or speed change shows
  // immediately), then an interval only while the clock is running.
  const active = ready && visible && pageVisible
  useEffect(() => {
    if (!active) return
    sendTick()
    if (!playing) return
    const id = window.setInterval(sendTick, reducedMotion ? REDUCED_MOTION_TICK_MS : TICK_MS)
    return () => window.clearInterval(id)
  }, [active, playing, speed, live, reducedMotion, sendTick])

  /** Fold elapsed time into the anchor before changing how the clock runs. */
  const reanchor = useCallback(
    (next: Partial<{ playing: boolean; speed: number; live: boolean }>) => {
      const sim = simNow()
      clockRef.current = { ...clockRef.current, sim, real: performance.now(), ...next }
    },
    [simNow],
  )

  const setPlaying = useCallback(
    (p: boolean) => {
      reanchor({ playing: p, live: false })
      setPlayingState(p)
      setLive(false)
    },
    [reanchor],
  )

  const setSpeed = useCallback(
    (s: MapSpeed) => {
      reanchor({ speed: s, live: false })
      setSpeedState(s)
      setLive(false)
    },
    [reanchor],
  )

  const resetToLive = useCallback(() => {
    clockRef.current = { sim: Date.now(), real: performance.now(), playing: true, speed: 1, live: true }
    setPlayingState(true)
    setSpeedState(1)
    setLive(true)
  }, [])

  /** Ground track for ±1 orbit around the current simulated time. */
  const requestTrack = useCallback(
    (norad: number): Promise<Float32Array> => {
      const worker = workerRef.current
      if (!worker) return Promise.resolve(new Float32Array(0))
      seqRef.current += 1
      const seq = seqRef.current
      return new Promise((resolve) => {
        tracksRef.current.set(seq, resolve)
        worker.postMessage({ type: 'track', norad, timeMs: simNow(), seq } satisfies Sgp4Request)
      })
    },
    [simNow],
  )

  return {
    ready,
    error,
    positions: frame?.positions ?? null,
    simTimeMs: frame?.positions.timeMs ?? clockRef.current.sim,
    playing,
    setPlaying,
    speed,
    setSpeed,
    live,
    resetToLive,
    requestTrack,
    reducedMotion,
    stats: frame?.stats ?? { plotted: 0, stale: 0, failed: 0, computeMs: 0 },
  }
}
