// @vitest-environment node
//
// The phase 4 flip of the plan's redundancy pin: what used to be "documents
// current behaviour" (a consistent redundant set reads Fully/Under with
// nothing flagged) is now "flagged". The Rust solver walks the constraint rows
// in authoring order on a satisfied cold solve and marks a constraint whose
// rows all lie in the earlier span as redundant; the kernel maps that back to
// the authored constraint id as `superfluous` (the non-driver language the
// overlays already render) and refuses a would-be redundant constraint at
// authoring time through `probeRedundantConstraint`.
//
// Runs against the real node wasm; skips when the gitignored pkg-node build is
// absent (run `just wasm`).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { solveSketch, probeRedundantConstraint, setSketchSolver, resetSketchSolver } from '../sketch'
import { wouldOverconstrain } from '../constraintProbe'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { initGlobalRepo } from '../../query'
import type { PartDoc, SketchFeature } from '@/types/cad'

const solveBytes = loadSolver()

type Dict = Record<string, unknown>

/** One line from (0,0) to (10,0): origin-coincident start, horizontal, and the
 *  given dimension(s). The origin coincident stands in for a fixed start. */
function lineSketch(constraints: Dict[]): SketchFeature {
  return {
    id: 'sk1',
    kind: 'sketch',
    label: 'Line',
    plane: '@builtin_plane_front',
    entities: [{ id: 'l1', kind: 'line' }],
    initial: { l1: [0, 0, 10, 0] },
    constraints,
  } as unknown as SketchFeature
}

const originPin = { id: 'c_origin', kind: 'coincident', a: { entity: 'l1', point: 'start' }, b: '@builtin_origin' }
const horizontal = { id: 'c_h', kind: 'horizontal', target: { entity: 'l1' } }
const length = (id: string, value: number) => ({ id, kind: 'length', target: { entity: 'l1' }, value })

/** The rectangle from solveLocallySketchSolver.test.ts: four coincident
 *  corners, horizontal on bottom/top, vertical on right/left, dimensions. */
function rectSketch(extra: Dict[] = []): SketchFeature {
  return {
    id: 'sk1',
    kind: 'sketch',
    label: 'Rectangle',
    plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: { bottom: [0, 0, 10, 0], right: [10, 0, 10, 6], top: [10, 6, 0, 6], left: [0, 6, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: 10 },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 6 },
      ...extra,
    ],
  } as unknown as SketchFeature
}

const solve = (feature: SketchFeature) =>
  solveSketch(feature as unknown as Dict, initGlobalRepo(), {})

const flagged = (out: ReturnType<typeof solve>): string[] =>
  Object.entries(out.constraints ?? {})
    .filter(([, c]) => c.superfluous)
    .map(([id]) => id)

const culprits = (out: ReturnType<typeof solve>): string[] =>
  Object.entries(out.constraints ?? {})
    .filter(([, c]) => c.culprit)
    .map(([id]) => id)

describe.skipIf(!solveBytes)('redundant constraints are flagged, not errors', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  it('a duplicated dimension still solves and is flagged on the later id', () => {
    setSketchSolver(solveBytes!)
    const out = solve(lineSketch([originPin, horizontal, length('c_len', 10), length('c_dup', 10)]))
    // The sketch stays usable: no overconstrained verdict just because a
    // redundant measurement is present.
    expect(out.status).toBe('fully_constrained')
    expect(flagged(out)).toEqual(['c_dup'])
    expect(out.constraints!.c_dup.residual).toBe(0)
  })

  it('a parallel already implied by the rectangle reads as redundant', () => {
    setSketchSolver(solveBytes!)
    const parallel = {
      id: 'c_par', kind: 'parallel',
      a: { entity: 'bottom' }, b: { entity: 'top' },
    }
    const out = solve(rectSketch([parallel]))
    expect(out.status).not.toBe('overconstrained')
    expect(flagged(out)).toEqual(['c_par'])
  })

  it('a clean sketch reports zero flags', () => {
    setSketchSolver(solveBytes!)
    const out = solve(rectSketch())
    expect(flagged(out)).toEqual([])
  })

  it('an unsatisfied sketch marks the conflicting dimensions as culprits', () => {
    setSketchSolver(solveBytes!)
    const out = solve(lineSketch([originPin, horizontal, length('c_ten', 10), length('c_eleven', 11)]))
    expect(out.status).toBe('overconstrained')
    // The whole sketch is red (entity_status short-circuits), and the two
    // dimensions carrying the miss are the deeper-red culprits; the satisfied
    // constraints are not.
    expect(out.features!.l1.status).toBe('overconstrained')
    expect(culprits(out).sort()).toEqual(['c_eleven', 'c_ten'])
    expect(out.constraints!.c_h.culprit).toBeUndefined()
    expect(out.constraints!.c_ten.residual).toBeGreaterThan(0)
    // Redundancy is not claimed on an unsatisfied solve.
    expect(flagged(out)).toEqual([])
  })

  it('a redundant bit on an unsatisfied solve is ignored, never painted', () => {
    // The wire contract is "flags are only meaningful on a satisfied solve":
    // solve.rs only walks the rows then. Patch every flag byte of an
    // unsatisfied output to the redundant bit and the read side must still
    // paint nothing, because the miss, not the flag, is that solve's signal.
    setSketchSolver((input: Uint8Array) => {
      const buf = solveBytes!(input)
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      const nParams = view.getUint32(4, true)
      const nStatus = view.getUint32(8, true)
      const vfLen = view.getUint32(12, true)
      const nVerdicts = view.getUint32(16, true)
      const flagsAt = 21 + nParams * 8 + nStatus + vfLen * 8
      for (let i = 0; i < nVerdicts; i++) view.setUint8(flagsAt + i, 0xff)
      return buf
    })
    const out = solve(lineSketch([originPin, horizontal, length('c_ten', 10), length('c_eleven', 11)]))
    expect(out.status).toBe('overconstrained')
    expect(flagged(out)).toEqual([])
    expect(culprits(out).sort()).toEqual(['c_eleven', 'c_ten'])
  })
})

