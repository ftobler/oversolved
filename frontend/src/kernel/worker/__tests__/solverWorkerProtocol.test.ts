// One request, both sides of the wire. solverClient.test.ts and
// solverWorker.test.ts each pin the postMessage shape with their own
// hand-written literals, so a drift between the two would pass both suites.
// This feeds the exact object the client posts into the real worker handler and
// routes the handler's reply back through the client's response path.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  solveViaWorker,
  setSolverWorkerForTest,
  type SolverWorkerLike,
} from '@/kernel/worker/solverClient'
import { handleSolveRequest } from '@/kernel/worker/solverWorker'
import type {
  SolveRequest,
  SolveResponse,
  WorkerRequest,
} from '@/kernel/worker/solverProtocol'

class RecordingWorker implements SolverWorkerLike {
  onmessage: SolverWorkerLike['onmessage'] = null
  onerror: ((e: unknown) => void) | null = null
  posted: WorkerRequest[] = []

  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg)
  }

  terminate(): void {}

  reply(res: SolveResponse): void {
    this.onmessage?.({ data: res })
  }
}

let worker: RecordingWorker

beforeEach(() => {
  setSolverWorkerForTest(() => {
    worker = new RecordingWorker()
    return worker
  })
})

afterEach(() => setSolverWorkerForTest(null))

describe('solver client <-> worker protocol', () => {
  it('carries a solve request into the worker handler and its reply back to the client', async () => {
    const pending = solveViaWorker({ id: 'doc1' }, { rollbackPosition: 2 })
    expect(worker.posted).toHaveLength(1)
    const req = worker.posted[0] as SolveRequest
    expect(req.kind).toBe('solve')

    let seenSpec: unknown
    let seenOptions: unknown
    const res = await handleSolveRequest(req, async (spec, options) => {
      seenSpec = spec
      seenOptions = options
      return {
        solve_ms: 5,
        result: { feat1: { status: 'solved' } },
        bodies: { b1: { id: 'b1' } },
        _build_state: { feature_order: [], checkpoints: {} },
      }
    })
    // The client's request is shaped so the real worker handler reads spec and
    // options back exactly as posted.
    expect(seenSpec).toEqual({ id: 'doc1' })
    expect(seenOptions).toMatchObject({ rollbackPosition: 2 })

    worker.reply(res)
    const out = await pending
    // The worker's response is shaped so the client's extractor reads the
    // payload and fills the main-thread _build_state placeholder.
    expect(out).toEqual({
      solve_ms: 5,
      result: { feat1: { status: 'solved' } },
      bodies: { b1: { id: 'b1' } },
      _build_state: { feature_order: [], checkpoints: {} },
    })
  })
})
