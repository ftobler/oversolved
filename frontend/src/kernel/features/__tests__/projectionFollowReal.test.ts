// @vitest-environment node
//
// Projection against a real B-rep, authored the way the app authors it: the
// projection is applied by `applyAddProjectedEntity`, so the applier that writes
// the entity row and its `projection` constraint is in the loop. The scenarios
// are the ones the 2026-11-13 headless probe showed working (bugreports/
// projection-review/): follow-upstream, a profile of projections only, a tilted
// plane, the circle/ellipse kind round trip, re-solve stability, and the
// B-rep edge orientation the projection start is pinned to.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import {
  applyAddPlane, applyAddSketch, applySetPlaneDefinitionField,
} from '@/utils/yamlMutations/featureAdmin'
import {
  applyAddConstraint, applyAddEntity, applyAddProjectedEntity, applyAddRect,
} from '@/utils/yamlMutations/sketch'
import { applySetExtrudeField } from '@/utils/yamlMutations/featureDefs'
import { applySolveToDoc } from '@/drive/solveWriteBack'
import type { PartDoc, PartFeature, SketchFeature } from '@/types/cad'
import {
  BOX, BOX_EXTRUDE_ID, BOX_SKETCH_ID, HOLE_CENTRE,
  bodyVolume, oc, projectionBaseDoc, projectionTestHarness, sketchOut, solveBytes,
  type SketchOut,
} from './projectionRealSupport'

const { h, base } = projectionTestHarness()

const run = (doc: PartDoc) => h.run(doc as unknown as Record<string, unknown>)
const sketchOf = (result: ReturnType<typeof run>, id: string): SketchOut =>
  sketchOut(h, result, id)

/** The plane the tilted-plane and annulus cases sit on: Front's frame, moved to
 *  z = 10 and rotated about x, so the hole's front circle projects as an
 *  ellipse with its minor axis along the plane's local y. */
function addTiltedPlane(doc: PartDoc, id: string, angle: number): void {
  applyAddPlane(doc, id, 'Tilted', {
    mode: 'origin_rotation', plane: '@builtin_plane_front',
    origin: [0, 0, 10], rotation_axis: 'x', rotation_angle: angle,
  })
}

function addExtrude(doc: PartDoc, id: string, sketchId: string, distance: number, direction = 'normal'): void {
  doc.features!.push({
    id, kind: 'extrude', label: 'Extrude',
    extrude: { sketch: `@${sketchId}`, distance, direction, operation: 'new' },
  } as unknown as PartFeature)
}

function sketchFeature(doc: PartDoc, id: string): SketchFeature {
  const found = (doc.features ?? []).find(f => f.id === id)
  if (!found) throw new Error(`document has no feature ${id}`)
  return found as SketchFeature
}

/** The same four physical lines, each drawn from its other end and chained the
 *  other way round. The box is identical and every construction id keeps
 *  naming the same face, so the only thing that changes is the profile loop
 *  orientation, which is what can flip a B-rep edge's start/end. */
function reverseBaseSketch(doc: PartDoc): void {
  const sketch = sketchFeature(doc, BOX_SKETCH_ID)
  sketch.initial = {
    bottom: [BOX.width, 0, 0, 0],
    right: [BOX.width, BOX.height, BOX.width, 0],
    top: [0, BOX.height, BOX.width, BOX.height],
    left: [0, 0, 0, BOX.height],
  }
  sketch.constraints = [
    { id: 'c1', kind: 'coincident', a: '$bottomend', b: '$leftstart' },
    { id: 'c2', kind: 'coincident', a: '$leftend', b: '$topstart' },
    { id: 'c3', kind: 'coincident', a: '$topend', b: '$rightstart' },
    { id: 'c4', kind: 'coincident', a: '$rightend', b: '$bottomstart' },
    { id: 'c5', kind: 'horizontal', target: '$bottom' },
    { id: 'c6', kind: 'horizontal', target: '$top' },
    { id: 'c7', kind: 'vertical', target: '$right' },
    { id: 'c8', kind: 'vertical', target: '$left' },
    { id: 'c9', kind: 'length', target: '$bottom', value: BOX.width },
    { id: 'c10', kind: 'length', target: '$left', value: BOX.height },
  ]
}

