import { describe, it, expect } from 'vitest'
import { handleSolveRequest, handleExportRequest, handleBundleRequest, collectTransferables, exportTransferables, bundleTransferables } from './solverWorker'
import type { SolveRequest, ExportRequest, BundleRequest } from './solverProtocol'
import type { BuildResponse } from '../builder'
import type { BuildState } from '../types3d'

const REQ: SolveRequest = { id: 7, spec: { id: 'doc1' }, options: { rollbackPosition: 2 } }

const EXPORT_REQ: ExportRequest = { id: 9, kind: 'export', spec: { id: 'doc1' }, options: { format: 'step' } }

const DUMMY_STATE: BuildState = { feature_order: ['a'], checkpoints: {} }

function fakeResponse(): BuildResponse {
  return {
    solve_ms: 3,
    result: { ok: true },
    bodies: { b1: { mesh: {} } },
    pick_bodies: { p1: {} },
    _validation: { level: 1, passed: true, diffs: {} },
    _build_state: DUMMY_STATE,
  }
}

describe('handleSolveRequest', () => {
  it('strips _build_state and forwards the rest of the response', async () => {
    const res = await handleSolveRequest(REQ, async () => fakeResponse())
    expect(res).toEqual({
      id: 7,
      ok: true,
      payload: {
        solve_ms: 3,
        result: { ok: true },
        bodies: { b1: { mesh: {} } },
        pick_bodies: { p1: {} },
        _validation: { level: 1, passed: true, diffs: {} },
      },
    })
    // The OCC-handle-bearing state must not cross the wire.
    expect(res.ok && res.payload && '_build_state' in res.payload).toBe(false)
  })

  it('passes spec and options through to the engine', async () => {
    let seen: unknown[] = []
    await handleSolveRequest(REQ, async (spec, options) => {
      seen = [spec, options]
      return fakeResponse()
    })
    expect(seen).toEqual([{ id: 'doc1' }, { rollbackPosition: 2 }])
  })

  it('forwards a null engine result as an ok response with null payload', async () => {
    const res = await handleSolveRequest(REQ, async () => null)
    expect(res).toEqual({ id: 7, ok: true, payload: null })
  })

  it('catches an Error throw into an error response', async () => {
    const res = await handleSolveRequest(REQ, async () => {
      throw new Error('kernel boom')
    })
    expect(res).toEqual({ id: 7, ok: false, error: 'kernel boom' })
  })

  it('catches a non-Error throw into a stringified error response', async () => {
    const res = await handleSolveRequest(REQ, async () => {
      throw 'plain string'
    })
    expect(res).toEqual({ id: 7, ok: false, error: 'plain string' })
  })
})

describe('handleExportRequest', () => {
  it('returns the engine bytes and marks the buffer transferable', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    let seen: unknown[] = []
    const res = await handleExportRequest(EXPORT_REQ, async (spec, options) => {
      seen = [spec, options]
      return bytes
    })
    expect(seen).toEqual([{ id: 'doc1' }, { format: 'step' }])
    expect(res).toEqual({ id: 9, ok: true, bytes })
    expect(exportTransferables(res)).toEqual([bytes.buffer])
  })

  it('forwards a null engine result with no transferables', async () => {
    const res = await handleExportRequest(EXPORT_REQ, async () => null)
    expect(res).toEqual({ id: 9, ok: true, bytes: null })
    expect(exportTransferables(res)).toEqual([])
  })

  it('catches a throw into an error response', async () => {
    const res = await handleExportRequest(EXPORT_REQ, async () => {
      throw new Error('export boom')
    })
    expect(res).toEqual({ id: 9, ok: false, error: 'export boom' })
    expect(exportTransferables(res)).toEqual([])
  })
})

