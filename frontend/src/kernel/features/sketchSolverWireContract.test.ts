// @vitest-environment node
//
// The solver's declared counts are wire data, not a promise. `codec.rs` writes
// `out.entity_status.len()` and `params_solved.len()` as their own u32 fields;
// nothing ties either to the `layout` this side built and then zips positionally
// against. A TRUNCATED buffer already fails loudly (DataView throws past the
// end), but a well-formed buffer whose counts merely disagree used to sail
// through: `STATUS_NAME[out.entityStatus[i]]` returned `undefined` into a field
// typed `string`, and `paramsSolved.slice()` came back short so `params[0]` was
// `undefined` in a `number` -- an entity silently losing its geometry AND
// reporting no status, with nothing to fail a test.
//
// That skew is not hypothetical for this codec: a stale js/wasm pairing shipped
// once and decoded shifted offsets instead of failing, which is why the magic
// number became the version handshake. The magic catches a layout change; only
// this check catches a count disagreement.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  solveSketch,
  assertSolverOutputMatchesLayout,
  setSketchSolver,
  resetSketchSolver,
} from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { initGlobalRepo } from '../query'
import type { EntityLayout } from '@/wasm-kernel/lowerSketch'
import type { SolverOutput } from '@/wasm-kernel/codec'
import type { PartFeature } from '@/types/cad'

const solveBytes = loadSolver()

function layoutOf(n: number): EntityLayout[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, kind: 'point', offset: i * 2, size: 2,
  }))
}

function outputOf(over: Partial<SolverOutput> = {}): SolverOutput {
  return {
    paramsSolved: [0, 0, 1, 1],
    entityStatus: [0, 1],
    overallStatus: 1,
    diagnostics: { residualNorm: 0, rank: 2, dof: 0, iters: 3, ms: 0.1 },
    ...over,
  }
}

describe('solver output / layout count contract', () => {
  it('accepts an output whose counts match the layout', () => {
    expect(() => assertSolverOutputMatchesLayout(outputOf(), layoutOf(2), 'sk1', false)).not.toThrow()
  })

  it('refuses fewer entity statuses than entities', () => {
    expect(() => assertSolverOutputMatchesLayout(outputOf({ entityStatus: [0] }), layoutOf(2), 'sk1', false))
      .toThrow(/1 entity statuses, expected 2/)
  })

  // More is as wrong as fewer: it means the two sides disagree about what the
  // entity list even is, so index i is not entity i on both ends.
  it('refuses more entity statuses than entities', () => {
    expect(() => assertSolverOutputMatchesLayout(outputOf({ entityStatus: [0, 1, 2] }), layoutOf(2), 'sk1', false))
      .toThrow(/3 entity statuses, expected 2/)
  })

  // The drag path asks for skip_status_pass, and codec.rs answers with 0
  // statuses by contract. That is the REQUIRED answer there, not a tolerated
  // one: a solver that ignored the flag and sent a full array is as much a skew
  // as one that sent too few, and would mean the flag is not being honoured.
  it('requires exactly zero statuses when the request set skipStatusPass', () => {
    expect(() => assertSolverOutputMatchesLayout(outputOf({ entityStatus: [] }), layoutOf(2), 'sk1', true))
      .not.toThrow()
    expect(() => assertSolverOutputMatchesLayout(outputOf(), layoutOf(2), 'sk1', true))
      .toThrow(/2 entity statuses, expected 0/)
  })

  it('refuses a params array the layout would slice past the end of', () => {
    expect(() => assertSolverOutputMatchesLayout(outputOf({ paramsSolved: [0, 0, 1] }), layoutOf(2), 'sk1', false))
      .toThrow(/3 params, layout needs 4/)
  })

  // The same skew can arrive as a VALUE rather than as a length: a code that is
  // not an index into STATUS_NAME reads back `undefined` just the same.
  it('refuses a status code that is not a STATUS_NAME index', () => {
    expect(() => assertSolverOutputMatchesLayout(outputOf({ overallStatus: 7 }), layoutOf(2), 'sk1', false))
      .toThrow(/unknown status code 7/)
    expect(() => assertSolverOutputMatchesLayout(outputOf({ entityStatus: [0, 9] }), layoutOf(2), 'sk1', false))
      .toThrow(/unknown status code 9 for entity e1/)
  })
})

// Wiring: the check has to be ON the hard-solve path, not merely exported.
describe.skipIf(!solveBytes)('solveSketch refuses a skewed solver output', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  const rect = (id: string): PartFeature => ({
    id, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 6], top: [10, 6, 0, 6], left: [0, 6, 0, 0] },
    constraints: [],
  } as unknown as PartFeature)

  it('solves normally with the real solver', () => {
    setSketchSolver(solveBytes!)
    const out = solveSketch(rect('ok') as unknown as Record<string, unknown>, initGlobalRepo(), {})
    // Every entity reports a real status string, never undefined.
    for (const [id, f] of Object.entries(out.features ?? {})) {
      expect(typeof f.status, `${id} status`).toBe('string')
    }
  })

  it('throws instead of reporting undefined statuses when the wire count is short', () => {
    // Patch the DECLARED status count in the real solver's own output rather
    // than hand-rolling the wire format, so the test cannot drift from codec.rs.
    // n_status is the third u32 of the output header (magic, n_params, n_status).
    setSketchSolver((input: Uint8Array) => {
      const buf = solveBytes!(input)
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const nStatus = view.getUint32(8, true)
      expect(nStatus, 'fixture assumes the solver returned some statuses').toBeGreaterThan(0)
      view.setUint32(8, nStatus - 1, true)
      return buf
    })
    expect(() => solveSketch(rect('skew') as unknown as Record<string, unknown>, initGlobalRepo(), {}))
      .toThrow(/entity statuses, expected/)
  })
})
