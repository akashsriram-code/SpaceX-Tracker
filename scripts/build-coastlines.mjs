#!/usr/bin/env node
/**
 * Flattens Natural Earth's 1:110m land outlines (via world-atlas) into plain
 * lon/lat polylines for the Starlink live map.
 *
 * Both map views only ever stroke coastlines, so shipping TopoJSON would mean
 * shipping topojson-client to the browser just to undo its arc encoding. This
 * runs once, by hand (`npm run coastlines`), and the output is committed as
 * src/assets/coastlines-110m.json. Re-run it only when world-atlas changes.
 *
 * mesh() rather than feature(): it emits each arc exactly once, so an outline
 * shared by two polygons isn't stroked twice, and it is all a stroked
 * outline needs. feature() is used only to report the polygon count.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// topojson-client 3 ships a UMD bundle with no "exports" map, so Node only
// exposes it as a CommonJS default export.
import topojson from 'topojson-client'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC = resolve(ROOT, 'node_modules', 'world-atlas', 'land-110m.json')
const OUT = resolve(ROOT, 'src', 'assets', 'coastlines-110m.json')

const round = (v) => Math.round(v * 100) / 100

/**
 * Natural Earth cuts polygons at the antimeridian and closes Antarctica along
 * the south pole. Those closing edges are artefacts of the projection, not
 * coastline, and would draw a vertical line at ±180° and a bar along the
 * bottom of the map — so split a line wherever two consecutive points both
 * sit on one.
 */
const onCut = (a, b) =>
  (Math.abs(a[0]) >= 179.99 && Math.abs(b[0]) >= 179.99) || (a[1] <= -89.99 && b[1] <= -89.99)

/**
 * A few arcs (Chukotka, Fiji) step straight across the antimeridian. On a
 * flat map that segment would streak the full width, so split there too;
 * the renderers can then draw every line as-is.
 */
const wraps = (a, b) => Math.abs(b[0] - a[0]) > 180

/**
 * Ramer–Douglas–Peucker, in degrees. At SIMPLIFY_DEG the removed vertices
 * sit well under a pixel on any realistic map width (1° ≈ 3 px at 1,100 px
 * wide) and well inside 1:110m's own generalisation, and dropping them keeps
 * the committed file under ~60 KB.
 */
const SIMPLIFY_DEG = 0.1

function simplify(points) {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [i, j] = stack.pop()
    const [ax, ay] = points[i]
    const [bx, by] = points[j]
    const dx = bx - ax
    const dy = by - ay
    const len = Math.hypot(dx, dy)
    let maxD = 0
    let at = -1
    for (let k = i + 1; k < j; k++) {
      const [px, py] = points[k]
      // Closed rings start and end on the same point, so fall back to the
      // distance from that point rather than dividing by zero.
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len
      if (d > maxD) {
        maxD = d
        at = k
      }
    }
    if (at !== -1 && maxD > SIMPLIFY_DEG) {
      keep[at] = 1
      stack.push([i, at], [at, j])
    }
  }
  return points.filter((_, k) => keep[k])
}

function clean(line) {
  const out = []
  let current = []
  for (const raw of line) {
    const p = [round(raw[0]), round(raw[1])]
    const prev = current.at(-1)
    // Rounding to 0.01° collapses near-duplicate vertices; drop them.
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue
    if (prev && (onCut(prev, p) || wraps(prev, p))) {
      if (current.length > 1) out.push(current)
      current = [p]
      continue
    }
    current.push(p)
  }
  if (current.length > 1) out.push(current)
  return out.map(simplify)
}

const topology = JSON.parse(await readFile(SRC, 'utf8'))
const land = topology.objects.land
const polygons = topojson.feature(topology, land).features.reduce(
  (n, f) => n + (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.length : 1),
  0,
)
const lines = topojson.mesh(topology, land).coordinates.flatMap(clean)
const points = lines.reduce((n, l) => n + l.length, 0)

const json = JSON.stringify({
  source: 'world-atlas/land-110m.json (Natural Earth 1:110m land), flattened by scripts/build-coastlines.mjs',
  licence: 'Natural Earth (public domain) via world-atlas 2.0.2',
  lines,
})

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, json)
console.log(
  `coastlines: ${polygons} polygons -> ${lines.length} lines, ${points} points, ` +
    `${(json.length / 1024).toFixed(1)} KB -> ${OUT}`,
)
