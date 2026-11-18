// handleWorkerMessage routing: each request kind must reach its engine and post
// the reply with the transferables that kind owns. The handlers themselves are
// covered in solverWorker.test.ts; here the engines are mocked so the dispatch
// (including the non-droppable one-shot export / bundle jobs) runs for real.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const engines = vi.hoisted(() => ({
  solveLocally: vi.fn(),
  exportLocally: vi.fn(),
  exportAssemblyLocally: vi.fn(),
  measureGeneration: vi.fn(),
  splitStepLocally: vi.fn(),
}))

vi.mock('../../solveLocally', () => ({
  solveLocally: (...args: unknown[]) => engines.solveLocally(...args),
  exportLocally: (...args: unknown[]) => engines.exportLocally(...args),
  exportAssemblyLocally: (...args: unknown[]) => engines.exportAssemblyLocally(...args),
  measureGeneration: (...args: unknown[]) => engines.measureGeneration(...args),
  splitStepLocally: (...args: unknown[]) => engines.splitStepLocally(...args),
  setOccLoader: vi.fn(),
}))

import { handleWorkerMessage, WorkerActor } from '../solverWorker'
import type { BundleResponse, ExportResponse, MeasureResponse, SolveResponse, SplitStepResponse } from '../solverProtocol'

type Posted = { res: SolveResponse | ExportResponse | BundleResponse | MeasureResponse | SplitStepResponse; transfer: Transferable[] }

