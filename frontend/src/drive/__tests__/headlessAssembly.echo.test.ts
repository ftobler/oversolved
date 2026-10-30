// @vitest-environment node
//
// The headless assembly session with an injected bundle source and an echo mate
// solver: no OCC, no WASM. The undo funnel, the one-entry-per-step rule, the
// bake cell's use of the last solve and the deterministic ids/hash are what the
// drive's error posture rests on.

import { describe, it, expect, afterEach } from 'vitest'
import type { AssemblyDoc, BodyResult, PartDoc } from '@/types/cad'
import type { PartBundle } from '@/kernel/partBundle'
import { BUNDLE_SCHEMA } from '@/kernel/partBundle'
import { makeEchoSolver, makeTranslateSolver } from '@/kernel/solveAssemblyTestUtils'
import { createHeadlessAssembly, emptyDriveAssemblyDoc, setMateSolver, type InjectedBundle } from '../headlessAssembly'
import { docHashOf } from '../docHash'
import { partInstances, findMate } from '@/utils/assemblyMutations'
import type { AssemblyScriptStep } from '../headlessAssembly'

function partDoc(id: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] } as PartDoc
}

const BODY: BodyResult = {
  id: 'body_ex1',
  created_by: 'ex1',
  modified_by: [],
  edges: [],
  mesh: {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    faces: [[0, 1, 2]],
    face_data: [{ centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'flatface' }],
    face_queries: ['q_face'],
    face_edge_queries: [[]],
  },
}

function bundle(docId: string): InjectedBundle {
  const bundle: PartBundle = {
    doc_id: docId,
    content_hash: 'h',
    schema: BUNDLE_SCHEMA,
    bodies: [{
      mesh: { vertices: new Float32Array(0), indices: new Uint32Array(0), faceIdsPerTriangle: new Uint32Array(0) },
      edges: [],
      entityAnchors: { faces: [['face']], edges: [], vertices: [] },
    }],
    anchors: { face: { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], geom_hash: '@u|face', created_by: 'ex1' } },
  }
  return { bundle, bodies: { body_ex1: BODY } }
}

function session(doc: AssemblyDoc = emptyDriveAssemblyDoc()) {
  return createHeadlessAssembly({
    doc,
    parts: new Map([['part_a', partDoc('part_a')], ['part_b', partDoc('part_b')]]),
    bundleSource: async (docId) => bundle(docId),
  })
}

const STEPS: AssemblyScriptStep[] = [
  { mutation: { type: 'add_part', handle: 'left', part: 'part_a', fixed: true } },
  { mutation: { type: 'add_part', handle: 'right', part: 'part_b', position: [30, 0, 0] } },
  { mutation: {
    type: 'add_mate', featureId: 'm1', kind: 'fixed',
    ref_a: { part: 'left', anchor: 'face' }, ref_b: { part: 'right', anchor: 'face' },
  } },
]

afterEach(() => {
  setMateSolver(null)
})

