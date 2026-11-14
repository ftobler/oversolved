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
  assertConstraintVerdictsMatchInput,
  culpritConstraintIndices,
  setSketchSolver,
  resetSketchSolver,
  isSketchSolverReady,
} from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { OCC_ANGULAR, OCC_CONFUSION } from '@/kernel/solverConstants'
import { initGlobalRepo } from '../../query'
import type { EntityLayout } from '@/wasm-kernel/lowerSketch'
import type { SolverOutput } from '@/wasm-kernel/codec'
import type { PartFeature } from '@/types/cad'

const solveBytes = loadSolver()

function layoutOf(n: number): EntityLayout[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, kind: 'point', offset: i * 2, size: 2, flags: 0,
  }))
}

function outputOf(over: Partial<SolverOutput> = {}): SolverOutput {
  return {
    paramsSolved: [0, 0, 1, 1],
    entityStatus: [0, 1],
    overallStatus: 1,
    constraintFlags: [],
    constraintMiss: [],
    entityMoved: [],
    diagnostics: { residualNorm: 0, rank: 2, dof: 0, iters: 3, ms: 0.1, angularMiss: 0, linearMiss: 0 },
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

// The constraint side of the same count contract: the per-constraint verdict
// arrays are zipped positionally against the wire constraints, so their
// declared length must match what was sent -- exactly empty on the drag path,
// which asks for no verdicts at all.
describe('solver output / constraint verdict contract', () => {
  it('accepts one flag and one miss per constraint sent', () => {
    expect(() => assertConstraintVerdictsMatchInput(
      outputOf({ constraintFlags: [0, 1], constraintMiss: [0, 0.5] }), 2, false, 'sk1',
    )).not.toThrow()
  })

  it('refuses a verdict array that disagrees with the constraint count', () => {
    expect(() => assertConstraintVerdictsMatchInput(
      outputOf({ constraintFlags: [0], constraintMiss: [0] }), 2, false, 'sk1',
    )).toThrow(/1 constraint flags and 1 constraint misses, expected 2/)
  })

  it('requires exactly empty verdicts on the drag path', () => {
    expect(() => assertConstraintVerdictsMatchInput(
      outputOf({ constraintFlags: [], constraintMiss: [] }), 2, true, 'drag',
    )).not.toThrow()
    expect(() => assertConstraintVerdictsMatchInput(
      outputOf({ constraintFlags: [0, 0], constraintMiss: [0, 0] }), 2, true, 'drag',
    )).toThrow(/expected 0/)
  })
})

describe('culprit selection', () => {
  it('keeps both sides of a two-way conflict', () => {
    expect([...culpritConstraintIndices([0.5, 0.5, 0])].sort()).toEqual([0, 1])
  })

  it('stops after the offender when the blame is one-sided', () => {
    // 0.9 alone already covers 90% of the 0.92 total.
    expect([...culpritConstraintIndices([0.9, 0.01, 0.01])]).toEqual([0])
  })

  it('selects nothing for an all-zero miss', () => {
    expect(culpritConstraintIndices([0, 0]).size).toBe(0)
  })

  it('drops a non-finite miss instead of letting it poison the coverage', () => {
    // An Infinity makes the total unmeetable by every finite miss, so the
    // finite offenders behind it would all be selected; the entry itself is
    // not a measurement either. Only the finite positives decide.
    expect([...culpritConstraintIndices([Infinity, 0.9, 0.01])]).toEqual([1])
    expect(culpritConstraintIndices([Infinity]).size).toBe(0)
    expect([...culpritConstraintIndices([NaN, 0.9, 0.01])]).toEqual([1])
  })
})

// Wiring: the check has to be ON the hard-solve path, not merely exported.
describe.skipIf(!solveBytes)('solveSketch refuses a skewed solver output', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  const rect = (id: string, constraints: unknown[] = []): PartFeature => ({
    id, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 6], top: [10, 6, 0, 6], left: [0, 6, 0, 0] },
    constraints,
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

  it('throws instead of zipping skewed verdicts when the constraint count is short', () => {
    // The same declared-count skew one array over: n_constraint_status is the
    // fifth u32 (magic, n_params, n_status, vertex_freedom_len, n_verdicts).
    // The sketch carries one constraint, so the real output must declare one
    // verdict pair; patching it down makes the arrays disagree with the wire
    // constraints this side sent.
    const constrained = rect('skew-verdicts', [{ id: 'c1', kind: 'horizontal', target: { entity: 'bottom' } }])
    setSketchSolver((input: Uint8Array) => {
      const buf = solveBytes!(input)
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const nVerdicts = view.getUint32(16, true)
      expect(nVerdicts, 'fixture assumes the solver returned verdicts').toBeGreaterThan(0)
      view.setUint32(16, nVerdicts - 1, true)
      return buf
    })
    expect(() => solveSketch(constrained as unknown as Record<string, unknown>, initGlobalRepo(), {}))
      .toThrow(/constraint flags and .*constraint misses, expected/)
  })
})

describe.skipIf(!solveBytes)('solveSketch reports the kernel precision contract', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  const rect = (id: string, constraints: unknown[] = []): PartFeature => ({
    id, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 6], top: [10, 6, 0, 6], left: [0, 6, 0, 0] },
    constraints,
  } as unknown as PartFeature)

  const square = [
    { id: 'c1', kind: 'horizontal', target: { entity: 'bottom' } },
    { id: 'c2', kind: 'vertical', target: { entity: 'right' } },
    { id: 'c3', kind: 'parallel', a: { entity: 'top' }, b: { entity: 'bottom' } },
    { id: 'c4', kind: 'parallel', a: { entity: 'left' }, b: { entity: 'right' } },
  ]

  it('carries the realised misses on a satisfied sketch', () => {
    setSketchSolver(solveBytes!)
    const out = solveSketch(rect('precision', square) as unknown as Record<string, unknown>, initGlobalRepo(), {})
    expect(typeof out.angular_miss).toBe('number')
    expect(typeof out.linear_miss).toBe('number')
    expect(Number.isFinite(out.angular_miss)).toBe(true)
    expect(Number.isFinite(out.linear_miss)).toBe(true)
    // The contract's own targets, read off the ladder: the solver promises to
    // finish inside them or to report honestly.
    expect(out.angular_miss!).toBeLessThanOrEqual(OCC_ANGULAR)
    expect(out.linear_miss!).toBeLessThanOrEqual(OCC_CONFUSION * 1e-2)
  })

  it('reports NaN for an overconstrained sketch', () => {
    setSketchSolver(solveBytes!)
    const conflict = [
      { id: 'c1', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c2', kind: 'length', target: { entity: 'bottom' }, value: 10 },
      { id: 'c3', kind: 'length', target: { entity: 'bottom' }, value: 10.1 },
    ]
    const out = solveSketch(rect('conflict', conflict) as unknown as Record<string, unknown>, initGlobalRepo(), {})
    expect(out.status).toBe('overconstrained')
    expect(Number.isNaN(out.angular_miss)).toBe(true)
    expect(Number.isNaN(out.linear_miss)).toBe(true)
  })

  it('re-solves a 6 dp baked seed back to the contract', () => {
    // The write-back stores 6 decimals (`roundGeometry`), so a reload seeds
    // from a quantised copy of the last solve. The kernel still builds from the
    // new solve's params, but only if that solve lands back inside the contract;
    // a 1e-6 grid step on a 10 mm edge is a 1e-7 rad tilt, 100000x the angular
    // target, so the finish has to reclaim it and the assertion is real.
    setSketchSolver(solveBytes!)
    const first = solveSketch(rect('reload', square) as unknown as Record<string, unknown>, initGlobalRepo(), {})
    expect(Number.isFinite(first.angular_miss)).toBe(true)
    const baked: Record<string, number[]> = {}
    for (const [id, params] of Object.entries(first.geometry ?? {})) {
      baked[id] = params.map((v) => Math.round(v * 1e6) / 1e6)
    }
    const reloaded = { ...(rect('reload2', square) as unknown as Record<string, unknown>), initial: baked }
    const again = solveSketch(reloaded, initGlobalRepo(), {})
    expect(again.angular_miss!).toBeLessThanOrEqual(OCC_ANGULAR)
    expect(again.linear_miss!).toBeLessThanOrEqual(OCC_CONFUSION * 1e-2)
  })
})

describe('sketch solver readiness', () => {
  it('reports not ready after a reset and throws a named error from solveSketch', () => {
    // The drag path checks readiness on the main thread's own module instance;
    // an uninitialised hard solve must fail loud rather than decode garbage.
    resetSketchSolver()
    expect(isSketchSolverReady()).toBe(false)
    expect(() =>
      solveSketch({ id: 'sk', kind: 'sketch', entities: [] }, initGlobalRepo(), {}),
    ).toThrow(/not initialised/)
  })
})