function postInto(): { posted: Posted[]; post: (res: Posted['res'], transfer: Transferable[]) => void } {
  const posted: Posted[] = []
  return { posted, post: (res, transfer) => posted.push({ res, transfer }) }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('handleWorkerMessage dispatch', () => {
  it('routes an export message to exportLocally and transfers its bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    engines.exportLocally.mockResolvedValueOnce(bytes)
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      { id: 5, kind: 'export', spec: { id: 'd' }, options: { format: 'step' } },
      post,
      actor,
    )
    await flush()

    expect(engines.exportLocally).toHaveBeenCalledWith({ id: 'd' }, { format: 'step' }, expect.any(Map))
    expect(posted).toHaveLength(1)
    expect(posted[0].res).toMatchObject({ id: 5, ok: true, bytes })
    expect(posted[0].transfer).toEqual([bytes.buffer])
  })

  it('routes an assembly export message to exportAssemblyLocally and transfers its bytes', async () => {
    const bytes = new Uint8Array([4, 5])
    engines.exportAssemblyLocally.mockResolvedValueOnce(bytes)
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      { id: 6, kind: 'exportAssembly', parts: [], options: { format: 'step' } },
      post,
      actor,
    )
    await flush()

    expect(engines.exportAssemblyLocally).toHaveBeenCalledWith([], { format: 'step' }, expect.any(Map))
    expect(posted[0].res).toMatchObject({ id: 6, ok: true, bytes })
    expect(posted[0].transfer).toEqual([bytes.buffer])
  })

  it('routes a split message to splitStepLocally and transfers every solid', async () => {
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([4, 5])
    engines.splitStepLocally.mockResolvedValueOnce({
      solids: [{ bytes: first, volume: 8 }, { bytes: second, volume: 27 }],
      leftovers: 0,
    })
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      { id: 8, kind: 'splitStep', bytes: new Uint8Array([0]) },
      post,
      actor,
    )
    await flush()

    expect(engines.splitStepLocally).toHaveBeenCalledWith(new Uint8Array([0]), undefined)
    expect(posted[0].res).toMatchObject({ id: 8, ok: true, leftovers: 0 })
    expect((posted[0].res as SplitStepResponse).ok).toBe(true)
    expect(posted[0].transfer).toEqual([first.buffer, second.buffer])
  })

  it('answers a split with the kernel error when OCC is unavailable', async () => {
    engines.splitStepLocally.mockResolvedValueOnce(null)
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      { id: 9, kind: 'splitStep', bytes: new Uint8Array([0]) },
      post,
      actor,
    )
    await flush()

    expect(posted[0].res).toMatchObject({ id: 9, ok: false })
    expect(String((posted[0].res as { error?: string }).error)).toContain('local solver unavailable')
  })

  it('routes a bundle message to solveLocally and posts a PartBundle', async () => {
    engines.solveLocally.mockResolvedValueOnce({ bodies: {} })
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      { id: 7, kind: 'buildBundle', spec: { id: 'd' }, doc_id: 'doc', content_hash: 'h1' },
      post,
      actor,
    )
    await flush()

    expect(engines.solveLocally).toHaveBeenCalledWith({ id: 'd' }, { files: expect.any(Map) })
    const res = posted[0].res as BundleResponse
    expect(res).toMatchObject({ id: 7, ok: true })
    if (res.ok) expect(res.payload).toMatchObject({ doc_id: 'doc', content_hash: 'h1' })
  })

  it('routes a solve message and transfers the packed mesh buffers', async () => {
    engines.solveLocally.mockResolvedValueOnce({
      solve_ms: 1,
      result: {},
      bodies: { b1: { mesh: { vertices: [[0, 0, 0]], faces: [[0, 0, 0]] } } },
      _build_state: { feature_order: [], checkpoints: {} },
    })
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage({ id: 8, kind: 'solve', spec: {}, options: {} }, post, actor)
    await flush()

    expect(posted).toHaveLength(1)
    expect(posted[0].res).toMatchObject({ id: 8, ok: true })
    expect(posted[0].transfer).toHaveLength(2)
  })

  it('carries the engine-stamped solve generation through to the payload', async () => {
    engines.solveLocally.mockResolvedValueOnce({
      solve_ms: 1,
      result: {},
      bodies: {},
      _build_state: { feature_order: [], checkpoints: {} },
      generation: 'boot:9',
    })
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage({ id: 11, kind: 'solve', spec: {}, options: {} }, post, actor)
    await flush()

    expect(posted[0].res).toMatchObject({ id: 11, ok: true, payload: { generation: 'boot:9' } })
  })

  it('routes a measure message to the engine and posts the value', async () => {
    engines.measureGeneration.mockResolvedValueOnce({
      ok: true,
      value: 12.5,
      points: [[0, 0, 0], [1, 1, 1]],
      note: 'touching',
    })
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      {
        id: 12,
        kind: 'measure',
        generation: 'boot:9',
        set: 'final',
        op: 'clearance',
        picks: [{ bodyId: 'b1', kind: 'body' }, { bodyId: 'b2', kind: 'body' }],
      },
      post,
      actor,
    )
    await flush()

    expect(engines.measureGeneration).toHaveBeenCalledWith({
      generation: 'boot:9',
      set: 'final',
      op: 'clearance',
      picks: [{ bodyId: 'b1', kind: 'body' }, { bodyId: 'b2', kind: 'body' }],
    })
    expect(posted).toHaveLength(1)
    expect(posted[0].res).toMatchObject({
      id: 12, ok: true, value: 12.5, note: 'touching',
    })
    expect(posted[0].transfer).toEqual([])
  })

  it('posts a refusal as an error response, not a crash', async () => {
    engines.measureGeneration.mockResolvedValueOnce({ ok: false, error: 'measure stale' })
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage(
      { id: 13, kind: 'measure', generation: 'old:1', set: 'pick', op: 'length', picks: [] },
      post,
      actor,
    )
    await flush()

    expect(posted[0].res).toEqual({ id: 13, ok: false, error: 'measure stale' })
  })

  it('still errors on an unknown message kind', async () => {
    const actor = new WorkerActor()
    const { posted, post } = postInto()

    handleWorkerMessage({ id: 14, kind: 'nonsense' } as never, post, actor)
    await flush()

    expect(posted[0].res).toMatchObject({ id: 14, ok: false })
    expect((posted[0].res as { error?: string }).error).toContain('unknown message kind')
  })
})