describe('createHeadlessAssembly', () => {
  it('runs a script with one history entry per mutating step', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    const outcome = await s.run(STEPS)
    expect(outcome.ok).toBe(true)
    expect(s.history.undoLength()).toBe(3)
    expect(s.getDoc().features!.map(f => f.id)).toEqual([
      'AssemblyOrigin', 'AssemblyTop', 'AssemblyFront', 'AssemblyRight', 'inst_left', 'inst_right', 'm1',
    ])
  })

  it('undo restores the pre-step doc and redo re-applies it', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run(STEPS.slice(0, 2))
    const beforeMate = s.getDoc()
    await s.run([STEPS[2]])
    expect(findMate(s.getDoc(), 'm1')).toBeDefined()
    await s.run([{ command: 'undo' }])
    expect(s.getDoc()).toEqual(beforeMate)
    expect(findMate(s.getDoc(), 'm1')).toBeUndefined()
    await s.run([{ command: 'redo' }])
    expect(findMate(s.getDoc(), 'm1')).toBeDefined()
  })

  it('a bake op writes the previous solve into the other instance seed', async () => {
    setMateSolver(makeTranslateSolver(10))
    const s = session()
    // A parallel mate, not the fixed STEPS one: the mate seeding places a
    // fixed mate's part in closed form, which would replace the authored seed
    // this test chains the translate solver and the bake through.
    const parallelSteps = STEPS.map(step => (
      'mutation' in step && step.mutation.type === 'add_mate'
        ? { mutation: { ...step.mutation, kind: 'parallel' } }
        : step
    )) as AssemblyScriptStep[]
    const outcome = await s.run([
      ...parallelSteps,
      // A deferred solve cell: the mate solves here, moving body 1.
      { mutation: { type: 'update_mate', featureId: 'm1', flip: true } },
      // The structural fixed toggle bakes every non-fixed solved pose.
      { mutation: { type: 'set_part_fixed', handle: 'left', fixed: false } },
    ])
    expect(outcome.ok).toBe(true)
    const right = partInstances(s.getDoc()).find(i => i.handle === 'right')!
    expect(right.transform.tx).toBeCloseTo(40, 9)
    expect(partInstances(s.getDoc()).find(i => i.handle === 'left')!.fixed).toBe(false)
    // The reply carries the solved pose; the doc keeps what the bake wrote.
    expect(s.lastSolve()!.transforms.right.tx).toBeCloseTo(50, 9)
  })

  it('a bake: false fixed toggle writes no flag and no undo entry when the flag is already correct', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run(STEPS)
    const before = s.getDoc()
    const rightBefore = partInstances(before).find(i => i.handle === 'right')!
    // The instance never carried a `fixed` key: an absent key means false, so
    // this toggle is a value no-op that must stay a document no-op.
    expect(rightBefore).not.toHaveProperty('fixed')
    const depth = s.history.undoLength()
    const toggle: AssemblyScriptStep[] = [
      { mutation: { type: 'set_part_fixed', handle: 'right', fixed: false, bake: false } },
    ]

    const first = await s.run(toggle)
    expect(first.ok).toBe(true)
    expect(first.steps[0]).toMatchObject({ ok: true, poseKept: 'seed' })
    // The flag-only write keeps the guarded setter's promise: no materialized
    // `fixed: false` key and no dead undo entry for re-setting false.
    const rightAfter = partInstances(s.getDoc()).find(i => i.handle === 'right')!
    expect(rightAfter).toEqual(rightBefore)
    expect(rightAfter).not.toHaveProperty('fixed')
    expect(s.getDoc()).toEqual(before)
    expect(s.history.undoLength()).toBe(depth)

    // Repeating it charges nothing either: the already-correct case is a
    // no-op the undo funnel absorbs.
    const second = await s.run(toggle)
    expect(second.ok).toBe(true)
    expect(s.getDoc()).toEqual(before)
    expect(s.history.undoLength()).toBe(depth)
  })

  it('ids are exactly the authored ones and a rerun hashes the same doc', async () => {
    setMateSolver(makeEchoSolver())
    const first = session()
    await first.run(STEPS)
    const second = session()
    await second.run(STEPS)
    expect(partInstances(second.getDoc()).map(i => i.handle)).toEqual(['left', 'right'])
    expect(docHashOf(first.getDoc())).toBe(docHashOf(second.getDoc()))
    expect(second.getDoc().features!.map(f => f.id)).toEqual(first.getDoc().features!.map(f => f.id))
  })

  it('refuses an insert_mate_* command as unsupported, naming add_mate', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    const outcome = await s.run([{ command: 'insert_mate_fixed' }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0]).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(outcome.steps[0].error!.message).toContain('add_mate')
  })

  it('reports an unbound part by name as a failed step', async () => {
    setMateSolver(makeEchoSolver())
    const s = createHeadlessAssembly({ doc: emptyDriveAssemblyDoc(), parts: new Map(), bundleSource: async () => bundle('x') })
    const outcome = await s.run([{ mutation: { type: 'add_part', handle: 'x', part: 'ghost' } }])
    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error!.message).toContain('not bound')
  })
})
