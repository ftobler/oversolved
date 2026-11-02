// @vitest-environment node
//
// add_step_part in the headless session, with injected bundles and no OCC: the
// STEP becomes the bound part document, the instance lands as one undo entry,
// and importing the same file again reuses that document rather than minting a
// second copy of the body.

import { describe, it, expect, afterEach } from 'vitest'
import type { AssemblyDoc, BodyResult, PartDoc } from '@/types/cad'
import type { PartBundle } from '@/kernel/partBundle'
import { BUNDLE_SCHEMA } from '@/kernel/partBundle'
import { createHeadlessAssembly, emptyDriveAssemblyDoc, setMateSolver, type InjectedBundle } from '../headlessAssembly'
import { partInstances } from '@/utils/assemblyMutations'
import type { ScriptStepOutcome } from '../scriptRunner'

const STEP_BYTES = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;\n')

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

function authoredPart(id: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] } as PartDoc
}

function session(parts: ReadonlyMap<string, PartDoc> = new Map(), doc: AssemblyDoc = emptyDriveAssemblyDoc()) {
  return createHeadlessAssembly({
    doc,
    parts,
    files: new Map([['f1', STEP_BYTES]]),
    bundleSource: async docId => bundle(docId),
  })
}

afterEach(() => {
  setMateSolver(null)
})

describe('add_step_part', () => {
  it('binds the synthesized part document and places one instance', async () => {
    const run = session()
    const outcome = await run.run([
      { mutation: { type: 'add_step_part', handle: 'a', file: 'f1', name: 'Double', position: [1, 2, 3] } },
    ])

    expect(outcome.ok).toBe(true)
    const step = outcome.steps[0] as ScriptStepOutcome
    expect(step).toMatchObject({
      ok: true,
      createdIds: ['inst_a'],
      part: { docId: 'step_f1', name: 'Double', fileId: 'f1' },
    })

    const instances = partInstances(run.getDoc())
    expect(instances).toHaveLength(1)
    expect(instances[0]).toMatchObject({
      handle: 'a', doc_id: 'step_f1', transform: expect.objectContaining({ tx: 1, ty: 2, tz: 3 }),
    })

    const part = run.boundParts().step_f1
    expect(part).toBeDefined()
    const importFeature = (part.features ?? []).find(feature => feature.kind === 'import_step')
    expect(importFeature).toMatchObject({ kind: 'import_step', file_id: 'f1', label: 'Double' })
    expect(part.version).toBeGreaterThan(0)
    expect(part.kind).toBe('part')
    // The instance is the undo entry; the binding is session state outside the
    // document, exactly like the workspace entry it stands in for.
    expect(run.history.undoLength()).toBe(1)
  })

  it('reuses one part document for a second instance of the same file', async () => {
    const run = session()
    const outcome = await run.run([
      { mutation: { type: 'add_step_part', handle: 'a', file: 'f1', name: 'Double' } },
      { mutation: { type: 'add_step_part', handle: 'b', file: 'f1', name: 'Other', position: [50, 0, 0] } },
    ])

    expect(outcome.ok).toBe(true)
    expect(partInstances(run.getDoc()).map(instance => instance.handle)).toEqual(['a', 'b'])
    expect(Object.keys(run.boundParts())).toEqual(['step_f1'])
    expect(run.history.undoLength()).toBe(2)
    // The second step names the binding it found, not a request default.
    expect((outcome.steps[1] as ScriptStepOutcome).part).toEqual({ docId: 'step_f1', name: 'Double', fileId: 'f1' })
  })

  it('refuses a file id the run did not supply, naming what it has', async () => {
    const run = session()
    const outcome = await run.run([{ mutation: { type: 'add_step_part', handle: 'a', file: 'ghost' } }])

    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.code).toBe('unknown-target')
    expect(outcome.steps[0].error?.message).toContain('available: f1')
  })

  it('refuses to replace a part bound under the same id with a different document', async () => {
    const run = session(new Map([['step_f1', authoredPart('ex1')]]))
    const outcome = await run.run([{ mutation: { type: 'add_step_part', handle: 'a', file: 'f1' } }])

    expect(outcome.ok).toBe(false)
    expect(outcome.steps[0].error?.message).toContain('does not import')
  })

  it('mints the same part document for the same document and step', async () => {
    const steps = [{ mutation: { type: 'add_step_part' as const, handle: 'a', file: 'f1' } }]
    const first = session()
    const second = session()
    expect((await first.run(steps)).ok).toBe(true)
    expect((await second.run(steps)).ok).toBe(true)
    expect(first.boundParts()).toEqual(second.boundParts())
  })
})
