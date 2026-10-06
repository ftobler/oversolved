import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleSolveRequest, handleExportRequest, handleExportAssemblyRequest, handleBundleRequest, collectTransferables, exportTransferables, bundleTransferables, handleWorkerMessage, WorkerActor, absorbFilesForTest, fileCacheForTest, clearFileCacheForTest } from './solverWorker'
import type { SolveRequest, ExportRequest, ExportAssemblyRequest, BundleRequest, SolveResponse, ExportResponse, BundleResponse, WorkerRequest } from './solverProtocol'
import { SUPERSEDED_ERROR } from './solverProtocol'
import { solveLocally, exportLocally, exportAssemblyLocally } from '../solveLocally'
import type { BuildResponse } from '../builder'
import type { BuildState } from '../types3d'
import type { Transform3D } from '../../types/cad'

// The dispatcher binds the production engines directly (not via injection), so
// the one-shot branches can only be driven without OCC if those engines are
// mocked. The direct handler tests below still inject their own fakes.
vi.mock('../solveLocally', () => ({
  solveLocally: vi.fn(),
  exportLocally: vi.fn(),
  exportAssemblyLocally: vi.fn(),
  setOccLoader: vi.fn(),
}))

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

describe('handleExportAssemblyRequest', () => {
  const PLACED: Transform3D = { tx: 5, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  const REQ_A: ExportAssemblyRequest = {
    id: 11,
    kind: 'exportAssembly',
    parts: [{ spec: { id: 'partA' }, transform: PLACED }],
    options: { format: 'step' },
  }

  it('passes the placed parts and options through, and marks the bytes transferable', async () => {
    const bytes = new Uint8Array([5, 6])
    let seen: unknown[] = []
    const res = await handleExportAssemblyRequest(REQ_A, async (parts, options) => {
      seen = [parts, options]
      return bytes
    })
    expect(seen).toEqual([[{ spec: { id: 'partA' }, transform: PLACED }], { format: 'step' }])
    expect(res).toEqual({ id: 11, ok: true, bytes })
    expect(exportTransferables(res)).toEqual([bytes.buffer])
  })

  it('forwards a null engine result (no OCC, or no solid in any part)', async () => {
    const res = await handleExportAssemblyRequest(REQ_A, async () => null)
    expect(res).toEqual({ id: 11, ok: true, bytes: null })
    expect(exportTransferables(res)).toEqual([])
  })

  it('catches a throw into an error response rather than killing the Worker', async () => {
    const res = await handleExportAssemblyRequest(REQ_A, async () => {
      throw new Error('assembly export boom')
    })
    expect(res).toEqual({ id: 11, ok: false, error: 'assembly export boom' })
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

describe('typed-array mesh producer hardening', () => {
  it('packs an already-typed mesh to fresh arrays and never transfers the engine-owned buffers', async () => {
    // Simulate a future producer that hands the worker typed meshes it still
    // owns (the builder emits tuples today, but the safety must not depend on
    // that). packBody must copy them so the transfer list never contains a
    // buffer the engine still uses for its tess cache or checkpoints.
    const engineVerts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const engineFaces = new Uint32Array([0, 1, 2])
    const res = await handleSolveRequest(REQ, async () => ({
      solve_ms: 1,
      result: {},
      bodies: { b1: { id: 'b1', mesh: { vertices: engineVerts, faces: engineFaces, triangle_to_face: [0] } } },
      _build_state: DUMMY_STATE,
    }))
    expect(res.ok).toBe(true)
    const mesh = res.ok && (res.payload!.bodies.b1 as { mesh: { vertices: Float32Array; faces: Uint32Array } }).mesh
    expect(mesh).toBeTruthy()
    if (!mesh) return
    expect(mesh.vertices).toBeInstanceOf(Float32Array)
    expect(mesh.faces).toBeInstanceOf(Uint32Array)
    // The wire mesh is a fresh copy: it shares no buffer with the engine's
    // input, and the engine's arrays are untouched (never detached).
    expect(mesh.vertices.buffer).not.toBe(engineVerts.buffer)
    expect(mesh.faces.buffer).not.toBe(engineFaces.buffer)
    expect(engineVerts.buffer.byteLength).toBeGreaterThan(0)
    expect(engineFaces.buffer.byteLength).toBeGreaterThan(0)
    const transfer = collectTransferables(res)
    expect(transfer).toHaveLength(2)
    expect(transfer).toContain(mesh.vertices.buffer)
    expect(transfer).toContain(mesh.faces.buffer)
    // The engine's input buffers are never in the transfer list.
    expect(transfer).not.toContain(engineVerts.buffer)
    expect(transfer).not.toContain(engineFaces.buffer)
  })

  it('two bodies sharing one typed array never produce a duplicated transfer entry', async () => {
    // One typed array shared by two bodies: the pre-fix collector pushed the
    // same buffer twice and a real postMessage threw a DataCloneError. Each
    // body must pack its own fresh copy so the transfer list stays unique.
    const sharedVerts = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const sharedFaces = new Uint32Array([0, 1, 2])
    const res = await handleSolveRequest(REQ, async () => ({
      solve_ms: 1,
      result: {},
      bodies: {
        a: { id: 'a', mesh: { vertices: sharedVerts, faces: sharedFaces } },
        b: { id: 'b', mesh: { vertices: sharedVerts, faces: sharedFaces } },
      },
      _build_state: DUMMY_STATE,
    }))
    expect(res.ok).toBe(true)
    const transfer = collectTransferables(res)
    // 2 buffers per body, each body its own fresh copy -> 4 distinct buffers.
    expect(transfer).toHaveLength(4)
    expect(new Set(transfer).size).toBe(4)
    expect(transfer).not.toContain(sharedVerts.buffer)
    expect(transfer).not.toContain(sharedFaces.buffer)
    // A real transfer of this list must not throw the DataCloneError that a
    // duplicated shared buffer produces.
    expect(() => structuredClone({}, { transfer })).not.toThrow()
  })

  it('skips and warns on a typed mesh with no fresh mark instead of transferring it', async () => {
    // Defense in depth: a response that reached the collector WITHOUT packBody
    // running (a regression) must not have its engine-owned buffers transferred
    // (a silent detach). The collector skips the mesh and the warn makes the
    // regression loud.
    const raw: SolveResponse = {
      id: 1,
      ok: true,
      payload: {
        solve_ms: 1,
        result: {},
        bodies: { b1: { id: 'b1', mesh: { vertices: new Float32Array([0, 0, 0]), faces: new Uint32Array([0]) } } },
      },
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const transfer = collectTransferables(raw)
      expect(transfer).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('handleBundleRequest', () => {
  const BUNDLE_REQ: BundleRequest = { id: 4, kind: 'buildBundle', spec: { id: 'doc1' }, doc_id: 'abc', content_hash: 'h3' }

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
    expect(res.ok && res.payload.content_hash).toBe('h3')
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

  it('passes spec and options to the engine, returns PartBundle with correct doc_id/content_hash', async () => {
    let seen: unknown[] = []
    await handleBundleRequest({ id: 5, kind: 'buildBundle', spec: { id: 'z' }, doc_id: 'd99', content_hash: 'h7' }, async (spec, options) => {
      seen = [spec, options]
      return {
        solve_ms: 0, result: {},
        bodies: { b1: { id: 'b1', created_by: 'e', modified_by: [], mesh: { vertices: [[0, 0, 0]], faces: [[0, 0, 0]] } } },
        _build_state: DUMMY_STATE,
      }
    })
    // The empty options object is load-bearing, not a placeholder. solveLocally
    // reads `options.prevState !== undefined ? options.prevState : lastBuildState`,
    // so an ABSENT key is what lets a bundle build reuse the engine's checkpoint
    // cache. Setting `prevState: null` here for symmetry with the other call
    // sites would cost a full stack rebuild on every part edit; measured at
    // ~52 ms per feature (see knowledgebase, "bundle-rev invalidation cost",
    // and kernel/bundleRebuildCost.test.ts).
    expect(seen).toEqual([{ id: 'z' }, {}])
  })
})

describe('dispatcher', () => {
  it('routes a solve message to a supersedable solve job', () => {
    const actor = new WorkerActor()
    const submitSpy = vi.spyOn(actor, 'submit')
    const posted: Array<{ message: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }> = []
    handleWorkerMessage(
      { id: 77, kind: 'solve', spec: { id: 'doc1' }, options: {} },
      (res, transfer) => { posted.push({ message: res, transfer }) },
      actor,
    )

    expect(submitSpy).toHaveBeenCalledTimes(1)
    const job = submitSpy.mock.calls[0][0] as { supersedable: boolean; onSuperseded: () => void }
    expect(job.supersedable).toBe(true)
    // A superseded solve still gets its reply, stamped with the request id.
    job.onSuperseded()
    expect(posted).toEqual([{ message: { id: 77, ok: false, error: SUPERSEDED_ERROR }, transfer: [] }])
  })

  it('replies with an error on an unknown message kind so the client settles', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const actor = new WorkerActor()
      const submitSpy = vi.spyOn(actor, 'submit')
      const posted: Array<{ message: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }> = []
      handleWorkerMessage(
        { id: 99, kind: 'futureKind', spec: {}, options: {} } as unknown as WorkerRequest,
        (res, transfer) => { posted.push({ message: res, transfer }) },
        actor,
      )
      expect(warnSpy).toHaveBeenCalledWith('[solverWorker] unknown message kind', 'futureKind')
      // The solve branch is reached only through an explicit kind check, so a
      // malformed message cannot be mistaken for a solve: no job is queued. It
      // still gets an error reply keyed to its id, or the client promise hangs.
      expect(submitSpy).not.toHaveBeenCalled()
      expect(posted).toEqual([{
        message: { id: 99, ok: false, error: 'unknown message kind: futureKind' },
        transfer: [],
      }])
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('settles a kind-less solve-shaped message with an error instead of dropping it', () => {
    const actor = new WorkerActor()
    const submitSpy = vi.spyOn(actor, 'submit')
    const posted: Array<{ message: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }> = []
    handleWorkerMessage(
      { id: 55, spec: { id: 'doc1' }, options: {} } as WorkerRequest,
      (res, transfer) => { posted.push({ message: res, transfer }) },
      actor,
    )
    expect(submitSpy).not.toHaveBeenCalled()
    expect(posted).toEqual([{
      message: { id: 55, ok: false, error: 'unknown message kind: undefined' },
      transfer: [],
    }])
  })

  it('routes an export message to a one-shot job that posts transferable bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    vi.mocked(exportLocally).mockResolvedValue(bytes)
    const actor = new WorkerActor()
    const submitSpy = vi.spyOn(actor, 'submit').mockImplementation(() => {})
    const posted: Array<{ message: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }> = []
    handleWorkerMessage(
      { id: 21, kind: 'export', spec: { id: 'doc1' }, options: { format: 'step' } },
      (res, transfer) => { posted.push({ message: res, transfer }) },
      actor,
    )

    expect(submitSpy).toHaveBeenCalledTimes(1)
    const job = submitSpy.mock.calls[0][0] as { supersedable: boolean; run: () => Promise<void> }
    // Exports are distinct one-shot actions, never superseded by a newer solve.
    expect(job.supersedable).toBe(false)
    await job.run()
    expect(vi.mocked(exportLocally)).toHaveBeenCalledWith(
      { id: 'doc1' }, { format: 'step' }, fileCacheForTest())
    expect(posted).toEqual([{ message: { id: 21, ok: true, bytes }, transfer: [bytes.buffer] }])
  })

  it('routes an exportAssembly message to a one-shot job with the placed parts', async () => {
    const bytes = new Uint8Array([9, 8])
    vi.mocked(exportAssemblyLocally).mockResolvedValue(bytes)
    const parts: ExportAssemblyRequest['parts'] = [
      { spec: { id: 'partA' }, transform: { tx: 5, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
    ]
    const actor = new WorkerActor()
    const submitSpy = vi.spyOn(actor, 'submit').mockImplementation(() => {})
    const posted: Array<{ message: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }> = []
    handleWorkerMessage(
      { id: 22, kind: 'exportAssembly', parts, options: { format: 'step' } },
      (res, transfer) => { posted.push({ message: res, transfer }) },
      actor,
    )

    expect(submitSpy).toHaveBeenCalledTimes(1)
    const job = submitSpy.mock.calls[0][0] as { supersedable: boolean; run: () => Promise<void> }
    expect(job.supersedable).toBe(false)
    await job.run()
    expect(vi.mocked(exportAssemblyLocally)).toHaveBeenCalledWith(parts, { format: 'step' }, fileCacheForTest())
    expect(posted).toEqual([{ message: { id: 22, ok: true, bytes }, transfer: [bytes.buffer] }])
  })

  it('routes a buildBundle message to a one-shot job that posts typed bundle buffers', async () => {
    vi.mocked(solveLocally).mockResolvedValue({
      solve_ms: 1,
      result: {},
      bodies: {
        b1: {
          id: 'b1', created_by: 'ex1', modified_by: [],
          mesh: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 2]], triangle_to_face: [0] },
        },
      },
      _build_state: DUMMY_STATE,
    })
    const actor = new WorkerActor()
    const submitSpy = vi.spyOn(actor, 'submit').mockImplementation(() => {})
    const posted: Array<{ message: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }> = []
    handleWorkerMessage(
      { id: 23, kind: 'buildBundle', spec: { id: 'doc1' }, doc_id: 'd1', content_hash: 'h1' },
      (res, transfer) => { posted.push({ message: res, transfer }) },
      actor,
    )

    expect(submitSpy).toHaveBeenCalledTimes(1)
    const job = submitSpy.mock.calls[0][0] as { supersedable: boolean; run: () => Promise<void> }
    expect(job.supersedable).toBe(false)
    await job.run()
    expect(vi.mocked(solveLocally)).toHaveBeenCalledWith({ id: 'doc1' }, { files: fileCacheForTest() })
    const bundle = posted[0].message as BundleResponse
    expect(bundle.ok).toBe(true)
    expect(bundle.ok && bundle.payload.doc_id).toBe('d1')
    // One body: vertices + indices + faceIdsPerTriangle.
    expect(posted[0].transfer).toHaveLength(3)
  })
})

describe('per-generation import file cache', () => {
  const FILES = { f1: new Uint8Array([1, 2, 3]) }

  beforeEach(() => clearFileCacheForTest())

  it('hands the cached map to the solve handler', async () => {
    absorbFilesForTest(FILES)
    let seen: ReadonlyMap<string, Uint8Array> | undefined
    await handleSolveRequest(
      { id: 1, spec: {}, options: {} },
      async (_spec, options) => { seen = options?.files; return fakeResponse() },
      fileCacheForTest(),
    )
    expect(seen?.get('f1')).toEqual(FILES.f1)
  })

  it('hands the cached map to the export handler', async () => {
    absorbFilesForTest(FILES)
    let seen: ReadonlyMap<string, Uint8Array> | undefined
    await handleExportRequest(
      { id: 2, kind: 'export', spec: {}, options: { format: 'step' } },
      async (_spec, _options, files) => { seen = files; return null },
      fileCacheForTest(),
    )
    expect(seen?.get('f1')).toEqual(FILES.f1)
  })

  it('hands the cached map to the assembly export handler', async () => {
    absorbFilesForTest(FILES)
    let seen: ReadonlyMap<string, Uint8Array> | undefined
    await handleExportAssemblyRequest(
      { id: 3, kind: 'exportAssembly', parts: [], options: { format: 'step' } },
      async (_parts, _options, files) => { seen = files; return null },
      fileCacheForTest(),
    )
    expect(seen?.get('f1')).toEqual(FILES.f1)
  })

  it('hands the cached map to the bundle handler', async () => {
    absorbFilesForTest(FILES)
    let seen: ReadonlyMap<string, Uint8Array> | undefined
    await handleBundleRequest(
      { id: 4, kind: 'buildBundle', spec: {}, doc_id: 'd', content_hash: 'h1' },
      async (_spec, options) => { seen = options?.files; return null },
      fileCacheForTest(),
    )
    expect(seen?.get('f1')).toEqual(FILES.f1)
  })

  it('a second request with no files still resolves the cached id', () => {
    absorbFilesForTest(FILES)
    absorbFilesForTest(undefined)
    expect(fileCacheForTest().get('f1')).toEqual(FILES.f1)
  })

  it('absorbs a message files map before dispatching it', () => {
    const actor = new WorkerActor()
    // Stub the queue so the real solve engine never runs (no OCC here); the
    // first thing handleWorkerMessage does is the absorb under test.
    const submitSpy = vi.spyOn(actor, 'submit').mockImplementation(() => {})
    handleWorkerMessage(
      { id: 5, kind: 'solve', spec: { id: 'doc1' }, options: {}, files: FILES },
      () => {},
      actor,
    )
    expect(fileCacheForTest().get('f1')).toEqual(FILES.f1)
    expect(submitSpy).toHaveBeenCalledTimes(1)
    submitSpy.mockRestore()
  })
})
