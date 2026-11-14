// @vitest-environment node
//
// Rebinding a part instance whose doc_id resolves to nothing: the repair the
// stud_wall practice run (F3) needed after a partial import. The document is
// deliberately unbound, then two `set_part_doc` steps point its instances back
// at the live parts; the solve must reproduce the geometry the bound assembly
// measured, not merely place the parts at their seeds.
//
// The last cases are the mate rules the mutation does not rewrite: the ref rows
// are by handle, so the solver's anchor id and descriptor fallback decide
// whether a rebind keeps the mate or reports it stale.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import { emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { measureAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

function rectSketch(sketchId: string, x0: number, y0: number, x1: number, y1: number) {
  return {
    id: sketchId, kind: 'sketch' as const, plane: '@builtin_plane_top',
    entities: [{ id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const }, { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const }],
    initial: { bottom: [x0, y0, x1, y0], right: [x1, y0, x1, y1], top: [x1, y1, x0, y1], left: [x0, y1, x0, y0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: x1 - x0 },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: y1 - y0 },
    ],
  }
}

function section(height: number, suffix = ''): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      rectSketch('sk1', -10, -10, 10, 10),
      { id: `ex1${suffix}`, kind: 'extrude', extrude: { sketch: '$sk1', distance: height, direction: 'normal', operation: 'new' } },
    ],
  } as unknown as PartDoc
}

const PARTS = new Map<string, PartDoc>([
  ['cube', section(20)],
  ['rail_400', section(400)],
])

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const STEPS: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'con_bl', part: 'cube', fixed: true } },
  { mutation: { type: 'add_part', handle: 'left', part: 'rail_400', position: [50, 50, 50] } },
  { mutation: {
    type: 'add_mate', featureId: 'm_left', kind: 'fixed',
    ref_a: { part: 'con_bl', selector: FLAT([0, 1, 0], 'max') },
    ref_b: { part: 'left', selector: FLAT([0, 1, 0], 'min') },
    flip: true,
  } },
]

const REBIND: AssemblyScriptStep[] = [
  { mutation: { type: 'set_part_doc', handle: 'con_bl', part: 'cube' } },
  { mutation: { type: 'set_part_doc', handle: 'left', part: 'rail_400' } },
]

// The document a partial import leaves behind: every doc_id names a part the
// workspace does not hold. The handles, poses and mates are intact.
function unbound(doc: AssemblyDoc): AssemblyDoc {
  return {
    ...doc,
    features: (doc.features ?? []).map(feature => (
      feature.kind === 'part_instance' && feature.instance
        ? { ...feature, instance: { ...feature.instance, doc_id: `missing-${feature.instance.handle}` } }
        : feature
    )),
  }
}

describeReal('rebinding a part instance to a live part document', () => {
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

  it('two set_part_doc steps restore an unbound assembly to its solved geometry', async () => {
    const built = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })
    expect(built.ok, JSON.stringify(built.mates)).toBe(true)
    expect(built.mates).toEqual([])
    expect(built.solve.verdict).toBe('fully_constrained')
    const reference = (await measureAssemblyHeadless(built.doc, PARTS))!
    expect(reference.measures.volume).toBeCloseTo(8000 + 160000, 3)

    const rebound = await runAssemblyHeadless({
      doc: unbound(built.doc),
      parts: PARTS,
      steps: REBIND,
    })
    expect(rebound.ok, JSON.stringify(rebound.mates)).toBe(true)
    expect(rebound.mates).toEqual([])
    expect(rebound.solve.verdict).toBe('fully_constrained')
    expect(rebound.instances.find(i => i.handle === 'con_bl')!.part).toBe('cube')
    expect(rebound.instances.find(i => i.handle === 'left')!.part).toBe('rail_400')

    const measured = (await measureAssemblyHeadless(rebound.doc, PARTS))!
    expect(measured.measures.volume).toBeCloseTo(reference.measures.volume, 3)
    const bbox = measured.measures.bbox
    const referenceBbox = reference.measures.bbox
    expect(bbox).not.toBeNull()
    expect(referenceBbox).not.toBeNull()
    bbox!.forEach((value, index) => {
      expect(value).toBeCloseTo(referenceBbox![index], 3)
    })

    // The same repair script twice is the same document: a replay of the run
    // cannot drift on the bind it performed.
    const replay = await runAssemblyHeadless({
      doc: unbound(built.doc),
      parts: PARTS,
      steps: REBIND,
    })
    expect(docHashOf(replay.doc)).toBe(docHashOf(rebound.doc))
    expect(replay.instances).toEqual(rebound.instances)
  }, 300_000)

  it('keeps a mate fully constrained when the new part has the same geometry', async () => {
    const built = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })
    const aliases = new Map<string, PartDoc>([
      ['cube_copy', section(20)],
      ['rail_copy', section(400)],
    ])
    const rebound = await runAssemblyHeadless({
      doc: built.doc,
      parts: aliases,
      steps: [
        { mutation: { type: 'set_part_doc', handle: 'con_bl', part: 'cube_copy' } },
        { mutation: { type: 'set_part_doc', handle: 'left', part: 'rail_copy' } },
      ],
    })
    expect(rebound.ok, JSON.stringify(rebound.mates)).toBe(true)
    expect(rebound.mates).toEqual([])
    expect(rebound.solve.verdict).toBe('fully_constrained')
  }, 300_000)

  it('reports the mate stale when the new part cannot carry its anchor', async () => {
    const built = await runAssemblyHeadless({ doc: emptyDriveAssemblyDoc(), parts: PARTS, steps: STEPS })
    // A part built by a different feature has a different anchor identity and
    // creation bucket: neither the stored anchor id nor its descriptor can
    // re-find the old element, so the mate reports stale.
    const shortened = new Map<string, PartDoc>([
      ['cube', section(20)],
      ['rail_other', section(200, '_other')],
    ])
    const rebound = await runAssemblyHeadless({
      doc: built.doc,
      parts: shortened,
      steps: [{ mutation: { type: 'set_part_doc', handle: 'left', part: 'rail_other' } }],
    })
    expect(rebound.mates).toContainEqual(expect.objectContaining({
      id: 'm_left',
      status: 'stale',
      staleRefs: ['ref_b'],
    }))
    expect(rebound.solve.verdict).not.toBe('fully_constrained')
    // The ref row still names the instance: the rebind rewrote no mate.
    const mate = rebound.doc.features!.find(f => f.kind === 'mate')!.mate!
    expect(mate.ref_b.part).toBe('left')
    expect(mate.ref_b.anchor).toBe(built.doc.features!.find(f => f.kind === 'mate')!.mate!.ref_b.anchor)
  }, 300_000)
})
