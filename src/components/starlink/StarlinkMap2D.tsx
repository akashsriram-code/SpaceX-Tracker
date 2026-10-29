import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { SatellitePositions } from '../../hooks/useSatellitePositions'
import { displayName, lifecyclePhase, VERSION_ORDER, versionColor } from '../../lib/starlink'
import { formatInt } from '../../lib/utils'
import type { MapLayer, MapViewProps } from './StarlinkMap'

/**
 * The default live-map view: a plain canvas in equirectangular projection.
 *
 * Equirectangular because lon/lat map linearly to x/y — no projection
 * library, and the hit-test grid is a straight division. Everything static
 * (ocean, graticule, coastlines) is painted once to an offscreen canvas per
 * size; each tick only blits that and draws ~11k dots, batched into one path
 * per version colour so the whole frame is a handful of fill() calls.
 */

const DOT_PX = 1.75
const HIT_RADIUS_PX = 7
const GRID_CELL_PX = 16
const DEG = Math.PI / 180

interface Size {
  w: number
  h: number
  dpr: number
}

const project = (lon: number, lat: number, s: Size) =>
  [((lon + 180) / 360) * s.w, ((90 - lat) / 180) * s.h] as const

/** Ocean, a 30° graticule and coastlines, at backing-store resolution. */
function drawBase(size: Size, coast: number[][][] | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(size.w * size.dpr)
  canvas.height = Math.round(size.h * size.dpr)
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  ctx.scale(size.dpr, size.dpr)

  ctx.fillStyle = '#0e1117'
  ctx.fillRect(0, 0, size.w, size.h)

  ctx.lineWidth = 1
  for (let lon = -150; lon <= 150; lon += 30) {
    const [x] = project(lon, 0, size)
    ctx.strokeStyle = lon === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.045)'
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size.h)
    ctx.stroke()
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const [, y] = project(0, lat, size)
    ctx.strokeStyle = lat === 0 ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.045)'
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(size.w, y)
    ctx.stroke()
  }

  if (coast) {
    ctx.strokeStyle = 'rgba(148,163,184,0.45)'
    ctx.lineWidth = 0.75
    ctx.lineJoin = 'round'
    ctx.beginPath()
    // The build script already split lines at the antimeridian.
    for (const line of coast) {
      line.forEach(([lon, lat], k) => {
        const [x, y] = project(lon, lat, size)
        if (k === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
    }
    ctx.stroke()
  }
  return canvas
}

/**
 * Night side. On each meridian the terminator sits where the Sun's
 * elevation is zero: tan φ = −cos(λ − λsun) / tan δsun. Night is the side of
 * that curve away from the sub-solar point, closed off along whichever pole
 * is currently dark.
 */
function drawNight(ctx: CanvasRenderingContext2D, size: Size, [sunLon, sunLat]: [number, number]) {
  // At the equinoxes tan δ → 0 and the curve degenerates to a vertical
  // line; nudging δ keeps it finite without visibly changing it.
  const decl = Math.abs(sunLat) < 0.1 ? (sunLat < 0 ? -0.1 : 0.1) : sunLat
  const tanDecl = Math.tan(decl * DEG)
  ctx.beginPath()
  for (let lon = -180; lon <= 180; lon += 2) {
    const lat = Math.atan(-Math.cos((lon - sunLon) * DEG) / tanDecl) / DEG
    const [x, y] = project(lon, lat, size)
    if (lon === -180) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  const poleY = decl > 0 ? size.h : 0
  ctx.lineTo(size.w, poleY)
  ctx.lineTo(0, poleY)
  ctx.closePath()
  ctx.fillStyle = 'rgba(0,0,0,0.32)'
  ctx.fill()
}

/** Ground track; breaks at failed steps and wherever it wraps the antimeridian. */
function drawTrack(ctx: CanvasRenderingContext2D, size: Size, points: Float32Array) {
  ctx.strokeStyle = 'rgba(56,189,248,0.6)'
  ctx.lineWidth = 1.25
  ctx.beginPath()
  let prevLon: number | null = null
  for (let k = 0; k < points.length; k += 3) {
    const lon = points[k]
    const lat = points[k + 1]
    if (Number.isNaN(lon)) {
      prevLon = null
      continue
    }
    const [x, y] = project(lon, lat, size)
    if (prevLon == null || Math.abs(lon - prevLon) > 180) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
    prevLon = lon
  }
  ctx.stroke()
}

/** Plotted, visible satellites bucketed by screen cell, for O(1) hover lookups. */
interface HitGrid {
  cols: number
  rows: number
  /** Offsets into `items` per cell (length cols × rows + 1). */
  start: Int32Array
  items: Int32Array
  xy: Float32Array
}

function buildGrid(positions: SatellitePositions, shown: Uint8Array, size: Size): HitGrid {
  const { lonLatH, ok } = positions
  const n = ok.length
  const cols = Math.ceil(size.w / GRID_CELL_PX)
  const rows = Math.ceil(size.h / GRID_CELL_PX)
  const xy = new Float32Array(n * 2)
  const cellOf = new Int32Array(n).fill(-1)
  const counts = new Int32Array(cols * rows + 1)
  for (let i = 0; i < n; i++) {
    if (!ok[i] || !shown[i]) continue
    const [x, y] = project(lonLatH[i * 3], lonLatH[i * 3 + 1], size)
    xy[i * 2] = x
    xy[i * 2 + 1] = y
    const c = Math.min(cols - 1, Math.floor(x / GRID_CELL_PX)) + Math.min(rows - 1, Math.floor(y / GRID_CELL_PX)) * cols
    cellOf[i] = c
    counts[c + 1]++
  }
  for (let c = 1; c < counts.length; c++) counts[c] += counts[c - 1]
  const start = counts.slice()
  const fill = counts.slice()
  const items = new Int32Array(start[start.length - 1])
  for (let i = 0; i < n; i++) if (cellOf[i] >= 0) items[fill[cellOf[i]]++] = i
  return { cols, rows, start, items, xy }
}

function nearest(grid: HitGrid, x: number, y: number): number {
  const cx = Math.floor(x / GRID_CELL_PX)
  const cy = Math.floor(y / GRID_CELL_PX)
  let best = -1
  let bestD = HIT_RADIUS_PX * HIT_RADIUS_PX
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= grid.rows) continue
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= grid.cols) continue
      const c = gx + gy * grid.cols
      for (let k = grid.start[c]; k < grid.start[c + 1]; k++) {
        const i = grid.items[k]
        const dx = grid.xy[i * 2] - x
        const dy = grid.xy[i * 2 + 1] - y
        const d = dx * dx + dy * dy
        if (d <= bestD) {
          bestD = d
          best = i
        }
      }
    }
  }
  return best
}

