// @vitest-environment node
//
// E-4: the worker-wide bundle memo must not turn a transient kernel moment into
// a property of the part. A KernelFault has already reloaded the module and an
// unprovisioned kernel can appear on the next call, so neither is memoised; a
// deterministic build error is the part's own answer and is reused.

import { describe, it, expect, afterEach } from 'vitest'
import type { AssemblyDoc, BodyResult, PartDoc, Transform3D } from '@/types/cad'
import { BUNDLE_SCHEMA, type PartBundle } from '@/kernel/partBundle'
import { KernelFault } from '@/kernel/errors'
import {
  createHeadlessAssembly,
  emptyDriveAssemblyDoc,
  setMateSolver,
  type InjectedBundle,
} from '../headlessAssembly'

const IDENTITY: Transform3D = { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

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

function partDoc(id: string): PartDoc {
  return { version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] } as PartDoc
}

function assemblyWith(partId: string): AssemblyDoc {
  const base = emptyDriveAssemblyDoc()
  return {
    ...base,
    features: [
      ...(base.features ?? []),
      {
        id: `inst_${partId}`,
        kind: 'part_instance',
        instance: { handle: partId, doc_id: partId, doc_rev: 0, transform: IDENTITY },
      },
    ],
  }
}

function bundle(docId: string): InjectedBundle {
  const value: PartBundle = {
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
  return { bundle: value, bodies: { body_ex1: BODY }, features: [] }
}

function sessionFor(partId: string, source: (docId: string, part: PartDoc) => Promise<InjectedBundle | null>) {
  return createHeadlessAssembly({
    doc: assemblyWith(partId),
    parts: new Map([[partId, partDoc(partId)]]),
    bundleSource: source,
  })
}

afterEach(() => {
  setMateSolver(null)
})

describe('a failed bundle build in the worker memo', () => {
  it('does not memoise a KernelFault: the next session rebuilds and succeeds', async () => {
    const id = 'fault_part'
    let builds = 0
    let fault: unknown = new KernelFault('memory access out of bounds')
    const source = async (docId: string, _part: PartDoc): Promise<InjectedBundle> => {
      builds += 1
      if (fault !== null) {
        const e = fault
        fault = null
        throw e
      }
      return bundle(docId)
    }

    const first = sessionFor(id, source)
    await first.solve()
    expect(builds).toBe(1)
    expect(first.partOutcomes()[id]?.error).toContain('bundle build failed')
    expect(first.partOutcomes()[id]?.error).toContain('kernel fault')

    const second = sessionFor(id, source)
    await second.solve()
    expect(builds).toBe(2)
    expect(second.partOutcomes()[id]?.error).toBeUndefined()
  })

  it('does not memoise an unavailable solver', async () => {
    const id = 'unavailable_part'
    let builds = 0
    let unavailable = true
    const source = async (docId: string, _part: PartDoc): Promise<InjectedBundle> => {
      builds += 1
      if (unavailable) {
        unavailable = false
        throw new Error('local solver unavailable (OCC.js is not provisioned)')
      }
      return bundle(docId)
    }

    const first = sessionFor(id, source)
    await first.solve()
    expect(builds).toBe(1)
    expect(first.partOutcomes()[id]?.error).toContain('local solver unavailable')

    const second = sessionFor(id, source)
    await second.solve()
    expect(builds).toBe(2)
    expect(second.partOutcomes()[id]?.error).toBeUndefined()
  })

  it('keeps a deterministic build error memoised for the same part content', async () => {
    const id = 'deterministic_part'
    let builds = 0
    const source = async (): Promise<InjectedBundle> => {
      builds += 1
      throw new Error('feature ex1 has no profile')
    }

    const first = sessionFor(id, source)
    await first.solve()
    expect(builds).toBe(1)
    expect(first.partOutcomes()[id]?.error).toContain('feature ex1 has no profile')

    const second = sessionFor(id, source)
    await second.solve()
    // Same doc content: the cached failure answers without another build, and
    // still names the part's own reason.
    expect(builds).toBe(1)
    expect(second.partOutcomes()[id]?.error).toContain('feature ex1 has no profile')
  })
})
