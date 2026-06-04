// End-to-end smoke test for the wasm boundary: build a flat Input buffer in JS
// (via the shared flatCodec, mirroring src/codec.rs), drive the wasm-pack
// `nodejs` build, decode the flat Output, and assert a trivial sketch solves.
// This is the minimal JS-side proof that the locked byte layout round-trips
// through real wasm. Run after `wasm-pack build --target nodejs --out-dir
// pkg-node`. Exits nonzero on failure.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { CKind, Kind, Role, Sel, Status, encodeInput, decodeOutput } from './flatCodec.mjs'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const wasm = require(path.join(here, '..', '..', 'pkg-node', 'sketch_solver.js'))

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
}

// Line seeded off-axis; start fixed at origin, horizontal, length 10.
const input = {
  entities: [{ kind: Kind.Line, offset: 0 }],
  params: [0.2, -0.1, 9.5, 0.8],
  constraints: [
    { kind: CKind.Fixed, refs: [{ role: Role.Target, index: 0, point: Sel.Start }], xy: [0, 0] },
    { kind: CKind.Horizontal, refs: [{ role: Role.Target, index: 0, point: Sel.Absent }] },
    { kind: CKind.Length, refs: [{ role: Role.Target, index: 0, point: Sel.Absent }], value: 10 },
  ],
}

const out = decodeOutput(wasm.solve_sketch_bytes(encodeInput(input)))

assert(out.overallStatus === Status.FullyConstrained, `status ${out.overallStatus}`)
assert(out.params.length === 4, `param count ${out.params.length}`)
assert(Math.abs(out.params[0]) < 1e-3 && Math.abs(out.params[1]) < 1e-3, `start ${out.params.slice(0, 2)}`)
assert(Math.abs(out.params[2] - 10) < 1e-3, `end.x ${out.params[2]}`)
assert(Math.abs(out.params[3]) < 1e-3, `end.y ${out.params[3]}`)
assert(out.residualNorm < 1e-4, `residual ${out.residualNorm}`)

console.log('wasm smoke ok:', {
  status: out.overallStatus,
  params: out.params.map((v) => Number(v.toFixed(4))),
  rank: out.rank,
  iters: out.iters,
})
