/**
 * The CI memory-safety gate. Runs the extrude+tessellate workload
 * against the FakeOcc double (no 66 MB binary required, so it runs everywhere)
 * and asserts that, once the produced solid's handle is released, both the
 * HandleTable and the fake's object ledger are empty. A stranded transient or
 * an un-released body fails this test. The same workload runs against the real
 * opencascade.js module in the gated `occReal.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { extrudeSquareAndTessellate } from './spikeBuild'
import { HandleTable } from './handleTable'
import { makeFakeOcc } from './fakeOcc'

describe('extrudeSquareAndTessellate (fake OCC leak gate)', () => {
  it('produces the expected square-extrude topology', () => {
    const oc = makeFakeOcc()
    const table = new HandleTable({ finalizerGuard: false })
    const { result, solid } = extrudeSquareAndTessellate(oc, table)
    expect(result).toEqual({
      solidFaces: 6,
      triangles: 12,
      profileEdges: 4,
      generatedSubshapes: 4,
    })
    table.release(solid)
  })

  it('leaves zero live handles and deletes every owned object exactly once', () => {
    const oc = makeFakeOcc()
    const table = new HandleTable({ finalizerGuard: false })
    const { solid } = extrudeSquareAndTessellate(oc, table)

    // The solid is still held by the table (a checkpoint owns it); everything
    // else has been disposed.
    expect(table.liveCount()).toBe(1)
    expect(oc.ledger.live).toBe(1)  // just the solid

    table.release(solid)  // checkpoint eviction
    expect(table.liveCount()).toBe(0)
    expect(oc.ledger.live).toBe(0)
    expect(oc.ledger.doubleDeletes).toBe(0)
    table.assertNoLeaks()
  })

  it('stays leak-free across a 100-iteration build/evict loop', () => {
    const oc = makeFakeOcc()
    const table = new HandleTable({ finalizerGuard: false })
    for (let i = 0; i < 100; i++) {
      const { solid } = extrudeSquareAndTessellate(oc, table, { owner: `feat${i}` })
      table.release(solid)
    }
    expect(table.liveCount()).toBe(0)
    expect(oc.ledger.live).toBe(0)
    expect(oc.ledger.doubleDeletes).toBe(0)
    expect(oc.ledger.created).toBeGreaterThan(100)  // the loop actually did work
    table.assertNoLeaks()
  })

  it('does not leak when checkpoint eviction is by owner', () => {
    const oc = makeFakeOcc()
    const table = new HandleTable({ finalizerGuard: false })
    extrudeSquareAndTessellate(oc, table, { owner: 'featA' })
    extrudeSquareAndTessellate(oc, table, { owner: 'featB' })
    expect(table.liveCount()).toBe(2)
    table.releaseOwner('featA')
    table.releaseOwner('featB')
    expect(table.liveCount()).toBe(0)
    expect(oc.ledger.live).toBe(0)
  })
})
