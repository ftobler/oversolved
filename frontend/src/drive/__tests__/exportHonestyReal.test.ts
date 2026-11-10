// @vitest-environment node
//
// E-2: export reports what it wrote. A part whose hole threw or whose fillet
// only partly applied must not come back ok:true with no problem list, and an
// assembly whose mates did not solve must not present seed poses as the solved
// placement. The file is still written when it can be; the reply says the file
// is not the clean model the document describes.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { DisposeScope } from '@/kernel/occ/disposeScope'
import { stepBytesToShape } from '@/kernel/occ/stepIo'
import { volumeOf } from '@/kernel/occ/booleans'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { PartDoc } from '@/types/cad'
import type { ScriptStep } from '../scriptRunner'
import type { Selector } from '@/kernel/select'
import { emptyDriveAssemblyDoc, setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { emptyDriveDoc, exportAssemblyHeadless, exportHeadless, runAssemblyHeadless, runHeadless, selectHeadless } from '../headlessOps'
import { HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { nonSketchProblems } from './buildProblems'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const m = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

async function build(steps: ScriptStep[]): Promise<PartDoc> {
  const result = await runHeadless({ doc: emptyDriveDoc(), steps })
  return result.doc as PartDoc
}

async function pick(doc: PartDoc, selector: Selector): Promise<string[]> {
  return (await selectHeadless(doc, selector))!.queries
}

const BOX: ScriptStep[] = [
  m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
  m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10], p0Ref: '@builtin_origin', dimensions: true }),
  m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' }),
]

// A 2 mm plate under a 10 mm block: a radius-3 fillet fits the block's top
// edges but not the plate's rim, so the feature applies only part of its work
// and reports `partial` (the same shape edgeFailureMessages pins).
async function partialFilletDoc(): Promise<PartDoc> {
  const doc = await build([
    m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
    m({ type: 'add_center_rect', featureId: 'sk1', center: [0, 0], corner: [20, 20], centerRef: '@builtin_origin', dimensions: true }),
    m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 2, operation: 'new' }),
    m({ type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 2 } }),
    m({ type: 'add_sketch', featureId: 'sk2', plane: '@pl1' }),
    m({ type: 'add_center_rect', featureId: 'sk2', center: [0, 0], corner: [5, 5], centerRef: '@builtin_origin', dimensions: true }),
    m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 10 }),
  ])
  const block = await pick(doc, {
    kind: 'edge',
    where: { and: [{ within: { axis: 'y', min: 11.9 } }, { parallel: [1, 0, 0] }] },
  })
  const rim = await pick(doc, {
    kind: 'edge',
    where: {
      and: [
        { within: { axis: 'y', min: 1.9, max: 2.1 } },
        { parallel: [1, 0, 0] },
        { within: { axis: 'z', min: 19.9 } },
      ],
    },
  })
  expect(block.length).toBeGreaterThan(0)
  expect(rim.length).toBeGreaterThan(0)
  const applied = await runHeadless({
    doc,
    steps: [m({ type: 'add_fillet', featureId: 'fi1', edges: [...block, ...rim], radius: 3 })],
  })
  expect(applied.features).toContainEqual(expect.objectContaining({ id: 'fi1', status: 'partial' }))
  return applied.doc as PartDoc
}

// The pin-on-plate assembly from headlessAssemblyReal: a fixed plate and a pin
// mated flat-on-flat. Two conflicting fixed mates are the overconstrained case.
function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, plane: '@builtin_plane_front',
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

function extrude(sketchId: string, id: string, distance: number) {
  return { id, kind: 'extrude', extrude: { sketch: `$${sketchId}`, distance, direction: 'normal', operation: 'new' } }
}

function plateDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [rectSketch('sk1', 100, 60), extrude('sk1', 'ex1', 10)] } as PartDoc
}

function pinDoc(): PartDoc {
  return {
    version: 1, kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [0, 0, 5] } },
      extrude('sk1', 'ex1', 20),
    ],
  } as PartDoc
}

