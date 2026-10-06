// handleWorkerMessage routing: each request kind must reach its engine and post
// the reply with the transferables that kind owns. The handlers themselves are
// covered in solverWorker.test.ts; here the engines are mocked so the dispatch
// (including the non-droppable one-shot export / bundle jobs) runs for real.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const engines = vi.hoisted(() => ({
  solveLocally: vi.fn(),
  exportLocally: vi.fn(),
  exportAssemblyLocally: vi.fn(),
}))

vi.mock('../../solveLocally', () => ({
  solveLocally: (...args: unknown[]) => engines.solveLocally(...args),
  exportLocally: (...args: unknown[]) => engines.exportLocally(...args),
  exportAssemblyLocally: (...args: unknown[]) => engines.exportAssemblyLocally(...args),
  setOccLoader: vi.fn(),
}))

import { handleWorkerMessage, WorkerActor } from '../solverWorker'
import type { BundleResponse, ExportResponse, SolveResponse } from '../solverProtocol'

type Posted = { res: SolveResponse | ExportResponse | BundleResponse; transfer: Transferable[] }

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
})