/**
 * Hover card shared by both views. Positioned at the pointer and flipped
 * away from the right and bottom edges so it never spills out of the map.
 */
export function MapTooltip({
  layer,
  positions,
  index,
  x,
  y,
  width,
  height,
}: {
  layer: MapLayer
  positions: SatellitePositions | null
  index: number
  x: number
  y: number
  width: number
  height: number
}) {
  const sat = layer.sats[index]
  if (!sat) return null
  const version = VERSION_ORDER[layer.version[index]]
  const altKm = positions?.ok[index] ? positions.lonLatH[index * 3 + 2] : null
  const flipX = x > width - 200
  const flipY = y > height - 90
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[11rem] rounded-lg border border-white/10 bg-surface-hi/95 px-3 py-2 shadow-xl backdrop-blur-sm"
      style={{
        ...(flipX ? { right: width - x + 14 } : { left: x + 14 }),
        ...(flipY ? { bottom: height - y + 14 } : { top: y + 14 }),
      }}
    >
      <p className="text-xs font-semibold text-white/90">{displayName(sat)}</p>
      <p className="mt-1 flex items-center gap-1.5 text-[0.7rem] text-white/60">
        <span className="size-2 rounded-full" style={{ background: versionColor(version) }} />
        {version}
      </p>
      <p className="mt-0.5 font-mono text-[0.7rem] tnum text-white/50">
        {altKm != null ? `${formatInt(altKm)} km` : '—'} · {lifecyclePhase(sat)}
      </p>
    </div>
  )
}