const PARTS = new Map([['plate', plateDoc()], ['pin', pinDoc()]])

const FLAT = (axis: [number, number, number], side: 'min' | 'max') => ({
  kind: 'face' as const,
  where: { and: [{ type: 'flatface' }, { extreme: { axis, side } }] },
})

const PIN_SCRIPT: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'plate', part: 'plate', fixed: true } },
  { mutation: { type: 'add_part', handle: 'pin', part: 'pin', position: [30, 30, 40] } },
  { mutation: {
    type: 'add_mate', featureId: 'm1', kind: 'fixed',
    ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
    ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
    flip: true,
  } },
]

const CONFLICTING_MATE = (featureId: string, offset: number): AssemblyScriptStep => ({
  mutation: {
    type: 'add_mate', featureId, kind: 'fixed',
    ref_a: { part: 'plate', selector: FLAT([0, 0, 1], 'max') },
    ref_b: { part: 'pin', selector: FLAT([0, 0, 1], 'min') },
    flip: true, offset,
  },
})

async function buildAssembly(steps: AssemblyScriptStep[]) {
  return runAssemblyHeadless({
    doc: emptyDriveAssemblyDoc(),
    parts: PARTS,
    steps,
  })
}

describeReal('export honesty (real OCC + Rust solvers)', () => {
  beforeAll(() => {
    setOccLoader(loadOcc)
    setSketchSolver(solveBytes!)
    setSketchTopology(loadTopology())
    setMateSolver(solveMate)
  })

  afterAll(() => {
    setMateSolver(null)
  })

  it('exports a clean part with ok true and no features', async () => {
    const doc = await build(BOX)
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(true)
    expect(exported!.features).toEqual([])
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 180_000)

  it('exports ok true when an underconstrained sketch is the only problem row', async () => {
    // The law's carve-out: the yellow sketch is reported, but the file is the
    // sound model the document describes, so the export is not a failure.
    const doc = await build([
      ...BOX,
      m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' }),
      m({ type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [5, 5] }),
    ])
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(true)
    expect(exported!.features).toContainEqual(expect.objectContaining({
      id: 'sk2',
      kind: 'sketch',
      status: 'underconstrained',
    }))
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 180_000)

  it('exports ok false when an underconstrained sketch rides with a partial fillet', async () => {
    // One document with both rows: the carve-out must drop only the sketch
    // warning, not the partial feature beside it.
    const built = await runHeadless({
      doc: await partialFilletDoc(),
      steps: [
        m({ type: 'add_sketch', featureId: 'sk_free', plane: '@builtin_plane_front' }),
        m({ type: 'add_rect', featureId: 'sk_free', p0: [0, 0], p1: [5, 5] }),
      ],
    })
    const exported = await exportHeadless(built.doc as PartDoc, { format: 'step' })
    expect(exported!.ok).toBe(false)
    expect(exported!.features).toContainEqual(expect.objectContaining({ id: 'fi1', status: 'partial' }))
    expect(exported!.features).toContainEqual(expect.objectContaining({ id: 'sk_free', status: 'underconstrained' }))
  }, 180_000)

  it('reports a failed hole in features and ok false, and still writes the solid it built', async () => {
    const doc = await build(HOLE_ON_LINE_SKETCH)
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(false)
    expect(exported!.features).toContainEqual(expect.objectContaining({
      id: 'h1',
      kind: 'hole',
      status: 'exception',
    }))
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 180_000)

  it('reports an add extruder that reaches no body as ok false', async () => {
    // The base solid still builds and is written; the misplaced add is a
    // feature error, so the export must not present the document as clean.
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
      m({ type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 5, operation: 'new' }),
      m({ type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' }),
      m({ type: 'add_rect', featureId: 'sk2', p0: [50, 50], p1: [60, 60] }),
      m({ type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 5 }),
    ])
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(false)
    expect(exported!.features).toContainEqual(expect.objectContaining({
      id: 'ex2',
      kind: 'extrude',
      status: 'exception',
      message: expect.stringContaining('add does not merge with any existing body'),
    }))
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 180_000)

  it('lists a partial fillet and reports ok false', async () => {
    const doc = await partialFilletDoc()
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(false)
    expect(exported!.features).toContainEqual(expect.objectContaining({ id: 'fi1', status: 'partial' }))
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 180_000)

  it('names the live bodies when the requested body does not exist', async () => {
    const doc = await build(BOX)
    await expect(exportHeadless(doc, { format: 'step', bodyId: 'nope' }))
      .rejects.toMatchObject({ name: 'ExportSelectionError', message: expect.stringContaining('body_ex1') })
  }, 180_000)

  it('names the requested body on an empty document instead of reporting no solid', async () => {
    await expect(exportHeadless(emptyDriveDoc(), { format: 'step', bodyId: 'nope' }))
      .rejects.toMatchObject({
        name: 'ExportSelectionError',
        message: expect.stringContaining("body 'nope' not found; live bodies: none"),
      })
  }, 180_000)

  it('carries an inch document unit through the headless export hop', async () => {
    // The kernel scale is pinned in exportLocalReal; this pins the drive seam
    // (partSolvePayload spreading the doc into the export spec) so a future
    // spec filter cannot drop the unit and export a 25.4x small part.
    const doc = await build(BOX)
    const inch = await exportHeadless({ ...doc, length_unit: 'inch' }, { format: 'step' })
    expect(inch).not.toBeNull()
    const scope = new DisposeScope()
    try {
      // BOX is 10 x 10 x 5 model units; in an inch document that is 254 x 254 x 127 mm.
      const shape = scope.track(stepBytesToShape(oc!, scope, inch!.bytes!))
      expect(volumeOf(oc!, scope, shape)).toBeCloseTo(500 * 25.4 ** 3, 1)
    } finally {
      scope.dispose()
    }
  }, 180_000)

  it('reports ok false when the build left no solid to write', async () => {
    const doc = await build([
      m({ type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' }),
      m({ type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] }),
    ])
    const exported = await exportHeadless(doc, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.bytes).toBeNull()
    // The sketch warning is the tolerated row; the failure here is no solid.
    expect(nonSketchProblems(exported!.features)).toEqual([])
    expect(exported!.features).toContainEqual(expect.objectContaining({ kind: 'sketch', status: 'underconstrained' }))
    expect(exported!.ok).toBe(false)
  }, 180_000)

  it('exports a clean assembly with its solve verdict and ok true', async () => {
    const run = await buildAssembly(PIN_SCRIPT)
    const exported = await exportAssemblyHeadless(run.doc, PARTS, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(true)
    expect(exported!.mates).toEqual([])
    // A part's underconstrained sketch rides its part row as the tolerated
    // warning; it must not make the assembly export fail.
    expect(exported!.parts.flatMap(part => nonSketchProblems(part.features))).toEqual([])
    expect(exported!.parts.flatMap(part => part.features)).toContainEqual(
      expect.objectContaining({ kind: 'sketch', status: 'underconstrained' }),
    )
    expect(exported!.solve.verdict).not.toBe('failed')
    expect(exported!.bytes!.byteLength).toBeGreaterThan(0)
  }, 180_000)

  it('reports an overconstrained assembly as ok false with the solve verdict', async () => {
    const run = await buildAssembly([
      PIN_SCRIPT[0], PIN_SCRIPT[1], CONFLICTING_MATE('m1', 0), CONFLICTING_MATE('m2', 10),
    ])
    const exported = await exportAssemblyHeadless(run.doc, PARTS, { format: 'step' })
    expect(exported).not.toBeNull()
    expect(exported!.ok).toBe(false)
    expect(exported!.solve.verdict).toBe('overconstrained')
    expect(exported!.mates).toContainEqual(expect.objectContaining({ id: '*', status: 'overconstrained' }))
    // The file is still produced when the caller asked for one: the reply, not
    // the absence of bytes, is what says it is not the solved placement.
    expect(exported!.bytes).not.toBeNull()
  }, 180_000)
})
