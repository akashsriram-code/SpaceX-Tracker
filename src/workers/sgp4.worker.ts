/**
 * SGP4 propagation for the Starlink live map, off the main thread.
 *
 * ~11k satellites × (SGP4 + geodetic conversion) every second is cheap for a
 * worker but would cost the main thread a dropped frame or two per tick, and
 * the map has to stay smooth while the page scrolls. The worker owns the
 * satrecs; the main thread only ever sees flat typed arrays, transferred
 * rather than copied.
 *
 * Satellites are identified by our own NORAD value and their index in the
 * `norads` array returned on init — never `satrec.satnum`, which is a string
 * built for the five-digit TLE world.
 */

import {
  eciToGeodetic,
  gstime,
  jday,
  json2satrec,
  propagate,
  sunPos,
  type OMMJsonObject,
  type SatRec,
} from 'satellite.js'
import type { GpElements } from '../lib/types'

export type Sgp4Request =
  | {
      type: 'init'
      elements: GpElements[]
      /**
       * Element sets older than this, relative to the requested time, are
       * skipped rather than drawn: SGP4 error grows from ~1 km at 6 h to
       * ~38 km at 7 d. Applied per tick because the simulated clock moves.
       */
      maxAgeMs: number
    }
  | { type: 'tick'; timeMs: number; seq: number }
  | { type: 'track'; norad: number; timeMs: number; seq: number }

export type Sgp4Response =
  | {
      type: 'ready'
      /** NORAD ids in the order every later `lonLatH` / `ok` array uses. */
      norads: Int32Array
      /** Element sets SGP4 rejected at initialisation. */
      dropped: number
    }
  | {
      type: 'positions'
      seq: number
      timeMs: number
      /** lon (deg, −180…180), lat (deg), height (km) per satellite. */
      lonLatH: Float32Array
      /** 1 where the position is plottable, 0 where stale or failed. */
      ok: Uint8Array
      stale: number
      failed: number
      /** Sub-solar point (deg), for the day/night terminator. */
      sun: [number, number]
      computeMs: number
    }
  | {
      type: 'track'
      seq: number
      norad: number
      /** lon/lat/height triples; NaN triples where propagation failed. */
      points: Float32Array
    }

// The app's tsconfig uses the DOM lib, where `self` is a Window. Pulling in
// the webworker lib as well conflicts with it, so describe just the two
// members this file uses.
interface WorkerScope {
  onmessage: ((e: MessageEvent<Sgp4Request>) => void) | null
  postMessage(message: Sgp4Response, transfer?: Transferable[]): void
}
const scope = self as unknown as WorkerScope

const RAD = 180 / Math.PI
const TWO_PI = 2 * Math.PI
const TRACK_STEP_MS = 30_000
const PROPAGATE_OPTS = { communityDecayCheckEnabled: true }
/**
 * SGP4 extrapolates drag without limit, so a satellite on its way down (high
 * BSTAR / mean-motion rate) can come out only a few tens of km up a day
 * past its epoch while the decay check still passes. Below this nothing is in orbit;
 * count it as failed rather than draw a dot labelled "22 km".
 */
const MIN_HEIGHT_KM = 100

let satrecs: SatRec[] = []
let norads = new Int32Array(0)
let epochMs = new Float64Array(0)
let maxAgeMs = Infinity

function toOmm(e: GpElements): OMMJsonObject {
  return {
    // json2satrec never reads these three, but its type requires them.
    OBJECT_NAME: '',
    OBJECT_ID: '',
    ELEMENT_SET_NO: 0,
    NORAD_CAT_ID: e.norad,
    EPOCH: e.epoch,
    MEAN_MOTION: e.meanMotion,
    ECCENTRICITY: e.ecc,
    INCLINATION: e.inc,
    RA_OF_ASC_NODE: e.raan,
    ARG_OF_PERICENTER: e.argp,
    MEAN_ANOMALY: e.meanAnomaly,
    BSTAR: e.bstar,
    MEAN_MOTION_DOT: e.mmDot,
    MEAN_MOTION_DDOT: e.mmDdot,
  }
}

/** CelesTrak epochs are UTC but carry no zone suffix; Date.parse would read them as local. */
const parseEpoch = (epoch: string) => Date.parse(epoch.endsWith('Z') ? epoch : `${epoch}Z`)

