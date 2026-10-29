// @vitest-environment node
//
// The headless assembly session against the real OCC kernel and the real Rust
// mate solver: the pin-on-plate script (R1) and the failure posture (R2). A
// stale ref, a failed part feature and an overconstrained verdict are data; only
// a missing solver is a failed call.

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

  it('an inspect call returns the same handle and the same poses', async () => {
    const first = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: binding(), steps: PIN_SCRIPT })
    const session = createHeadlessAssembly({ doc: first.doc, parts: binding() })
    const outcome = await session.run([])
    expect(outcome.ok).toBe(true)
    const again = instancePoses(session.getDoc(), session.lastSolve()!.transforms)
    expect(again).toEqual(first.instances)
    expect(docHashOf(session.getDoc())).toBe(docHashOf(first.doc))
  }, 180_000)
})
