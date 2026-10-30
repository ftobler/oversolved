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
})
