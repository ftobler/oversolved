import { describe, it, expect } from 'vitest'
import { runBuilderCommand } from './builderWorker'
import { HandleTable } from './handleTable'
import { makeFakeOcc } from './fakeOcc'

describe('runBuilderCommand', () => {
  it('extrudes a square, tessellates, and reports zero leaked handles', async () => {
    const oc = makeFakeOcc()
    const table = new HandleTable({ finalizerGuard: false })
    const res = await runBuilderCommand(
      { id: 1, cmd: 'extrudeSquare' },
      { loadOcc: async () => oc, table },
    )
    expect(res).toEqual({
      id: 1,
      ok: true,
      result: { solidFaces: 6, triangles: 12, profileEdges: 4, generatedSubshapes: 4 },
      liveHandles: 0,
    })
    expect(oc.ledger.live).toBe(0)
  })

  it('stays leak-free across a 100-command loop', async () => {
    const oc = makeFakeOcc()
    const table = new HandleTable({ finalizerGuard: false })
    for (let i = 0; i < 100; i++) {
      const res = await runBuilderCommand(
        { id: i, cmd: 'extrudeSquare', opts: { owner: `f${i}` } },
        { loadOcc: async () => oc, table },
      )
      expect(res.ok).toBe(true)
    }
    expect(table.liveCount()).toBe(0)
    expect(oc.ledger.live).toBe(0)
  })

  it('reports an error response when OCC is unavailable', async () => {
    const table = new HandleTable({ finalizerGuard: false })
    const res = await runBuilderCommand(
      { id: 7, cmd: 'extrudeSquare' },
      { loadOcc: async () => null, table },
    )
    expect(res).toEqual({ id: 7, ok: false, error: 'OCC.js module is not available' })
  })

  it('catches a thrown OCC error into an error response', async () => {
    const table = new HandleTable({ finalizerGuard: false })
    const res = await runBuilderCommand(
      { id: 9, cmd: 'extrudeSquare' },
      {
        loadOcc: async () => {
          throw new Error('WASM trap')
        },
        table,
      },
    )
    expect(res).toEqual({ id: 9, ok: false, error: 'WASM trap' })
  })
})
