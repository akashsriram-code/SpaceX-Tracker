#!/usr/bin/env node
/**
 * Reconciles the Starlink snapshot against Jonathan McDowell's published
 * Starlink statistics (stats.html, captured into meta.reference by
 * fetch-starlink.mjs), version by version.
 *
 * Version, working/operational status and reentry cause are all derived, so
 * a rule bug would be invisible in the UI — this is where it shows up. It
 * imports the REAL rules from src/lib/starlink.ts rather than restating them,
 * so the audit can never drift from what the tab displays.
 *
 * Prints the tables and emits GitHub ::warning:: annotations (never fails
 * the build) when a version drifts more than DRIFT_TOLERANCE from McDowell or
 * any satellite is Unclassified — usually a new GCAT Program string that
 * starlinkVersion() doesn't know yet.
 *
 *   npm run audit:starlink
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VERSION_ORDER,
  constellationFlag,
  decodeStarlink,
  isInOrbit,
  isOperationalShell,
  isWorking,
  launchFor,
  indexStarlinkLaunches,
  lifecyclePhase,
  orbitOf,
  reentryCause,
  shellOf,
  starlinkVersion,
} from '../src/lib/starlink.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(__dirname, '..', 'public', 'data')
const file = JSON.parse(readFileSync(resolve(dataDir, 'starlink.json'), 'utf8'))
const launches = JSON.parse(readFileSync(resolve(dataDir, 'launches.json'), 'utf8'))
const { meta, satellites } = decodeStarlink(file)

/** Data moves daily and McDowell's page is generated separately from GCAT. */
const DRIFT_TOLERANCE = 0.01

const warnings = []
const warn = (msg) => {
  warnings.push(msg)
  if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`)
}

const pad = (v, n) => String(v).padStart(n)
const tally = (items, key) => {
  const m = new Map()
  for (const it of items) {
    const k = key(it)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

function counts(list) {
  return {
    launched: list.length,
    inOrbit: list.filter(isInOrbit).length,
    working: list.filter(isWorking).length,
    operational: list.filter(isOperationalShell).length,
  }
}

console.log(`\nSTARLINK SNAPSHOT AUDIT — ${satellites.length} satellites`)
console.log(`GCAT updated ${meta.gcatUpdated} · generated ${meta.generatedAt}`)
console.log('='.repeat(72))

/* --------------------------- totals vs McDowell --------------------------- */

const ref = meta.reference
const ours = counts(satellites)
console.log('\nTOTALS                  ours    McDowell   delta')
for (const k of ['launched', 'inOrbit', 'working', 'operational']) {
  const theirs = ref?.total?.[k]
  const delta = theirs != null ? ours[k] - theirs : null
  console.log(`  ${k.padEnd(18)} ${pad(ours[k], 8)} ${pad(theirs ?? '—', 10)} ${pad(delta ?? '', 7)}`)
  if (theirs && Math.abs(delta) / theirs > DRIFT_TOLERANCE) {
    warn(`Starlink ${k}: ${ours[k]} vs McDowell ${theirs} (>${DRIFT_TOLERANCE * 100}% apart)`)
  }
}
if (!ref) warn('No McDowell reference captured (stats.html parse failed); totals unchecked')
else console.log(`  (McDowell as of ${ref.asOf})`)

/* ---------------------------- per-version check --------------------------- */

/** McDowell's row labels -> our hardware versions. Dodger Dog rows are test articles. */
function versionOfReferenceRow(label) {
  if (/Tintin/.test(label)) return 'Tintin'
  if (/V0\.9/.test(label)) return 'v0.9'
  if (/V1\.0|TSP/.test(label)) return 'v1.0'
  if (/V1\.5/.test(label)) return 'v1.5'
  if (/V2 Mini DTC/.test(label)) return 'v2 Mini DTC'
  if (/V2 Mini\/Opt/.test(label)) return 'v2 Mini Optimized'
  if (/V2 Mini Shell/.test(label)) return 'v2 Mini'
  if (/^Starlink V3$/.test(label)) return 'V3'
  return null
}

const refByVersion = new Map()
for (const row of ref?.rows ?? []) {
  const v = versionOfReferenceRow(row.label)
  if (!v) continue
  const acc = refByVersion.get(v) ?? { launched: 0, inOrbit: 0, working: 0, operational: 0 }
  for (const k of Object.keys(acc)) acc[k] += row.values[k]
  refByVersion.set(v, acc)
}

const byVersion = new Map(VERSION_ORDER.map((v) => [v, []]))
for (const s of satellites) byVersion.get(starlinkVersion(s)).push(s)

console.log('\nBY VERSION              launched (ref)    in orbit (ref)    working (ref)   operational (ref)')
for (const [v, list] of byVersion) {
  if (!list.length && !refByVersion.has(v)) continue
  const c = counts(list)
  const r = refByVersion.get(v)
  const cell = (k) => `${pad(c[k], 6)} ${pad(r ? `(${r[k]})` : '', 8)}`
  console.log(`  ${v.padEnd(20)} ${cell('launched')}  ${cell('inOrbit')}  ${cell('working')}  ${cell('operational')}`)
  if (r) {
    for (const k of ['launched', 'inOrbit']) {
      const diff = Math.abs(c[k] - r[k])
      if (diff > Math.max(2, r[k] * DRIFT_TOLERANCE)) {
        warn(`Starlink ${v} ${k}: ${c[k]} vs McDowell ${r[k]}`)
      }
    }
  }
}

const unclassified = byVersion.get('Unclassified')
if (unclassified.length) {
  const examples = [...tally(unclassified, (s) => `${s.program ?? '-'} | ${s.bus ?? '-'} | ${s.plName ?? '-'}`)]
    .slice(0, 6)
    .map(([k, n]) => `${n}× ${k}`)
  warn(`${unclassified.length} Unclassified Starlink satellite(s) — new GCAT Program/Bus? e.g. ${examples.join('; ')}`)
}

/* ----------------------------- other breakdowns --------------------------- */

const show = (title, map) => {
  console.log(`\n${title}`)
  for (const [k, n] of [...map].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(n, 6)}  ${k}`)
}