describe('mesh transfer packing', () => {
  // A mesh that shares its arrays with the engine's tess cache; packing must
  // not mutate it.
  const cachedMesh = {
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    faces: [[0, 1, 2]],
    triangle_to_face: [0],
  }
  function meshResponse(): BuildResponse {
    return {
      solve_ms: 1,
      result: {},
      bodies: { b1: { id: 'b1', mesh: cachedMesh, edges: [], vertices: [] } },
      pick_bodies: { p1: { id: 'p1', mesh: { vertices: [[2, 2, 2]], faces: [[0, 0, 0]] } } },
      _build_state: DUMMY_STATE,
    }
  }

  it('converts tuple verts/faces to flat typed arrays without touching the source mesh', async () => {
    const res = await handleSolveRequest(REQ, async () => meshResponse())
    expect(res.ok).toBe(true)
    const mesh = res.ok && (res.payload!.bodies.b1 as { mesh: { vertices: unknown; faces: unknown } }).mesh
    expect(mesh).toBeTruthy()
    if (!mesh) return
    expect(mesh.vertices).toBeInstanceOf(Float32Array)
    expect(mesh.faces).toBeInstanceOf(Uint32Array)
    expect(Array.from(mesh.vertices as Float32Array)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(mesh.faces as Uint32Array)).toEqual([0, 1, 2])
    // The engine's cached mesh is untouched (still tuples) -- no cache corruption.
    expect(cachedMesh.vertices).toEqual([[0, 0, 0], [1, 0, 0], [0, 1, 0]])
    expect(Array.isArray(cachedMesh.vertices)).toBe(true)
  })

  it('collects the verts/faces buffers of bodies and pick_bodies for transfer', async () => {
    const res = await handleSolveRequest(REQ, async () => meshResponse())
    const transfer = collectTransferables(res)
    // 2 buffers per mesh (verts + faces) x (1 body + 1 pick body) = 4.
    expect(transfer).toHaveLength(4)
    expect(transfer.every((b) => b instanceof ArrayBuffer)).toBe(true)
  })

  it('passes through a body with no mesh and collects nothing', async () => {
    const res = await handleSolveRequest(REQ, async () => ({
      solve_ms: 0, result: {}, bodies: { b1: { id: 'b1' } }, _build_state: DUMMY_STATE,
    }))
    expect(res.ok && res.payload!.bodies.b1).toEqual({ id: 'b1' })
    expect(collectTransferables(res)).toHaveLength(0)
  })
})

describe('handleBundleRequest', () => {
  const BUNDLE_REQ: BundleRequest = { id: 4, kind: 'buildBundle', spec: { id: 'doc1' }, doc_id: 'abc', doc_rev: 3 }

  it('converts solve output to a PartBundle with typed arrays', async () => {
    const res = await handleBundleRequest(BUNDLE_REQ, async () => ({
      solve_ms: 1,
      result: { ok: true },
      bodies: {
        b1: {
          id: 'b1', created_by: 'ex1', modified_by: [],
          mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], triangle_to_face: [0] },
          edges: [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }],
          edge_queries: ['edge1'],
        },
      },
      _build_state: DUMMY_STATE,
    }))
    expect(res.ok).toBe(true)
    expect(res.ok && res.payload.doc_id).toBe('abc')
    expect(res.ok && res.payload.doc_rev).toBe(3)
    expect(res.ok && res.payload.anchors).toEqual({})
    expect(res.ok && res.payload.bodies.length).toBe(1)
    const body = res.ok && res.payload.bodies[0]
    expect(body && body.mesh.vertices).toBeInstanceOf(Float32Array)
    expect(body && body.mesh.indices).toBeInstanceOf(Uint32Array)
    expect(body && body.mesh.faceIdsPerTriangle).toBeInstanceOf(Uint32Array)
    expect(body && body.edges).toHaveLength(1)
    expect(body && body.edges[0].kind).toBe('line')
  })

  it('collects vertex, index, and faceId buffers as transferables', async () => {
    const res = await handleBundleRequest(BUNDLE_REQ, async () => ({
      solve_ms: 1,
      result: {},
      bodies: {
        b1: {
          id: 'b1', created_by: 'ex1', modified_by: [],
          mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], triangle_to_face: [0] },
        },
        b2: {
          id: 'b2', created_by: 'ex1', modified_by: [],
          mesh: { vertices: [[2, 2, 2], [3, 2, 2], [2, 3, 2]], faces: [[0, 1, 2]], triangle_to_face: [0] },
        },
      },
      _build_state: DUMMY_STATE,
    }))
    const transfer = bundleTransferables(res)
    // 3 buffers per body (vertices + indices + faceIdsPerTriangle) x 2 bodies = 6
    expect(transfer).toHaveLength(6)
    expect(transfer.every((b) => b instanceof ArrayBuffer)).toBe(true)
  })

  it('forwards a null engine result as an error response', async () => {
    const res = await handleBundleRequest(BUNDLE_REQ, async () => null)
    expect(res).toEqual({ id: 4, ok: false, error: 'OCC.js unavailable' })
    expect(bundleTransferables(res)).toEqual([])
  })

  it('catches a throw into an error response', async () => {
    const res = await handleBundleRequest(BUNDLE_REQ, async () => {
      throw new Error('bundle boom')
    })
    expect(res).toEqual({ id: 4, ok: false, error: 'bundle boom' })
    expect(bundleTransferables(res)).toEqual([])
  })

  it('passes spec and options to the engine, returns PartBundle with correct doc_id/doc_rev', async () => {
    let seen: unknown[] = []
    await handleBundleRequest({ id: 5, kind: 'buildBundle', spec: { id: 'z' }, doc_id: 'd99', doc_rev: 7 }, async (spec, options) => {
      seen = [spec, options]
      return {
        solve_ms: 0, result: {},
        bodies: { b1: { id: 'b1', created_by: 'e', modified_by: [], mesh: { vertices: [[0, 0, 0]], faces: [[0, 0, 0]] } } },
        _build_state: DUMMY_STATE,
      }
    })
    expect(seen).toEqual([{ id: 'z' }, {}])
  })
})