function init(elements: GpElements[], ageLimitMs: number) {
  const kept: SatRec[] = []
  const keptNorads: number[] = []
  const keptEpochs: number[] = []
  for (const e of elements) {
    try {
      const rec = json2satrec(toOmm(e))
      // Initialisation runs SGP4 at t = 0; a non-zero error there means the
      // element set itself is unusable, so it would fail on every tick.
      if (rec.error !== 0) continue
      kept.push(rec)
      keptNorads.push(e.norad)
      keptEpochs.push(parseEpoch(e.epoch))
    } catch {
      // Malformed row; counted as dropped below.
    }
  }
  satrecs = kept
  norads = Int32Array.from(keptNorads)
  epochMs = Float64Array.from(keptEpochs)
  maxAgeMs = ageLimitMs
  // The main thread keeps its own copy of `norads`, so ours isn't transferred.
  scope.postMessage({ type: 'ready', norads: norads.slice(), dropped: elements.length - kept.length })
}

/**
 * Geodetic lon/lat/height of one satellite, or null if SGP4 fails. A throw
 * is caught here so one bad element set counts as failed instead of
 * aborting the tick, which would leave the main thread waiting on a reply
 * that never comes.
 */
function geodeticAt(rec: SatRec, date: Date, gmst: number) {
  try {
    const pv = propagate(rec, date, PROPAGATE_OPTS)
    if (!pv) return null
    const g = eciToGeodetic(pv.position, gmst)
    if (!Number.isFinite(g.height) || g.height < MIN_HEIGHT_KM) return null
    return g
  } catch {
    return null
  }
}

function tick(timeMs: number, seq: number) {
  const started = performance.now()
  const date = new Date(timeMs)
  // GMST depends only on the time, so compute it once for every satellite.
  const gmst = gstime(date)
  const n = satrecs.length
  const lonLatH = new Float32Array(n * 3)
  const ok = new Uint8Array(n)
  let stale = 0
  let failed = 0

  for (let i = 0; i < n; i++) {
    if (timeMs - epochMs[i] > maxAgeMs) {
      stale++
      continue
    }
    const g = geodeticAt(satrecs[i], date, gmst)
    if (!g) {
      failed++
      continue
    }
    lonLatH[i * 3] = g.longitude * RAD
    lonLatH[i * 3 + 1] = g.latitude * RAD
    lonLatH[i * 3 + 2] = g.height
    ok[i] = 1
  }

  // Sub-solar point: the Sun's declination is its latitude, and its right
  // ascension minus sidereal time is its longitude.
  const sun = sunPos(jday(date))
  let sunLon = (sun.rtasc - gmst) % TWO_PI
  if (sunLon > Math.PI) sunLon -= TWO_PI
  if (sunLon < -Math.PI) sunLon += TWO_PI

  scope.postMessage(
    {
      type: 'positions',
      seq,
      timeMs,
      lonLatH,
      ok,
      stale,
      failed,
      sun: [sunLon * RAD, sun.decl * RAD],
      computeMs: performance.now() - started,
    },
    [lonLatH.buffer, ok.buffer],
  )
}

/** ±1 orbital period around `timeMs`, at 30 s steps. */
function track(norad: number, timeMs: number, seq: number) {
  const i = norads.indexOf(norad)
  if (i === -1) {
    scope.postMessage({ type: 'track', seq, norad, points: new Float32Array(0) })
    return
  }
  const rec = satrecs[i]
  // satrec.no is the mean motion in radians per minute.
  const periodMs = (TWO_PI / rec.no) * 60_000
  const steps = Math.floor((2 * periodMs) / TRACK_STEP_MS) + 1
  const points = new Float32Array(steps * 3)
  for (let k = 0; k < steps; k++) {
    const date = new Date(timeMs - periodMs + k * TRACK_STEP_MS)
    const g = geodeticAt(rec, date, gstime(date))
    points[k * 3] = g ? g.longitude * RAD : NaN
    points[k * 3 + 1] = g ? g.latitude * RAD : NaN
    points[k * 3 + 2] = g ? g.height : NaN
  }
  scope.postMessage({ type: 'track', seq, norad, points }, [points.buffer])
}

scope.onmessage = (e) => {
  const msg = e.data
  switch (msg.type) {
    case 'init':
      init(msg.elements, msg.maxAgeMs)
      break
    case 'tick':
      tick(msg.timeMs, msg.seq)
      break
    case 'track':
      track(msg.norad, msg.timeMs, msg.seq)
      break
  }
}
