// @vitest-environment node
//
// The headless assembly session against the real OCC kernel and the real Rust
// mate solver: the pin-on-plate script (R1), the capture-driven bolt stack and
// the failure posture (R2). A stale ref, a failed part feature and an
// overconstrained verdict are data; only a missing solver is a failed call.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import { createHeadlessAssembly, emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { runAssemblyHeadless } from '../headlessOps'
import { instancePoses } from '../assemblyOutcome'
import { ASSEMBLY_MUTATION_EXAMPLES } from '../assemblyExamples'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function circleSketch(sketchId: string, radius: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Circle', plane: '@builtin_plane_front',
    entities: [{ id: 'c1', kind: 'circle' as const }],
    initial: { c1: [0, 0, radius] },
  }
}

function extrude(sketchId: string, id: string, distance: number) {
  return { id, kind: 'extrude', extrude: { sketch: `$${sketchId}`, distance, direction: 'normal', operation: 'new' } }
}

function plateDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [rectSketch('sk1', 100, 60), extrude('sk1', 'ex1', 10)] } as PartDoc
}

function pinDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [circleSketch('sk1', 5), extrude('sk1', 'ex1', 20)] } as PartDoc
}

/** A part with a failing hole beside a valid body: the exception is data. */
function pinWithException(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      circleSketch('sk1', 5),
      extrude('sk1', 'ex1', 20),
      { id: 'h1', kind: 'hole', hole: { sketch: '$nope', diameter: 5, depth_mode: 'through_all' } },
    ],
  } as unknown as PartDoc
}

/** A part with no geometry: its bundle has no anchors, so a ref goes stale. */
function emptyPart(): PartDoc {
  return { version: 1, kind: 'part', features: [] } as PartDoc
}

/** A rectangle sketch offset along x, so several posts can share a plane. */
function rectSketchAt(sketchId: string, x0: number, w: number, h: number) {
  const base = rectSketch(sketchId, w, h)
  const shift = (quad: number[]) => [quad[0] + x0, quad[1], quad[2] + x0, quad[3]]
  return {
    ...base,
    initial: {
      bottom: shift(base.initial.bottom),
      right: shift(base.initial.right),
      top: shift(base.initial.top),
      left: shift(base.initial.left),
    },
  }
}

/**
 * The stale-warning repro as a part: three posts, one additive bar reaching all
 * three (it fuses into the first and warns about the other two), then a union
 * that fuses everything. It must solve with no problems, so an assembly using
 * it reports no part problems.
 */
function bridgePart(): PartDoc {
  const post = (n: number, x0: number) => [
    rectSketchAt(`sk${n}`, x0, 2, 2),
    { id: `ex${n}`, kind: 'extrude', extrude: { sketch: `$sk${n}`, distance: 3, direction: 'normal', operation: 'new' } },
  ]
  return {
    version: 1,
    kind: 'part',
    features: [
      ...post(1, 0), ...post(2, 5), ...post(3, 10),
      rectSketchAt('sk4', 1, 10, 2),
      { id: 'ex4', kind: 'extrude', extrude: { sketch: '$sk4', distance: 3, direction: 'normal', operation: 'add' } },
      { id: 'bo1', kind: 'boolean', boolean: { operation: 'union', target: 'body_ex1', tools: ['body_ex2', 'body_ex3'] } },
    ],
  } as unknown as PartDoc
}

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const FLAT_LETTER = (axis: 'x' | 'y' | 'z', side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const PIN_SCRIPT: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
  { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
  { mutation: {
    type: 'add_mate',
    featureId: 'm1',
    kind: 'fixed',
    ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
    ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
    flip: true,
  } },
]

function binding(pin: PartDoc = pinDoc()): Map<string, PartDoc> {
  return new Map([['plate', plateDoc()], ['pin', pin]])
}

/** A circle sketch at any centre of the Front plane, for a bore in a plate. */
function circleSketchAt(sketchId: string, cx: number, cy: number, radius: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Bore', plane: '@builtin_plane_front',
    entities: [{ id: 'c1', kind: 'circle' as const }],
    initial: { c1: [cx, cy, radius] },
  }
}