describe.skipIf(!solveBytes)('authoring probe', () => {
  beforeAll(() => resetSketchSolver())
  afterAll(() => resetSketchSolver())

  it('refuses a constraint that adds no rank', () => {
    setSketchSolver(solveBytes!)
    const feature = lineSketch([originPin, horizontal, length('c_len', 10), length('c_dup', 10)])
    expect(probeRedundantConstraint(feature, 'c_dup')).toBe(true)
  })

  it('allows a constraint that drives something new', () => {
    setSketchSolver(solveBytes!)
    // The same sketch, but the draft dims the line to 11: that conflicts with
    // the existing 10, it is not redundant, so authoring is allowed (the solve
    // then reports the conflict).
    const conflicting = lineSketch([originPin, horizontal, length('c_len', 10), length('c_alt', 11)])
    expect(probeRedundantConstraint(conflicting, 'c_alt')).toBeNull()
    // A genuinely new driver: a second horizontal on another line.
    const feature = rectSketch()
    expect(probeRedundantConstraint(feature, 'c9')).toBe(false)
  })

  it('answers null when the solver is not loaded', () => {
    resetSketchSolver()
    const feature = lineSketch([originPin, horizontal, length('c_len', 10), length('c_dup', 10)])
    expect(probeRedundantConstraint(feature, 'c_dup')).toBeNull()
  })
})

describe.skipIf(!solveBytes)('wouldOverconstrain (the store gate)', () => {
  beforeAll(() => setSketchSolver(solveBytes!))
  afterAll(() => resetSketchSolver())

  const docWith = (constraints: Dict[]): PartDoc =>
    ({ id: 'd1', features: [lineSketch(constraints)] }) as unknown as PartDoc

  /** Two lines; only the first is driven, so adding a constraint on the second
   *  is a genuinely new driver. */
  const twoLineDoc = (): PartDoc => ({
    id: 'd1',
    features: [{
      id: 'sk1', kind: 'sketch', label: 'Two lines', plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
      initial: { l1: [0, 0, 10, 0], l2: [0, 5, 10, 5] },
      constraints: [originPin, horizontal, length('c_len', 10)],
    }],
  }) as unknown as PartDoc

  it('refuses a duplicate dimension with the value the dimension dialog collects', () => {
    // The pending here is the shape finalizeDimensionPlacement builds for the
    // gate (value/pos/sign), pinned end to end by the store suite; the value is
    // what makes the duplicate a probe candidate at all.
    const doc = docWith([originPin, horizontal, length('c_len', 10)])
    expect(wouldOverconstrain(doc, {
      featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10,
    })).toBe(true)
  })

  it('cannot judge a value-less dimension, so a bare command-path add falls open', () => {
    // applyConstraint carries no value for a dimensional kind; that draft adds
    // no solver rows, so the gate must not claim redundancy and the add
    // proceeds (the solve reports whatever the value-less dimension means).
    const doc = docWith([originPin, horizontal, length('c_len', 10)])
    expect(wouldOverconstrain(doc, {
      featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'],
    })).toBe(false)
  })

  it('ignores the label pos in the verdict', () => {
    const doc = docWith([originPin, horizontal, length('c_len', 10)])
    expect(wouldOverconstrain(doc, {
      featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10, pos: [0, 7],
    })).toBe(true)
  })

  it('allows a dimension that conflicts instead of duplicating', () => {
    // A different value on the same line is a conflict: most CAD lets it land
    // and reports the overconstraint, which is what this solver does too.
    const doc = docWith([originPin, horizontal, length('c_len', 10)])
    expect(wouldOverconstrain(doc, {
      featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 12,
    })).toBe(false)
  })

  it('allows a genuinely new driver', () => {
    // The second line is undriven, so a length on it adds rank.
    expect(wouldOverconstrain(twoLineDoc(), {
      featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l2'], value: 4,
    })).toBe(false)
  })

  it('allows a conflicting constraint (the solve reports it, not the gate)', () => {
    // Vertical on a horizontal line cannot hold; the draft set is unsatisfied,
    // which is a conflict, not redundancy, so the gate lets it through and the
    // solve marks the culprits.
    const doc = docWith([originPin, horizontal, length('c_len', 10)])
    expect(wouldOverconstrain(doc, {
      featureId: 'sk1', kind: 'vertical', targets: ['entity:sk1:l1'],
    })).toBe(false)
  })

  it('leaves the live document untouched', () => {
    const base = docWith([originPin, horizontal, length('c_len', 10)])
    const before = JSON.stringify(base)
    wouldOverconstrain(base, {
      featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10,
    })
    expect(JSON.stringify(base)).toBe(before)
  })

  it('answers false without a document, a feature or a solver', () => {
    const doc = docWith([originPin, horizontal, length('c_len', 10)])
    const pending = { featureId: 'sk1', kind: 'length', targets: ['entity:sk1:l1'], value: 10 }
    expect(wouldOverconstrain(null, pending)).toBe(false)
    expect(wouldOverconstrain(doc, { ...pending, featureId: 'nope' })).toBe(false)
    resetSketchSolver()
    expect(wouldOverconstrain(doc, pending)).toBe(false)
  })
})
