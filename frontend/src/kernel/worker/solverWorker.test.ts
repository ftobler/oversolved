import { describe, it, expect } from 'vitest'
import { handleSolveRequest } from './solverWorker'
import type { SolveRequest } from './solverProtocol'
import type { BuildResponse } from '../builder'
import type { BuildState } from '../types3d'

const REQ: SolveRequest = { id: 7, spec: { id: 'doc1' }, options: { rollbackPosition: 2 } }

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
