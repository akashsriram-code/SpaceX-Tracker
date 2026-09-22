#!/usr/bin/env node
/**
 * Audits how the snapshot distributes across derived customer segments.
 *
 * Customer attribution is inferred (Launch Library 2 has no customer field),
 * so the rules need eyeballing against real data whenever they change —
 * segment bugs are invisible in the UI until you notice that, say, every
 * NROL flight is sitting in "International / Government".
 *
 * This imports the REAL rules from src/lib/launch.ts rather than restating
 * them, so the audit can never drift from what the app actually does.
 * Run it with tsx (handles the bundler-style extensionless imports that
 * plain Node's ESM resolver rejects):
 *
 *   npm run audit
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  customerSegment,
  isStarlinkMission,
  primaryCustomer,
} from '../src/lib/launch.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const launches = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'public', 'data', 'launches.json'), 'utf8'),
)

const bySegment = new Map()
for (const l of launches) {
  const s = customerSegment(l)
  if (!bySegment.has(s)) bySegment.set(s, [])
  bySegment.get(s).push(l)
}

console.log(`\nDERIVED CUSTOMER SEGMENTS — ${launches.length} launches`)
console.log('='.repeat(62))

for (const [seg, list] of [...bySegment.entries()].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  console.log(`\n${seg}: ${list.length}`)
  const labels = new Map()
  for (const l of list) {
    const lab = primaryCustomer(l)
    labels.set(lab, (labels.get(lab) ?? 0) + 1)
  }
  for (const [lab, n] of [...labels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`   ${String(n).padStart(4)}  ${lab}`)
  }
}

const undisclosed = launches.filter((l) => primaryCustomer(l) === 'Undisclosed')
console.log(`\n${'='.repeat(62)}`)
console.log(`UNRESOLVED ("Undisclosed"): ${undisclosed.length}`)
console.log(
  'These have no payload customer, no agency, and match no rule. Showing ' +
    '"Undisclosed" is the honest outcome; add an OPERATOR_RULE only for ' +
    'operators that recur often enough to matter.',
)
const sample = new Map()
for (const l of undisclosed) {
  const key = (l.missionName ?? l.name).replace(/[\d-]+$/, '').trim()
  sample.set(key, (sample.get(key) ?? 0) + 1)
}
for (const [k, n] of [...sample.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`   ${String(n).padStart(3)}  ${k}`)
}

const starlink = launches.filter(isStarlinkMission).length
console.log(`\nStarlink detection: ${starlink}/${launches.length}`)