describe.skipIf(!oc || !solveBytes)('projection against a real body (real OCC + Rust solver)', () => {
  it('1. a projection follows an upstream extrusion edit and drags its coincident with it', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc()
    applyAddSketch(doc, 'skP', 'Profile', '@builtin_plane_front')
    applyAddProjectedEntity(doc, 'skP', 'line', geometry.topFrontEdge, 'topEdge')
    // The 10 x 5 rectangle is drawn away from the projection; the pinned corner
    // is the only thing that can place it, so its landing position is the
    // projection's start, not the authored seed.
    applyAddRect(doc, 'skP', [2, 12], [12, 17], 'vertex:skP:topEdge:start', null, ['ra', 'rb', 'rc', 'rd'], true)

    const first = run(doc)
    const firstSketch = sketchOf(first, 'skP')
    expect(firstSketch.projection_errors).toBeUndefined()
    expectPoint(firstSketch.geometry!.topEdge, [0, BOX.depth, BOX.width, BOX.depth])

    // The document the first solve would leave behind: the projection's cached
    // params and the rectangle's solved corner.
    const baked = applySolveToDoc(doc, first).doc
    applySetExtrudeField(baked, BOX_EXTRUDE_ID, 'distance', 20)
    const sketch = sketchOf(run(baked), 'skP')
    expect(sketch.projection_errors).toBeUndefined()
    expectPoint(sketch.geometry!.topEdge, [0, 20, BOX.width, 20])
    expectPoint(sketch.geometry!.ra.slice(0, 2), [0, 20])
  })

  it('2. a profile of projected edges only extrudes to the cap area', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc()
    applyAddSketch(doc, 'skW', 'Projected profile', '@builtin_plane_top')
    expect(geometry.topFaceEdges).toHaveLength(4)
    geometry.topFaceEdges.forEach((source, i) => {
      applyAddProjectedEntity(doc, 'skW', 'line', source, `w${i + 1}`)
    })
    addExtrude(doc, 'exW', 'skW', 5, 'reverse')

    const result = run(doc)
    expect(sketchOf(result, 'skW').projection_errors).toBeUndefined()
    expect(h.res(result, 'exW').status).toBe('ok')
    // 40 x 30 cap, 5 deep.
    expect(bodyVolume(h, result, 'exW', 'body_exW')).toBeCloseTo(6000, 4)
  })

  it('3. a tilted plane projects the hole circle as an ellipse', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc()
    addTiltedPlane(doc, 'pl1', 30)
    applyAddSketch(doc, 'skTilt', 'Projection', '@pl1')
    applyAddProjectedEntity(doc, 'skTilt', 'circle', geometry.holeFrontCircle, 'tc')
    addExtrude(doc, 'exTilt', 'skTilt', 2)

    const result = run(doc)
    const sketch = sketchOf(result, 'skTilt')
    expect(sketch.projection_errors).toBeUndefined()
    expect(sketch.resolved_kinds).toEqual({ tc: 'ellipse' })
    expect(sketch.geometry!.tc).toHaveLength(5)
    // pi * 3 * 3 cos 30 * 2
    expectRelative(bodyVolume(h, result, 'exTilt', 'body_exTilt'), Math.PI * 3 * 3 * Math.cos(Math.PI / 6) * 2)
  })

  it('4. the projected circle kind round-trips 0 -> 30 -> 0 degrees', () => {
    const { geometry } = base()
    const doc = annulusDoc(geometry.holeFrontCircle, 0)

    const flat = run(doc)
    expect(sketchOf(flat, 'skK').projection_errors).toBeUndefined()
    expectRelative(bodyVolume(h, flat, 'exK', 'body_exK'), Math.PI * (25 - 9) * 2)
    const flatDoc = applySolveToDoc(doc, flat).doc
    // The setters below mutate the document in place, so the 0 degree state has
    // to be kept aside before the tilt.
    const original = structuredClone(flatDoc)

    applySetPlaneDefinitionField(flatDoc, 'pl0', 'rotation_angle', 30)
    const tilted = run(flatDoc)
    const tiltedSketch = sketchOf(tilted, 'skK')
    // The row keeps its pick-time kind through the solve: only the write-back
    // adopts the resolved one, and the solve fact names the ellipse.
    const pc = sketchFeature(flatDoc, 'skK').entities!.find(e => e.id === 'pc')!
    expect(pc.kind).toBe('circle')
    expect(tiltedSketch.resolved_kinds).toEqual({ pc: 'ellipse' })
    expectRelative(bodyVolume(h, tilted, 'exK', 'body_exK'), Math.PI * (25 - 9 * Math.cos(Math.PI / 6)) * 2)
    const tiltedDoc = applySolveToDoc(flatDoc, tilted).doc
    expect(sketchFeature(tiltedDoc, 'skK').entities!.find(e => e.id === 'pc')!.kind).toBe('ellipse')

    applySetPlaneDefinitionField(tiltedDoc, 'pl0', 'rotation_angle', 0)
    const backDoc = applySolveToDoc(tiltedDoc, run(tiltedDoc)).doc
    // The probe got an identical document hash here; the projection and its
    // kind must not leave a residue behind after the tilt is removed.
    expect(backDoc).toEqual(original)
  })

  it('5. a re-solve of the tilted projection is bit-identical and writes nothing back', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc()
    addTiltedPlane(doc, 'pl1', 30)
    applyAddSketch(doc, 'skTilt', 'Projection', '@pl1')
    applyAddProjectedEntity(doc, 'skTilt', 'circle', geometry.holeFrontCircle, 'tc')
    addExtrude(doc, 'exTilt', 'skTilt', 2)

    const first = run(doc)
    const firstWrite = applySolveToDoc(doc, first)
    // The first solve caches the freshly projected params in the document.
    expect(firstWrite.geometryMoved).toBe(true)
    const second = run(firstWrite.doc)
    const secondWrite = applySolveToDoc(firstWrite.doc, second)
    // Seeded from its own cached projection, the next solve lands on exactly
    // the same params and has nothing to install.
    expect(sketchOf(second, 'skTilt').geometry!.tc).toEqual(sketchOf(first, 'skTilt').geometry!.tc)
    expect(secondWrite.geometryMoved).toBe(false)
    expect(secondWrite.movedFeatureIds).toEqual([])
    expect(secondWrite.doc).toEqual(firstWrite.doc)
  })

  it('6. a point pinned to a projected edge start stays on the same world corner when the profile loop reverses', () => {
    const { geometry } = base()
    const forward = orientationDoc(geometry.topFrontEdge, false)
    const reversed = orientationDoc(geometry.topFrontEdge, true)

    const forwardResult = run(forward)
    const reversedResult = run(reversed)
    // Both boxes build: a reverse that failed to make a body would make the
    // pin's position meaningless.
    expect(h.res(forwardResult, BOX_EXTRUDE_ID).status).toBe('ok')
    expect(h.res(reversedResult, BOX_EXTRUDE_ID).status).toBe('ok')
    expect(sketchOf(forwardResult, 'skE').projection_errors).toBeUndefined()
    expect(sketchOf(reversedResult, 'skE').projection_errors).toBeUndefined()
    const forwardPin = sketchOf(forwardResult, 'skE').geometry!.pin
    const reversedPin = sketchOf(reversedResult, 'skE').geometry!.pin
    expectPoint(forwardPin.slice(0, 2), [0, BOX.depth])
    // The upstream edit is the same world box drawn the other way round. If the
    // B-rep edge reverses too, `start` becomes the (40, depth) corner and the
    // pin jumps; this is the orientation the projection start is allowed to
    // carry.
    expectPoint(reversedPin.slice(0, 2), [0, BOX.depth])
  })
})