export const StarlinkMap2D = memo(function StarlinkMap2D({
  layer,
  positions,
  shown,
  selectedIndex,
  track,
  onSelect,
  label,
}: MapViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gridRef = useRef<HitGrid | null>(null)
  const [size, setSize] = useState<Size | null>(null)
  const [coast, setCoast] = useState<number[][][] | null>(null)
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)

  // Pointer handlers read the latest frame without re-binding every tick.
  const latest = useRef({ positions, shown, size })
  latest.current = { positions, shown, size }

  // Its own chunk, shared with the globe; the map is usable (dots and
  // graticule) before it lands.
  useEffect(() => {
    let alive = true
    import('../../assets/coastlines-110m.json').then((m) => {
      if (alive) setCoast(m.default.lines)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width < 1 || height < 1) return
      setSize((prev) => {
        const dpr = window.devicePixelRatio || 1
        return prev && prev.w === width && prev.h === height && prev.dpr === dpr
          ? prev
          : { w: width, h: height, dpr }
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const base = useMemo(() => (size ? drawBase(size, coast) : null), [size, coast])

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !size || !base) return
    gridRef.current = null
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.drawImage(base, 0, 0)
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0)
    if (!positions) return

    drawNight(ctx, size, positions.sun)
    if (track) drawTrack(ctx, size, track)

    const { lonLatH, ok } = positions
    const half = DOT_PX / 2
    layer.byVersion.forEach((indexes, v) => {
      if (indexes.length === 0) return
      ctx.fillStyle = versionColor(VERSION_ORDER[v])
      ctx.beginPath()
      for (const i of indexes) {
        if (!ok[i] || !shown[i]) continue
        const [x, y] = project(lonLatH[i * 3], lonLatH[i * 3 + 1], size)
        ctx.rect(x - half, y - half, DOT_PX, DOT_PX)
      }
      ctx.fill()
    })

    if (selectedIndex >= 0 && ok[selectedIndex]) {
      const [x, y] = project(lonLatH[selectedIndex * 3], lonLatH[selectedIndex * 3 + 1], size)
      ctx.fillStyle = versionColor(VERSION_ORDER[layer.version[selectedIndex]])
      ctx.beginPath()
      ctx.arc(x, y, 3.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, Math.PI * 2)
      ctx.stroke()
    }
  }, [base, size, positions, layer, shown, selectedIndex, track])

  const hitAt = (e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const { positions: p, shown: sh, size: s } = latest.current
    if (!p || !s) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    // Built lazily: most ticks pass with no pointer over the map at all.
    gridRef.current ??= buildGrid(p, sh, s)
    return { index: nearest(gridRef.current, x, y), x, y }
  }

  return (
    <div ref={wrapRef} className="relative aspect-[2/1] w-full overflow-hidden rounded-lg border border-white/[0.08] bg-space">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={label}
        width={size ? Math.round(size.w * size.dpr) : 0}
        height={size ? Math.round(size.h * size.dpr) : 0}
        className={hover ? 'absolute inset-0 size-full cursor-pointer' : 'absolute inset-0 size-full'}
        onPointerMove={(e) => {
          const hit = hitAt(e)
          if (hit && hit.index >= 0) setHover({ index: hit.index, x: hit.x, y: hit.y })
          else if (hover) setHover(null)
        }}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const hit = hitAt(e)
          if (hit && hit.index >= 0) onSelect(layer.norads[hit.index])
        }}
      />
      {hover && size && (
        <MapTooltip
          layer={layer}
          positions={positions}
          index={hover.index}
          x={hover.x}
          y={hover.y}
          width={size.w}
          height={size.h}
        />
      )}
    </div>
  )
})
