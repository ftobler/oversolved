// @vitest-environment node
//
// A face the clean step (UnifySameDomain) merges out of a target face and a
// tool face keeps the TARGET's name, as the raw boolean level already does.
//
// Since a hole's cutter carries names of its own, a cut whose new face is
// coplanar with, and touches, an existing face hands the merged face two named
// sources. Keeping whichever source came first in the raw result's face order
// let the hole's uuid replace the existing face's, so a stored pick on that face
// broke, and which name won hung on OCC explorer order.
//
// Skips when opencascade.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { parseAncestry } from '../../query'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeBoxAt, makeCylinderWithFaces } from '../primitives'
import { booleanWithDiff, booleanWithHistory, cleanWithHistory, composeOriginThroughClean } from '../booleans'

const oc = await loadOcc()
const solveBytes = loadSolver()

// The kernel step underneath the document cases: the raw result happens to list
// the target's faces first, so a document build cannot show which source a merge
// prefers. Feeding the same origin list in both orders can.
describe.skipIf(!oc)('composeOriginThroughClean prefers the target source (real OCC)', () => {
  it('a merged face picks its target source whatever order the origin lists it in', () => {
    const occ = oc!
    const scope = new DisposeScope()
    try {
      // The step of the document case below: z 0..10 for x < 10, z 5..10 for x > 10.
      const slab = scope.track(makeBox(occ, scope, 20, 10, 10))
      const notch = scope.track(makeBoxAt(occ, scope, [10, 0, 0], 10, 10, 5))
      const step = scope.track(booleanWithDiff(occ, scope, slab, notch, 'cut').shape)
      const drill = scope.track(makeCylinderWithFaces(occ, scope, [10, 5, 0], [0, 0, 1], 1, 5).shape)
      const raw = booleanWithHistory(occ, scope, step, drill, 'cut')
      scope.track(raw.shape)
      const { shape: cleaned, history } = cleanWithHistory(occ, scope, raw.shape)
      scope.track(cleaned)
      // The floor half disc and the lower level face fold into one: a target and
      // a tool source for one cleaned face.
      expect(raw.faceOrigin.some((o) => o.fromTool), 'the raw result keeps a tool face').toBe(true)

      const forward = composeOriginThroughClean(occ, scope, raw.faceOrigin, history, cleaned)
      const reversed = composeOriginThroughClean(occ, scope, [...raw.faceOrigin].reverse(), history, cleaned)
      expect(reversed).toHaveLength(forward.length)
      for (const f of forward) {
        const r = reversed.find((o) => o.output.IsSame(f.output))
        expect(r, 'every cleaned face has an origin in both orders').toBeDefined()
        expect(r!.fromTool, 'the same side wins in both orders').toBe(f.fromTool)
        expect(r!.source.IsSame(f.source), 'the same source wins in both orders').toBe(true)
      }
    } finally {
      scope.dispose()
    }
  })
})

type Spec = { features: Array<Record<string, unknown>> }

function rectSketch(sketchId: string, w: number, h: number, ox = 0, oy = 0) {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('a clean-merged face keeps the target name (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const mesh = (spec: Spec) => h.body(h.run(spec), 'body_ex1').mesh as {
    face_data: Array<{ centroid: number[]; normal: number[]; area: number }>
    face_uuids: (string | null)[]
    face_queries: string[]
  }

  /** The uuids of the body's faces lying in the plane z = `z` and facing -z
   *  (test-side only: it pairs one face across two documents, it identifies
   *  nothing in the kernel). */
  function downFacingAt(spec: Spec, z: number): Array<{ uuid: string | null; area: number }> {
    const m = mesh(spec)
    return m.face_data.flatMap((fd, i) =>
      Math.abs(fd.centroid[2] - z) < 1e-6 && fd.normal[2] < -0.999 ? [{ uuid: m.face_uuids[i], area: fd.area }] : [])
  }

  // A step drilled from its upper level (z=0 here, the drill runs +z) down to the
  // lower level's plane (z=5), straddling the step edge: the half of the floor
  // under the upper level is coplanar with the lower level face and touches it,
  // so the clean folds the two into one face. Both mirror images of the step are
  // built, because which source the raw result lists first follows OCC's explorer
  // order, and the name must not.
  for (const lowerSide of ['right', 'left'] as const) {
    it(`a blind hole floor merged into an existing step face (lower level on the ${lowerSide})`, () => {
      const step: Spec = { features: [
        rectSketch('sk1', 20, 10),
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
        rectSketch('sk2', 10, 10, lowerSide === 'right' ? 10 : 0, 0),
        { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 5, direction: 'normal', operation: 'cut' },
      ] }
      const drilled: Spec = { features: [
        ...step.features,
        {
          id: 'skh', kind: 'sketch', label: 'Drill site', plane: '@builtin_plane_front',
          entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [10, 5] }, constraints: [],
        },
        { id: 'hole1', kind: 'hole', hole: { sketch: '@skh', diameter: 2, depth: 5, target: 'body_ex1' } },
      ] }
      const before = downFacingAt(step, 5)
      expect(before, 'one lower level face').toHaveLength(1)
      expect(before[0].uuid).not.toBeNull()
      const after = downFacingAt(drilled, 5)
      // The floor folded into the lower level face: one face, half a disc larger
      // (the area is the tessellated one, so the arc's chords shave a little off).
      expect(after, 'the floor merged into the lower level').toHaveLength(1)
      expect(after[0].area).toBeCloseTo(before[0].area + Math.PI / 2, 2)
      expect(after[0].uuid, 'the lower level keeps its own uuid').toBe(before[0].uuid)
    })
  }

  // A hole at a circle an extrude already cut with the same radius, drilled
  // deeper: the new bore wall is coaxial with the existing one and the clean
  // folds them into one cylinder, which must keep the existing bore's uuid.
  it('a bore merged into an existing coaxial bore of the same radius', () => {
    const bored: Spec = { features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      {
        id: 'skc', kind: 'sketch', label: 'Circle', plane: '@builtin_plane_front',
        entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [5, 5, 1] }, constraints: [],
      },
      { id: 'ex2', kind: 'extrude', sketch: '$skc', distance: 2, direction: 'normal', operation: 'cut' },
    ] }
    const drilled: Spec = { features: [
      ...bored.features,
      { id: 'hole1', kind: 'hole', hole: { sketch: 'entity:skc:c1', diameter: 2, depth: 6, target: 'body_ex1' } },
    ] }
    const before = mesh(bored)
    const bores = before.face_queries.flatMap((q, i) => (parseAncestry(q)[1] === 'cylinderface' ? [before.face_uuids[i]] : []))
    expect(bores, 'one existing bore').toHaveLength(1)
    expect(bores[0]).not.toBeNull()
    const after = mesh(drilled)
    const afterBores = after.face_queries.flatMap((q, i) => (parseAncestry(q)[1] === 'cylinderface' ? [after.face_uuids[i]] : []))
    // The bores merged: still one cylinder face, and it is the existing one.
    expect(afterBores, 'the bores merged into one face').toHaveLength(1)
    expect(afterBores[0]).toBe(bores[0])
  })
})
