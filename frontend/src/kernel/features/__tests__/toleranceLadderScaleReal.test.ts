// @vitest-environment node
//
// The volume budgets on the ladder are fractions of the volume they judge.
// OCC integrates a solid's volume with an error that scales with the solid, so
// an absolute epsilon decides a 1000x copy of a part on a different footing than
// the part itself, and a fraction travels with it. This runs one part at scale 1
// and at scale 1000 through every volume verdict the ladder names -- the split
// degeneracy and additivity checks, the offset sign law, the hole hit test --
// and pins that the verdict, and not just the geometry, travels with the part.
//
// Skips when OCC.js or the sketch solver is absent, like the other real gates.
// The parity cases pin that verdicts travel with the part; the micro offset
// case is where a fractional budget and the old absolute epsilon genuinely
// disagree.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { volumeOf } from '../../occ/booleans'
import { offsetSolid } from '../../occ/offsetShape'
import { makeBoxAt } from '../../occ/primitives'
import { GPROP_EPS, TOL_VOLUME_DEGENERATE, TOL_VOLUME_SUM } from '../../solverConstants'
import { splineTrimDoc } from '../../occ/__tests__/splineTrimBody'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

// One part, two scales. Every length is multiplied by the scale, so the two
// documents describe the same geometry; the volumes must come out at scale^3.
const SCALES = [1, 1000]