/** The annulus case: a user circle d10 concentric with the projected hole
 *  circle, both on the `pl0` plane. */
function annulusDoc(holeFrontCircle: string, angle: number): PartDoc {
  const doc = projectionBaseDoc()
  addTiltedPlane(doc, 'pl0', angle)
  applyAddSketch(doc, 'skK', 'Annulus', '@pl0')
  applyAddProjectedEntity(doc, 'skK', 'circle', holeFrontCircle, 'pc')
  applyAddEntity(doc, 'skK', 'circle', [...HOLE_CENTRE, 5], 'uc')
  applyAddConstraint(doc, 'skK', 'coincident', ['vertex:skK:uc:center', 'vertex:skK:pc:center'])
  applyAddConstraint(doc, 'skK', 'diameter', ['entity:skK:uc'], 10)
  addExtrude(doc, 'exK', 'skK', 2)
  return doc
}

/** A Front sketch holding the projected top-front edge and one point pinned to
 *  its start. `reversed` redraws the base rectangle the other way round. */
function orientationDoc(topFrontEdge: string, reversed: boolean): PartDoc {
  const doc = projectionBaseDoc()
  if (reversed) reverseBaseSketch(doc)
  applyAddSketch(doc, 'skE', 'Edge start', '@builtin_plane_front')
  applyAddProjectedEntity(doc, 'skE', 'line', topFrontEdge, 'edge')
  applyAddEntity(doc, 'skE', 'point', [4, 14], 'pin')
  applyAddConstraint(doc, 'skE', 'coincident', ['vertex:skE:pin:xy', 'vertex:skE:edge:start'])
  return doc
}

function expectRelative(actual: number, expected: number, rel = 1e-6): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThanOrEqual(rel)
}

/** Coordinates at the document's stored precision. The solver leaves a pinned
 *  projection a few 1e-10 off the analytic point, which is below the grid the
 *  document keeps. */
function expectPoint(actual: number[], expected: number[], precision = 6): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, precision))
}
