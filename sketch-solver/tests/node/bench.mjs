// Drag-latency benchmark against the real wasm (the phase-1 exit criterion:
// "with skip_status_pass, p95 under 5 ms on a 100-entity sketch"). Builds a
// staircase chain of N lines (fully constrained: alternating horizontal/vertical
// + length + coincident links + fixed start), seeds it near-solved with a small
// nudge on the dragged anchor (a realistic per-pointermove drag tick), and times
// solve_sketch_bytes. Run after `wasm-pack build --target nodejs --out-dir
// pkg-node --release`:  node tests/node/bench.mjs

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CKind, Kind, Role, Sel, encodeInput } from './flatCodec.mjs'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const wasm = require(path.join(here, '..', '..', 'pkg-node', 'sketch_solver.js'))

/** N-line staircase, near-solved, with a small nudge on the last line (the drag
 *  anchor). entities = N lines (N "entities"); params = 4N. */
function generateChain(n, { skipStatusPass = true, dragMode = true } = {}) {
  const entities = []
  const params = []
  const constraints = []

  let cx = 0
  let cy = 0
  for (let i = 0; i < n; i++) {
    entities.push({ kind: Kind.Line, offset: i * 4 })
    const horizontal = i % 2 === 0
    const ex = horizontal ? cx + 1 : cx
    const ey = horizontal ? cy : cy + 1
    params.push(cx, cy, ex, ey)
    constraints.push({
      kind: horizontal ? CKind.Horizontal : CKind.Vertical,
      refs: [{ role: Role.Target, index: i, point: Sel.Absent }],
    })
    constraints.push({
      kind: CKind.Length,
      refs: [{ role: Role.Target, index: i, point: Sel.Absent }],
      value: 1,
    })
    if (i > 0) {
      constraints.push({
        kind: CKind.Coincident,
        refs: [
          { role: Role.A, index: i - 1, point: Sel.End },
          { role: Role.B, index: i, point: Sel.Start },
        ],
      })
    }
    cx = ex
    cy = ey
  }
  // Fixed first-line start at origin.
  constraints.push({ kind: CKind.Fixed, refs: [{ role: Role.Target, index: 0, point: Sel.Start }], xy: [0, 0] })
  // Nudge the dragged anchor (last line end) to simulate one pointermove.
  params[(n - 1) * 4 + 2] += 0.15
  params[(n - 1) * 4 + 3] += 0.1

  return { entities, params, constraints, skipStatusPass, dragMode, dragAnchorId: n - 1 }
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[i]
}

function bench(label, bytes, runs) {
  // Warm up (JIT + wasm tiering).
  for (let i = 0; i < 20; i++) wasm.solve_sketch_bytes(bytes)
  const times = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    wasm.solve_sketch_bytes(bytes)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const mean = times.reduce((s, v) => s + v, 0) / times.length
  console.log(
    `${label.padEnd(34)} p50=${pct(times, 50).toFixed(3)}ms ` +
      `p95=${pct(times, 95).toFixed(3)}ms max=${times[times.length - 1].toFixed(3)}ms ` +
      `mean=${mean.toFixed(3)}ms`,
  )
  return pct(times, 95)
}

const RUNS = 200
console.log(`drag-latency benchmark (${RUNS} runs each, real wasm via pkg-node)\n`)

for (const n of [25, 50, 100]) {
  const drag = encodeInput(generateChain(n, { skipStatusPass: true, dragMode: true }))
  bench(`N=${n} drag (skip_status_pass)`, drag, RUNS)
}
console.log('')
for (const n of [25, 50, 100]) {
  const full = encodeInput(generateChain(n, { skipStatusPass: false, dragMode: false }))
  bench(`N=${n} cold (full status pass)`, full, RUNS)
}

const target = encodeInput(generateChain(100, { skipStatusPass: true, dragMode: true }))
const p95 = bench('\nN=100 drag (exit-criterion run)', target, RUNS)
console.log(`\nexit criterion: p95 < 5ms on 100-entity drag  ->  ${p95 < 5 ? 'PASS' : 'MISS'} (${p95.toFixed(3)}ms)`)