function polySketch(id: string, points: [number, number][], plane = '@builtin_plane_front'): Dict {
  const n = points.length
  const entities: Dict[] = []
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    entities.push({ id: `l${i}`, kind: 'line' })
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`,
      kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % n}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function extrude(id: string, sketch: string, distance: number): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation: 'new' } }
}

function planeOffset(id: string, plane: string, offset: number): Dict {
  return { id, kind: 'plane', definition: { mode: 'offset', plane, offset } }
}

function split(id: string, bodies: string[], plane: string, keep: string): Dict {
  return { id, kind: 'split', split: { bodies, plane, keep } }
}

/** The block, its mid-plane and the split, every length scaled by `k`. */
function blockSpec(k: number, planeOffsetAt: number, keep: string): { features: Dict[] } {
  return {
    features: [
      polySketch('sk1', [[0, 0], [10 * k, 0], [10 * k, 10 * k], [0, 10 * k]]),
      extrude('ex1', '$sk1', 10 * k),
      planeOffset('pl1', '@builtin_plane_top', planeOffsetAt * k),
      split('sp1', ['@ex1'], '@pl1', keep),
    ],
  }
}

/** The same block drilled by one through hole. */
function holedSpec(k: number): { features: Dict[] } {
  return {
    features: [
      polySketch('sk1', [[0, 0], [10 * k, 0], [10 * k, 10 * k], [0, 10 * k]]),
      extrude('ex1', '$sk1', 10 * k),
      {
        id: 'skh', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [5 * k, 5 * k] },
      },
      {
        id: 'ho1', kind: 'hole',
        hole: { sketch: '$skh', diameter: 5 * k, depth_mode: 'through_all', direction: 'normal', target: '@body_ex1' },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('volume budgets judge a part at any scale (real OCC)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  // The OCC shape of one body as it stood after `featureId` solved.
  function shapeOf(r: BuildResponse, featureId: string, bodyId: string): OccShape {
    const ckp = r._build_state!.checkpoints[featureId]
    return h.table.get<OccShape>(ckp.body_store_snapshot[bodyId].shape!)
  }

  // The volume of one body of a built document, in model units.
  function bodyVolume(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try {
      return Math.abs(volumeOf(occ, scope, shapeOf(r, featureId, bodyId)))
    } finally {
      scope.dispose()
    }
  }

  // A volume relative to the one it should equal: the scale-invariant reading,
  // since 500 and 5e11 cannot be compared with an absolute tolerance.
  function ratio(volume: number, expected: number): number {
    return volume / expected
  }

  it('the split halves pass the degeneracy and additivity checks at both scales', () => {
    for (const k of SCALES) {
      const r = h.run(blockSpec(k, 5, 'both'))
      expect(h.res(r, 'sp1').status, `scale ${k}`).toBe('ok')
      const ids = (h.res(r, 'sp1').body_ids ?? []) as string[]
      expect(ids.length, `scale ${k}: keep both yields two bodies`).toBe(2)
      const halves = ids.map((id) => bodyVolume(r, 'sp1', id))
      const source = 1000 * k ** 3
      for (const half of halves) {
        expect(ratio(half, 500 * k ** 3), `scale ${k}: half volume ${half}`).toBeCloseTo(1, 6)
      }
      // The additivity rung, stated as the fraction of the source it allows.
      expect(Math.abs(halves[0] + halves[1] - source) / source).toBeLessThan(TOL_VOLUME_SUM)
    }
  })

  it('a plane that misses the body is refused at both scales', () => {
    // The plane sits past the top face: keeping the above side keeps nothing.
    // The refusal is the degenerate-budget check, and it must fire the same way
    // whatever the part's size.
    for (const k of SCALES) {
      const r = h.run(blockSpec(k, 15, 'above'))
      const res = h.res(r, 'sp1')
      expect(res.status, `scale ${k}`).toBe('exception')
      expect(String(res.exception), `scale ${k}`).toMatch(/nothing of body .* lies above the plane/)
    }
  })

  it('a plane inside the body keeps material at both scales', () => {
    // The kept half is a tenth of the source: a real sliver, far above the
    // degenerate budget at either scale.
    for (const k of SCALES) {
      const r = h.run(blockSpec(k, 9, 'above'))
      expect(h.res(r, 'sp1').status, `scale ${k}`).toBe('ok')
      const [id] = (h.res(r, 'sp1').body_ids ?? []) as string[]
      expect(ratio(bodyVolume(r, 'sp1', id), 100 * k ** 3), `scale ${k}`).toBeCloseTo(1, 6)
    }
  })

  it('the offset sign law holds on a 1000x tool', () => {
    // Straight on the OCC shape, no document: a box grown and shrunk by a tenth
    // of its side. The expected volume is the analytic offset solid, so the two
    // scales must agree on the FRACTION, which is what a fractional budget
    // guarantees and an absolute epsilon does not.
    for (const k of SCALES) {
      const side = 10 * k
      const clearance = k
      const scope = new DisposeScope()
      try {
        const box = makeBoxAt(occ, scope, [0, 0, 0], side, side, side)
        const grown = offsetSolid(occ, scope, box, clearance)
        const grownVolume = Math.abs(volumeOf(occ, scope, grown.shape))
        expect(ratio(grownVolume, (side + 2 * clearance) ** 3), `scale ${k}: grown`).toBeCloseTo(1, 6)

        const shrunk = offsetSolid(occ, scope, box, -clearance)
        const shrunkVolume = Math.abs(volumeOf(occ, scope, shrunk.shape))
        expect(ratio(shrunkVolume, (side - 2 * clearance) ** 3), `scale ${k}: shrunk`).toBeCloseTo(1, 6)
      } finally {
        scope.dispose()
      }
    }
  })

  it('an offset that would annihilate the tool is refused at both scales', () => {
    // Shrinking a box by more than half its side leaves no material. OCCT's
    // validity check fires on the collapsed result before the volume sign law
    // is reached; either refusal is the point, and it must not depend on the
    // tool's size.
    for (const k of SCALES) {
      const scope = new DisposeScope()
      try {
        const box = makeBoxAt(occ, scope, [0, 0, 0], 10 * k, 10 * k, 10 * k)
        expect(() => offsetSolid(occ, scope, box, -6 * k), `scale ${k}`).toThrow(/not a valid solid|did not shrink the tool/)
      } finally {
        scope.dispose()
      }
    }
  })

  it('a micro offset the old absolute floor refused is accepted', () => {
    // The case the fractional budgets exist for. A 10 micron box grown by 1.2:
    // the honest growth (measured ~7.2e-10 mm3) sits under the 1e-9 the offset
    // law used to carry as an absolute epsilon, so the old rule refused a
    // valid offset at this size; the tool-relative budget (~1e-15) clears it
    // with orders to spare. The distance itself stays above OCCT's own
    // compiled-in offset confusion: smaller offsets never complete, at any
    // scale, which is why the window here is narrow.
    const scope = new DisposeScope()
    try {
      const box = makeBoxAt(occ, scope, [0, 0, 0], 1e-2, 1e-2, 1e-2)
      const grown = offsetSolid(occ, scope, box, 1.2e-6)
      const before = Math.abs(volumeOf(occ, scope, box))
      const after = Math.abs(volumeOf(occ, scope, grown.shape))
      expect(after).toBeGreaterThan(before)
      expect(after - before).toBeLessThan(1e-9)  // the old absolute floor would have refused
      expect(after - before).toBeGreaterThan(TOL_VOLUME_DEGENERATE * Math.max(before, after))  // this one does not
    } finally {
      scope.dispose()
    }
  })

  it('a cut of the same relative thickness verdicts the same at both scales', () => {
    // The claim the fractional budgets exist for. The plane leaves a slab whose
    // thickness is a fixed FRACTION of the part, so the two scales are the same
    // geometry; a verdict that flipped between them would mean the check reads a
    // length where it should read a share of the volume.
    const verdictOf = (k: number, thicknessFraction: number): string => {
      // A slab `thicknessFraction` of the part's height stays above the plane.
      const r = h.run(blockSpec(k, 10 * (1 - thicknessFraction), 'above'))
      return String(h.res(r, 'sp1').status)
    }
    // Each fraction carries its own expected verdict, not just its parity
    // against the other scale: the slab sits ten-fold under the degenerate
    // budget at a thickness fraction of 1e-10 and ten-fold above it at 1e-7,
    // so a rung change that flipped BOTH scales into refusing would fail here
    // instead of passing on agreement.
    const cases: Array<[number, string]> = [
      [0.5, 'ok'], [0.1, 'ok'], [1e-4, 'ok'], [1e-7, 'ok'], [1e-10, 'exception'],
    ]
    for (const [fraction, want] of cases) {
      expect(verdictOf(1, fraction), `thickness fraction ${fraction} at scale 1`).toBe(want)
      expect(verdictOf(1000, fraction), `thickness fraction ${fraction} at scale 1000`).toBe(want)
    }
  })

  it('splits the spline-trimmed body symmetrically at both scales', () => {
    // The guard the eps read exists for. The body's r10 face is trimmed by a
    // BSPLINE intersection curve, where the default fixed-Gauss read lands
    // ~2e-6 of the body off, above TOL_VOLUME_SUM. The eps read has an
    // accuracy target, so the verdict travels with the part: both scales must
    // build the split, halve it, and close the additivity budget.
    for (const k of SCALES) {
      const r = h.run(splineTrimDoc(k, true))
      const res = h.res(r, 'sp1')
      expect(res.status, `scale ${k}: ${String(res.exception ?? '')}`).toBe('ok')
      const ids = (res.body_ids ?? []) as string[]
      expect(ids.length, `scale ${k}: keep both yields two bodies`).toBe(2)
      const source = bodyVolume(r, 'ho1', 'body_ex1')
      const halves = ids.map((id) => bodyVolume(r, 'sp1', id))
      expect(Math.abs(halves[0] - halves[1]), `scale ${k}: equal halves`).toBeLessThanOrEqual(GPROP_EPS * source)
      expect(Math.abs(halves[0] + halves[1] - source) / source, `scale ${k}: additivity`).toBeLessThan(TOL_VOLUME_SUM)
    }
  }, 300_000)

  it('the drilled hole reports the same material removed at both scales', () => {
    // The hole's hit test compares a tool's intersection volume against a
    // fraction of the tool, so a bore that clearly bites must bite identically
    // at scale 1 and at scale 1000.
    for (const k of SCALES) {
      const r = h.run(holedSpec(k))
      expect(h.res(r, 'ho1').status, `scale ${k}`).toBe('ok')
      const drilled = bodyVolume(r, 'ho1', 'body_ex1')
      const removed = 1000 * k ** 3 - drilled
      const bore = Math.PI * (2.5 * k) ** 2 * (10 * k)
      expect(ratio(removed, bore), `scale ${k}: removed ${removed}`).toBeCloseTo(1, 4)
    }
  })
})