/** A 100 x 100 x 10 flange plate with one 6 mm bore through its centre. */
function flangeDoc(): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      rectSketch('sk1', 100, 100),
      extrude('sk1', 'ex1', 10),
      circleSketchAt('sk2', 50, 50, 6),
      { id: 'ex2', kind: 'extrude', extrude: { sketch: '$sk2', distance: 30, direction: 'normal', operation: 'cut' } },
    ],
  } as PartDoc
}

/** A cap screw: an 8 mm head over a 16 mm shank, fused into one body. */
function boltDoc(): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      circleSketch('sk1', 8),
      extrude('sk1', 'ex1', 6),
      circleSketch('sk2', 4),
      { id: 'ex2', kind: 'extrude', extrude: { sketch: '$sk2', distance: 16, direction: 'normal', operation: 'add' } },
    ],
  } as PartDoc
}

// The bore's circle on the flange's top face and the shank's circle on its top
// end: both are `circle` edges, so their axis direction is the edge's own and
// only capture can say which way round the contact is.
const CIRCLE_TOP = {
  kind: 'edge' as const,
  where: { and: [{ type: 'circle' as const }, { extreme: { axis: 'z', side: 'max' as const } }] },
}

// The head's top face is the annulus around the shank at z = 6: not the body's
// z-extreme, so it is named by its own z band.
const HEAD_TOP = {
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' as const }, { within: { axis: 'z', min: 5, max: 7 } }] },
}