const inOrbit = satellites.filter(isInOrbit)
show('LIFECYCLE PHASE (in orbit)', tally(inOrbit, lifecyclePhase))
show('REENTRY CAUSE (down)', tally(satellites.filter((s) => !isInOrbit(s)), reentryCause))
show('SHELL (in orbit)', tally(inOrbit, (s) => shellOf(s)?.label ?? 'no orbit'))
show('ORBIT SOURCE (in orbit)', tally(inOrbit, (s) => orbitOf(s)?.source ?? 'none'))
show('BYTE 8 FLAG (all)', tally(satellites, (s) => constellationFlag(s) || '(blank)'))

if (ref) {
  const down = satellites.length - inOrbit.length
  const causes = tally(satellites.filter((s) => !isInOrbit(s)), reentryCause)
  console.log('\nDOWN vs McDowell')
  console.log(`  total down          ${pad(down, 6)} (${ref.total.down})`)
  console.log(`  failed to orbit     ${pad(causes.get('Failed to orbit') ?? 0, 6)} (${ref.total.failedToOrbit})`)
  console.log(`  early deorbit       ${pad(causes.get('Early deorbit') ?? 0, 6)} (${ref.total.earlyDeorbit})`)
  console.log(`  disposal complete   ${pad(causes.get('Disposal') ?? 0, 6)} (${ref.total.disposalComplete})`)
  console.log(`  reentry after fail  ${pad(causes.get('Reentry after failure') ?? 0, 6)} (${ref.total.reentryAfterFail})`)
}

const index = indexStarlinkLaunches(launches)
const linked = satellites.filter((s) => launchFor(s, index)).length
console.log(`\nLINKED TO AN LL2 LAUNCH: ${linked}/${satellites.length}`)
const unlinked = tally(satellites.filter((s) => !launchFor(s, index)), (s) => s.launchTag ?? '-')
if (unlinked.size) {
  console.log(`  unlinked launch tags (${unlinked.size}): ${[...unlinked.keys()].slice(0, 12).join(', ')}`)
}

console.log('\n' + '='.repeat(72))
console.log(warnings.length ? `${warnings.length} warning(s):\n  - ${warnings.join('\n  - ')}` : 'No drift warnings.')
