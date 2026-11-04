// @vitest-environment node
//
// The ids ordinary assembly steps report: one diff of the feature ids the step
// added, so a chained author can name the instance or mate a step just made. A
// step that only edits, toggles or deletes adds nothing and reports []. The
// macros keep their explicit lists, pinned in their own suites, and the compact
// reply still collapses accepted steps instead of carrying the ids.

import { describe, it, expect, afterEach } from 'vitest'
import type { AssemblyDoc, BodyResult, PartDoc } from '@/types/cad'
import type { PartBundle } from '@/kernel/partBundle'
import { BUNDLE_SCHEMA } from '@/kernel/partBundle'
import { makeEchoSolver } from '@/kernel/solveAssemblyTestUtils'
import { createHeadlessAssembly, emptyDriveAssemblyDoc, setMateSolver, type InjectedBundle } from '../headlessAssembly'
import type { AssemblyScriptStep } from '../headlessAssembly'
import { assemblyRunReply } from '../mcpDocRef'
import { DocHandleStore } from '../docHandleStore'

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
  const part: PartBundle = {
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
  return { bundle: part, bodies: { body_ex1: BODY } }
}

function session(doc: AssemblyDoc = emptyDriveAssemblyDoc()) {
  return createHeadlessAssembly({
    doc,
    parts: new Map([['part_a', partDoc('part_a')], ['part_b', partDoc('part_b')]]),
    bundleSource: async docId => bundle(docId),
  })
}

const PLACE_A: AssemblyScriptStep = {
  mutation: { type: 'add_part', handle: 'plate', part: 'part_a', fixed: true },
}
const PLACE_B: AssemblyScriptStep = {
  mutation: { type: 'add_part', handle: 'drawer', part: 'part_b', position: [30, 0, 0] },
}
const MATE: AssemblyScriptStep = {
  mutation: {
    type: 'add_mate', featureId: 'm_slide', kind: 'fixed',
    ref_a: { part: 'plate', anchor: 'face' }, ref_b: { part: 'drawer', anchor: 'face' },
  },
}
const BASE: AssemblyScriptStep[] = [PLACE_A, PLACE_B, MATE]

afterEach(() => {
  setMateSolver(null)
})

describe('assembly step createdIds', () => {
  it('names the placed instance and the mate feature a step added', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    const outcome = await s.run([
      { mutation: { type: 'add_part', handle: 'drawer', part: 'part_a', fixed: true } },
      { mutation: {
        type: 'add_mate', featureId: 'm_slide', kind: 'sliding',
        ref_a: { part: 'drawer', anchor: 'face' },
        ref_b: { part: '__assembly', anchor: 'AssemblyTop' },
      } },
    ])

    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map(step => step.createdIds)).toEqual([
      ['inst_drawer'],
      ['m_slide'],
    ])
  })

  it('names every placed instance and the mate of a longer run', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    const outcome = await s.run(BASE)

    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map(step => step.createdIds)).toEqual([
      ['inst_plate'],
      ['inst_drawer'],
      ['m_slide'],
    ])
  })

  it('names a duplicate and reports nothing for a ref or parameter edit', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run(BASE)
    const outcome = await s.run([
      { mutation: { type: 'duplicate_part', handle: 'plate', newHandle: 'plate2' } },
      { mutation: { type: 'set_mate_ref', featureId: 'm_slide', field: 'ref_b', ref: { part: 'plate2', anchor: 'face' } } },
      { mutation: { type: 'update_mate', featureId: 'm_slide', offset: 2 } },
    ])

    expect(outcome.ok).toBe(true)
    expect(outcome.steps.map(step => step.createdIds)).toEqual([
      ['inst_plate2'],
      [],
      [],
    ])
  })

  it('reports nothing for a seed-keeping fixed toggle and still names the kept pose', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run(BASE)
    const outcome = await s.run([
      { mutation: { type: 'set_part_fixed', handle: 'plate', fixed: false, bake: false } },
    ])

    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0].createdIds).toEqual([])
    expect(outcome.steps[0].poseKept).toBe('seed')
  })

  it('reports nothing for a delete, so a deletion is never an addition', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    await s.run(BASE)
    const outcome = await s.run([{ mutation: { type: 'delete_part', handle: 'drawer' } }])

    expect(outcome.ok).toBe(true)
    expect(outcome.steps[0].createdIds).toEqual([])
  })

  it('the full MCP reply carries the ids, and the summary reply collapses the steps', async () => {
    setMateSolver(makeEchoSolver())
    const s = session()
    const outcome = await s.run(BASE)
    const source = {
      ok: outcome.ok,
      outcome,
      doc: s.getDoc(),
      binding: s.boundParts(),
      solve: s.lastSolve()!.status,
      mates: [],
      partProblems: [],
      instances: [],
      mateFrames: {},
      summary: 'instances: plate, drawer; mates: m_slide',
    }
    const reply = assemblyRunReply(source, false, new DocHandleStore())

    expect((reply.steps as Array<{ createdIds: string[] }>).map(step => step.createdIds)).toEqual([
      ['inst_plate'],
      ['inst_drawer'],
      ['m_slide'],
    ])

    const summary = assemblyRunReply(source, false, new DocHandleStore(), {
      detail: 'summary', context: { inputDoc: null, baseline: null },
    })

    expect(summary.stepsAccepted).toBe(3)
    expect(summary.steps).toBeUndefined()
  })
})