describeReal('headless assembly with the real mate solver', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('pins a pin onto the plate top face', async () => {
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(),
      steps: PIN_SCRIPT,
    })
    expect(result.ok).toBe(true)
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
    expect(result.solve.dof).toBe(0)

    const pin = result.instances.find(instance => instance.handle === 'pin')!
    expect(pin.position[0]).toBeCloseTo(50, 4)
    expect(pin.position[1]).toBeCloseTo(30, 4)
    expect(pin.position[2]).toBeCloseTo(10, 4)
    // The pin's base-face anchor lands at the plate top centroid.
    const base = result.mateFrames.m1.ref_b!
    expect(base.point[0]).toBeCloseTo(50, 6)
    expect(base.point[1]).toBeCloseTo(30, 6)
    expect(base.point[2]).toBeCloseTo(10, 6)

    // A fixed instance is echoed bit-exact.
    const plate = result.instances.find(instance => instance.handle === 'plate')!
    expect(plate.position).toEqual([0, 0, 0])
    expect(plate.quaternion).toEqual([0, 0, 0, 1])

    // The stored refs carry the durable descriptor and no selector.
    const doc = result.doc
    const mate = (doc.features ?? []).find(feature => feature.id === 'm1')!.mate!
    expect(mate.ref_a.anchor_descriptor).toBeDefined()
    expect(mate.ref_b.anchor_descriptor).toBeDefined()
    expect(JSON.stringify(doc)).not.toContain('selector')
  }, 180_000)

  it('authors a bolt through a flange from seeds and capture alone', async () => {
    // The whole stack is placed by seeds: the bolt sits 6 mm under the plate
    // with its shank flush with the top face, and neither mate carries a flip
    // or an angle. Capture reads both from that pose, so every mate is exact
    // without the script ever spelling an orientation.
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'flange', part: 'flange', fixed: true } },
      { mutation: { type: 'add_part', handle: 'bolt', part: 'bolt', position: [50, 50, -6] } },
      { mutation: {
        type: 'add_mate', featureId: 'm_shank', kind: 'fixed',
        ref_a: { part: 'flange', selector: CIRCLE_TOP },
        ref_b: { part: 'bolt', selector: CIRCLE_TOP },
        capture: true,
      } },
      { mutation: {
        type: 'add_mate', featureId: 'm_head', kind: 'fixed',
        ref_a: { part: 'flange', selector: FLAT([0, 0, 1], 'min') },
        ref_b: { part: 'bolt', selector: HEAD_TOP },
        capture: true,
      } },
    ]
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: new Map([['flange', flangeDoc()], ['bolt', boltDoc()]]),
      steps,
    })
    expect(result.ok).toBe(true)
    expect(result.parts).toEqual([])
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
    expect(result.solve.dof).toBe(0)

    // Both steps report what they measured, and the contact mate's captured
    // flip is the face-to-face one: the flange's bottom outward normal against
    // the head's top one, neither of them authored by the script.
    expect(result.outcome.steps[2].captured).toEqual(
      expect.objectContaining({ flip: expect.any(Boolean), angle: expect.any(Number) }),
    )
    expect(result.outcome.steps[3].captured).toEqual({ flip: true, angle: expect.any(Number) })
    const doc = result.doc
    const headMate = (doc.features ?? []).find(feature => feature.id === 'm_head')!.mate!
    expect(headMate.flip).toBe(true)
    expect(JSON.stringify(doc)).not.toContain('capture')

    // The seed the solve started from is the pose it held: the bolt did not
    // move, and both mates solved to zero residual.
    const bolt = result.instances.find(instance => instance.handle === 'bolt')!
    expect(bolt.position[0]).toBeCloseTo(50, 4)
    expect(bolt.position[1]).toBeCloseTo(50, 4)
    expect(bolt.position[2]).toBeCloseTo(-6, 4)
    expect(bolt.quaternion[3]).toBeCloseTo(1, 4)
    expect(result.mateFrames.m_shank.residual).toBeLessThan(1e-6)
    expect(result.mateFrames.m_head.residual).toBeLessThan(1e-6)
  }, 180_000)

  it('resolves letter axes in mate selectors', async () => {
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
      { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
      { mutation: {
        type: 'add_mate',
        featureId: 'm1',
        kind: 'fixed',
        ref_a: { part: 'plate', selector: FLAT_LETTER('z', 'max') },
        ref_b: { part: 'pin', selector: FLAT_LETTER('z', 'min') },
        flip: true,
      } },
    ]
    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: binding(), steps })
    expect(result.ok).toBe(true)
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
  }, 180_000)

  // The plus convention against the real kernel: B's anchor lands at A's
  // anchor PLUS the offset, scalar along A's axis, vector in A's local frame.
  // Each case welds the same face pair on two plate instances so the anchor
  // frames are unambiguous, then reads the posed anchors back.
  it('places B at A plus a scalar offset along the +Y face axis', async () => {
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(),
      steps: [PIN_SCRIPT[0], { mutation: { type: 'add_part', handle: 'plate2', part: 'plate' } }, {
        mutation: {
          type: 'add_mate', featureId: 'm1', kind: 'fixed',
          ref_a: { part: 'plate', selector: FLAT_LETTER('y', 'max') },
          ref_b: { part: 'plate2', selector: FLAT_LETTER('y', 'max') },
          offset: 10,
        },
      }],
    })
    expect(result.ok).toBe(true)
    expect(result.solve.verdict).toBe('fully_constrained')
    const frames = result.mateFrames.m1
    const [ax, ay, az] = frames.ref_a!.point
    const [bx, by, bz] = frames.ref_b!.point
    expect(bx - ax).toBeCloseTo(0, 6)
    expect(by - ay).toBeCloseTo(10, 6)
    expect(bz - az).toBeCloseTo(0, 6)
  }, 180_000)

  it('places B at A plus an off-axis vector offset on an identity A', async () => {
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(),
      steps: [PIN_SCRIPT[0], { mutation: { type: 'add_part', handle: 'plate2', part: 'plate' } }, {
        mutation: {
          type: 'add_mate', featureId: 'm1', kind: 'fixed',
          ref_a: { part: 'plate', selector: FLAT_LETTER('y', 'max') },
          ref_b: { part: 'plate2', selector: FLAT_LETTER('y', 'max') },
          offset: { x: 10 },
        },
      }],
    })
    expect(result.ok).toBe(true)
    expect(result.solve.verdict).toBe('fully_constrained')
    const frames = result.mateFrames.m1
    const [ax, ay, az] = frames.ref_a!.point
    const [bx, by, bz] = frames.ref_b!.point
    expect(bx - ax).toBeCloseTo(10, 6)
    expect(by - ay).toBeCloseTo(0, 6)
    expect(bz - az).toBeCloseTo(0, 6)
  }, 180_000)

  it('rotates the vector offset with A: {x: 10} on a 90 deg rolled A lands at +10 Y', async () => {
    // A quarter turn about Z maps the local (10, 0, 0) to the world (0, 10, 0);
    // a world-frame offset would leave B at +10 X regardless of A's pose.
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(),
      steps: [
        { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true, rotation: [0, 0, 90] } },
        { mutation: { type: 'add_part', handle: 'plate2', part: 'plate' } },
        {
          mutation: {
            type: 'add_mate', featureId: 'm1', kind: 'fixed',
            ref_a: { part: 'plate', selector: FLAT_LETTER('z', 'max') },
            ref_b: { part: 'plate2', selector: FLAT_LETTER('z', 'max') },
            offset: { x: 10 },
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(result.solve.verdict).toBe('fully_constrained')
    const frames = result.mateFrames.m1
    const [ax, ay, az] = frames.ref_a!.point
    const [bx, by, bz] = frames.ref_b!.point
    expect(bx - ax).toBeCloseTo(0, 6)
    expect(by - ay).toBeCloseTo(10, 6)
    expect(bz - az).toBeCloseTo(0, 6)
  }, 180_000)

  it('runs the served pin_on_plate example, pinning the offset sign', async () => {
    // The example is what the drive catalog serves to agents; it authors
    // offset 5, so its pin's base anchor must sit 5 along the plate top
    // face's outward normal (plus convention), floating above the plate.
    const example = ASSEMBLY_MUTATION_EXAMPLES.find(e => e.name === 'pin_on_plate')!
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(),
      steps: example.steps,
    })
    expect(result.ok).toBe(true)
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
    const frames = result.mateFrames.m1
    const [ax, ay, az] = frames.ref_a!.point
    const [bx, by, bz] = frames.ref_b!.point
    expect(bx - ax).toBeCloseTo(0, 6)
    expect(by - ay).toBeCloseTo(0, 6)
    expect(bz - az).toBeCloseTo(5, 6)
  }, 180_000)

  it('refuses a malformed selector as an invalid ref', async () => {
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
      { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
      { mutation: {
        type: 'add_mate',
        featureId: 'm1',
        kind: 'fixed',
        ref_a: { part: 'plate', selector: { kind: 'face', where: { type: 'plane' } } },
        ref_b: { part: 'pin', anchor: 'nope' },
      } },
    ]
    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: binding(), steps })
    expect(result.ok).toBe(false)
    expect(result.outcome.steps[2].error).toMatchObject({ code: 'invalid-ref' })
    expect(result.outcome.steps[2].error!.message).toContain('did you mean "flatface"')
  }, 180_000)

  it('reports a rebind that deletes the base face as a stale ref, ok stays true', async () => {
    const first = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: binding(), steps: PIN_SCRIPT })
    const rebound = await runAssemblyHeadless({
      doc: first.doc,
      parts: binding(emptyPart()),
      steps: [],
    })
    expect(rebound.ok).toBe(true)
    expect(rebound.mates).toEqual([
      expect.objectContaining({ id: 'm1', status: 'stale', staleRefs: ['ref_b'] }),
    ])
    expect(rebound.summary).toContain('; problems:')
  }, 180_000)

  it('lists a part feature exception under parts and keeps ok true', async () => {
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(pinWithException()),
      steps: PIN_SCRIPT,
    })
    expect(result.ok).toBe(true)
    const pin = result.parts.find(part => part.docId === 'pin')
    expect(pin).toBeDefined()
    expect(pin!.features.map(problem => problem.id)).toContain('h1')
    expect(pin!.features[0]).toMatchObject({ status: 'exception' })
  }, 180_000)

  it('has no part problems once a union resolved a touch warning', async () => {
    const parts = new Map([['plate', bridgePart()], ['pin', pinDoc()]])
    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts, steps: PIN_SCRIPT })
    expect(result.ok).toBe(true)
    expect(result.parts.find(part => part.docId === 'plate')).toBeUndefined()
    expect(result.summary).not.toContain('(part) problems')
  }, 180_000)

  it('reports two conflicting fixed mates as an overconstrained row', async () => {
    const mate = (featureId: string, offset: number): AssemblyScriptStep => ({
      mutation: {
        type: 'add_mate', featureId, kind: 'fixed',
        ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
        ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
        flip: true, offset,
      },
    })
    const result = await runAssemblyHeadless({
      doc: emptyDriveAssemblyDoc(),
      parts: binding(),
      steps: [PIN_SCRIPT[0], PIN_SCRIPT[1], mate('m1', 0), mate('m2', 10)],
    })
    expect(result.ok).toBe(true)
    expect(result.solve.verdict).toBe('overconstrained')
    expect(result.mates).toContainEqual(expect.objectContaining({ id: '*', status: 'overconstrained' }))
    expect(result.summary).toContain('; problems:')
  }, 180_000)

  it('reports a missing mate solver as unavailable and ok false', async () => {
    setMateSolver(null)
    try {
      const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: binding(), steps: PIN_SCRIPT })
      expect(result.ok).toBe(false)
      expect(result.solve.verdict).toBe('unavailable')
    } finally {
      setMateSolver(solveMate)
    }
  }, 180_000)

  // Six fixed mates over seven instances: one grounded hub with a cube mated
  // to each of its six faces. Every child is seeded at identity rotation on
  // the exact point-coincidence position, so the whole solve is six absolute
  // rolls (the canonical perp frames of two opposite faces are anti-parallel,
  // which reads as a pi roll error) plus the translations those rolls then
  // need -- and the verdict must come back fully constrained, dof 0, with no
  // mate flagged. This is the frame case for the manifold solver: six
  // simultaneous half-turns over a reduced state whose quaternions are unit
  // by construction and whose grounded hub has no columns at all.
  it('fixes six mates around a hub and reaches fully_constrained', async () => {
    // The cube spans [0, 20]^3: `rectSketch` starts its rectangle at the
    // origin, so the part origin is a corner and every face centre below is
    // read off that footprint.
    const cube = (): PartDoc => ({
      version: 1,
      kind: 'part',
      features: [rectSketch('sk1', 20, 20), extrude('sk1', 'ex1', 20)],
    } as unknown as PartDoc)
    const parts = new Map<string, PartDoc>([['cube', cube()]])
    const mate = (
      featureId: string,
      child: string,
      hubSel: ReturnType<typeof FLAT_LETTER>,
      childSel: ReturnType<typeof FLAT_LETTER>,
    ): AssemblyScriptStep => ({
      mutation: {
        type: 'add_mate', featureId, kind: 'fixed',
        ref_a: { part: 'hub', selector: hubSel },
        ref_b: { part: child, selector: childSel },
        flip: true,
      },
    })
    // Child placements: each child's mated face centre sits on the hub's face
    // centre at identity rotation, so the seed carries no point error and the
    // roll rows carry all the work.
    const children: [string, [number, number, number]][] = [
      ['up', [10, 10, 20]],
      ['down', [10, 10, -20]],
      ['east', [20, 0, 0]],
      ['west', [-20, 0, 0]],
      ['north', [0, 20, 0]],
      ['south', [0, -20, 0]],
    ]
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'hub', part: 'cube', fixed: true } },
      ...children.map(([handle, position]): AssemblyScriptStep => ({
        mutation: { type: 'add_part', handle, part: 'cube', position },
      })),
      // Each hub face against the touching face of the child seeded there.
      mate('m_up', 'up', FLAT_LETTER('z', 'max'), FLAT_LETTER('z', 'min')),
      mate('m_down', 'down', FLAT_LETTER('z', 'min'), FLAT_LETTER('z', 'max')),
      mate('m_east', 'east', FLAT_LETTER('x', 'max'), FLAT_LETTER('x', 'min')),
      mate('m_west', 'west', FLAT_LETTER('x', 'min'), FLAT_LETTER('x', 'max')),
      mate('m_north', 'north', FLAT_LETTER('y', 'max'), FLAT_LETTER('y', 'min')),
      mate('m_south', 'south', FLAT_LETTER('y', 'min'), FLAT_LETTER('y', 'max')),
    ]

    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts, steps })
    expect(
      result.ok,
      JSON.stringify({ mates: result.mates, errors: result.outcome.steps.map(s => s.error ?? null) }),
    ).toBe(true)
    expect(result.mates).toEqual([])
    expect(result.solve.verdict).toBe('fully_constrained')
    expect(result.solve.dof).toBe(0)

    // The hub is echoed, not solved: still exactly where it was placed.
    const hub = result.instances.find(instance => instance.handle === 'hub')!
    expect(hub.position).toEqual([0, 0, 0])
    expect(hub.quaternion).toEqual([0, 0, 0, 1])

    // Residual honesty, over every non-stale mate of the assembly: the wire's
    // number and the distance between the anchors as the host posed them must
    // be the same number. Each mate here is a converged Fixed, so its axis and
    // roll rows are spent and its residual IS the posed point gap; a solver
    // reporting a smaller number would be marking mates green against a pose
    // nobody is looking at (which is what the old soft-norm trade did at
    // lever).
    let checked = 0
    for (const [id, frame] of Object.entries(result.mateFrames)) {
      const residual = result.solve.mates[id]?.residual
      if (residual === undefined || !frame.ref_a || !frame.ref_b) continue  // stale or dropped
      const a = frame.ref_a.point
      const b = frame.ref_b.point
      const gap = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
      expect(residual).toBeLessThan(1e-9)
      expect(Math.abs(residual - gap)).toBeLessThanOrEqual(1e-9 * Math.max(residual, gap, 1))
      checked++
    }
    expect(checked).toBe(6)
  }, 300_000)

  it('an inspect call returns the same handle and the same poses', async () => {
    const first = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: binding(), steps: PIN_SCRIPT })
    const session = createHeadlessAssembly({ doc: first.doc, parts: binding() })
    const outcome = await session.run([])
    expect(outcome.ok).toBe(true)
    const again = instancePoses(session.getDoc(), session.lastSolve()!.transforms)
    expect(again).toEqual(first.instances)
    expect(docHashOf(session.getDoc())).toBe(docHashOf(first.doc))
  }, 180_000)

  // ─── Curved anchors are the face's own axial midpoint ───

  // A cylinder wall of the given height, anchored at its own midpoint.
  function pinDocOf(height: number): PartDoc {
    return { version: 1, kind: 'part', features: [circleSketch('sk1', 5), extrude('sk1', 'ex1', height)] } as PartDoc
  }

  /** A plate straddling z = 0 with an off-centre through hole: the hole wall
   *  spans the plate only, so its midpoint is (10, 10, 0) in part-local terms. */
  function cageDoc(): PartDoc {
    return {
      version: 1, kind: 'part',
      features: [
        rectSketch('sk1', 20, 20),
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 1, direction: 'symmetric', operation: 'new' } },
        circleSketchAt('sk2', 10, 10, 5),
        { id: 'ex2', kind: 'extrude', extrude: { sketch: '$sk2', distance: 2, direction: 'symmetric', operation: 'cut' } },
      ],
    } as unknown as PartDoc
  }

  /** A ball whose centre is the part origin: the revolve of a half-disc about
   *  its own diameter, so the sphere anchor sits at (0, 0, 0). */
  function ballDoc(): PartDoc {
    return {
      version: 1, kind: 'part',
      features: [
        {
          id: 'skax', kind: 'sketch', label: 'Axis', plane: '@builtin_plane_front',
          entities: [{ id: 'ax', kind: 'line' }],
          initial: { ax: [0, -1, 0, 1] },
          constraints: [{ id: 'fx', kind: 'fixed', target: { entity: 'ax' } }],
        },
        {
          // Coordinate-closed profile, each entity pinned so the solve keeps the
          // seeded half-disc instead of rescaling it along a free DOF.
          id: 'skprof', kind: 'sketch', label: 'Ball profile', plane: '@builtin_plane_front',
          entities: [{ id: 'half', kind: 'arc' }, { id: 'join', kind: 'line' }],
          initial: { half: [0, 0, 3, -90, 90], join: [0, 3, 0, -3] },
          constraints: [
            { id: 'f1', kind: 'fixed', target: { entity: 'half' } },
            { id: 'f2', kind: 'fixed', target: { entity: 'join' } },
          ],
        },
        { id: 'rev1', kind: 'revolve', sketch: '$skprof', angle: 360, axis: '@skax/ax', operation: 'new' },
      ],
    } as unknown as PartDoc
  }

  const CYLINDER_FACE = { kind: 'face' as const, where: { type: 'cylinderface' } }
  // A full sphere may tessellate as more than one face, so the extreme narrows
  // the pick to one of them instead of failing on an ambiguous match.
  const SPHERE_FACE = {
    kind: 'face' as const,
    where: { and: [{ type: 'sphereface' }, { extreme: { axis: [0, 0, 1], side: 'max' } }] },
  }

  it('mating two pins by their walls meets their axial midpoints, not their end faces', async () => {
    const parts = new Map([['tall', pinDocOf(10)], ['short', pinDocOf(4)]])
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'tall', part: 'tall', fixed: true } },
      { mutation: { type: 'add_part', handle: 'short', part: 'short', position: [20, 0, 5] } },
      { mutation: {
        type: 'add_mate',
        featureId: 'm1',
        kind: 'rotating',
        ref_a: { part: 'tall', selector: CYLINDER_FACE },
        ref_b: { part: 'short', selector: CYLINDER_FACE },
      } },
    ]
    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts, steps })
    expect(result.ok).toBe(true)

    // The tall wall spans z 0..10 and the short one z 0..4, so meeting at the
    // midpoints puts both frames at z = 5 and the short pin at z = 3. Anchored
    // at the sweep start instead, the two BOTTOMS met: the short pin sat at
    // z = 0 with its top at 4.
    const refA = result.mateFrames.m1.ref_a!
    const refB = result.mateFrames.m1.ref_b!
    for (const point of [refA.point, refB.point]) {
      expect(point[0]).toBeCloseTo(0, 4)
      expect(point[1]).toBeCloseTo(0, 4)
      expect(point[2]).toBeCloseTo(5, 4)
    }
    const short = result.instances.find((instance) => instance.handle === 'short')!
    expect(short.position[2]).toBeCloseTo(3, 4)
    // Roll about the shared axis is the one DOF this joint leaves open.
    expect(result.solve.verdict).toBe('underconstrained')
  }, 180_000)

  // Two pins mated by their walls through one rotating mate carrying `extra`.
  async function rotatingPins(extra: Record<string, unknown>) {
    const parts = new Map([['tall', pinDocOf(10)], ['short', pinDocOf(4)]])
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'tall', part: 'tall', fixed: true } },
      { mutation: { type: 'add_part', handle: 'short', part: 'short', position: [20, 0, 5] } },
      { mutation: {
        type: 'add_mate',
        featureId: 'm1',
        kind: 'rotating',
        ref_a: { part: 'tall', selector: CYLINDER_FACE },
        ref_b: { part: 'short', selector: CYLINDER_FACE },
        ...extra,
      } as never },
    ]
    return runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts, steps })
  }

  it('a rotating mate offset slides B along A\'s axis and leaves the roll free', async () => {
    const plain = await rotatingPins({})
    const shifted = await rotatingPins({ offset: 2 })
    expect(shifted.ok).toBe(true)
    const z = (r: typeof plain) => r.instances.find((i) => i.handle === 'short')!.position[2]
    // Plus convention: B's anchor lands `offset` along A's axis from A's, so
    // the shift follows the axis direction the wall happens to carry.
    const axisZ = shifted.mateFrames.m1.ref_a!.axis[2]
    expect(Math.abs(axisZ)).toBeCloseTo(1, 4)
    expect(z(shifted) - z(plain)).toBeCloseTo(2 * axisZ, 4)
    expect(shifted.solve.verdict).toBe('underconstrained')
  }, 180_000)

  it('a rotating mate angle locks the roll, taking the hinge to fully constrained', async () => {
    const free = await rotatingPins({})
    const locked = await rotatingPins({ angle: 120 })
    expect(locked.ok).toBe(true)
    expect(locked.solve.dof).toBe(free.solve.dof - 1)
    expect(locked.solve.verdict).toBe('fully_constrained')
  }, 180_000)

  it('a ball seated in a cage hole lands on the hole wall midpoint at z = 0', async () => {
    const parts = new Map([['cage', cageDoc()], ['ball', ballDoc()]])
    const steps: AssemblyScriptStep[] = [
      { mutation: { type: 'add_part', handle: 'cage', part: 'cage', fixed: true } },
      { mutation: { type: 'add_part', handle: 'ball', part: 'ball', position: [10, 10, 5] } },
      { mutation: {
        type: 'add_mate',
        featureId: 'm1',
        kind: 'spherical',
        ref_a: { part: 'cage', selector: CYLINDER_FACE },
        ref_b: { part: 'ball', selector: SPHERE_FACE },
      } },
    ]
    const result = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts, steps })
    expect(result.ok).toBe(true)

    // The hole wall exists only inside the plate (z -0.5..0.5), so its midpoint
    // is z = 0; the ball's centre, which is its own part origin, must sit there.
    const ball = result.instances.find((instance) => instance.handle === 'ball')!
    expect(ball.position[0]).toBeCloseTo(10, 4)
    expect(ball.position[1]).toBeCloseTo(10, 4)
    expect(ball.position[2]).toBeCloseTo(0, 4)
    // A spherical mate pins the centre only; the ball keeps its three spins.
    expect(result.solve.verdict).toBe('underconstrained')
  }, 180_000)
})
