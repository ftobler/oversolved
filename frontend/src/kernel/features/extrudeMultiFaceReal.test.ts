// @vitest-environment node
//
// Real-OCC coverage for the multi-face branch of solveExtrude: a profile made
// of SEVERAL picked coplanar body faces. Every picked face is swept into its own
// prism and the prisms are fused into one tool (fuseChain), so dropping all but
// face 0 silently loses geometry. Uses the low-level solveExtrude harness (two
// prepared box bodies, slash face refs) so the assertion is on the produced
// volume, not on a mock call.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { makeBox, makeBoxAt, faceNormal } from '../occ/primitives'
import { sortedFacesOf } from '../occ/faceLoops'
import { volumeOf } from '../occ/booleans'
import { Repository } from '../query'
import { solveExtrude } from './extrude'
import type { Body } from '../types3d'
import type { OccModule, OccShape } from '../occ/occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('solveExtrude multi-face profiles (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  // Top (+z) face of a box, in the sorted index space the slash ref indexes.
  function topFaceIndex(scope: DisposeScope, shape: OccShape): number {
    const faces = sortedFacesOf(occ, scope, shape)
    for (let i = 0; i < faces.length; i++) {
      if (faceNormal(occ, scope, faces[i])[2] > 0.9) return i
    }
    throw new Error('box has no +z face')
  }

  function twoBoxes(scope: DisposeScope, table: HandleTable): Record<string, Body> {
    const a = makeBox(occ, scope, 10, 10, 10)
    const b = makeBoxAt(occ, scope, [20, 0, 0], 10, 10, 10)
    return {
      body_a: {
        id: 'body_a', created_by: 'ea', modified_by: [], shape: table.register(a, 'ea'),
        sketch_id: 'ska', brep_diff: null, profile_queries: [],
      },
      body_b: {
        id: 'body_b', created_by: 'eb', modified_by: [], shape: table.register(b, 'eb'),
        sketch_id: 'skb', brep_diff: null, profile_queries: [],
      },
    }
  }

  // Sum the volume of every body the feature minted (ids other than the sources).
  function mintedVolume(scope: DisposeScope, table: HandleTable, store: Record<string, Body>): { volume: number; count: number } {
    let volume = 0
    let count = 0
    for (const [bid, body] of Object.entries(store)) {
      if (bid === 'body_a' || bid === 'body_b' || body.shape === null) continue
      count++
      volume += volumeOf(occ, scope, table.get<OccShape>(body.shape))
    }
    return { volume, count }
  }

  function solve(scope: DisposeScope, table: HandleTable, store: Record<string, Body>, sub: Record<string, unknown>) {
    return solveExtrude(occ, scope, table, { id: 'm1', extrude: sub }, new Repository(), store)
  }

  it('fuses picked coplanar faces into one tool, not just the first face', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store = twoBoxes(scope, table)
      const ia = topFaceIndex(scope, table.get<OccShape>(store.body_a.shape!))
      const ib = topFaceIndex(scope, table.get<OccShape>(store.body_b.shape!))
      const result = solve(scope, table, store, {
        sketch: [`@body_a/face/${ia}`, `@body_b/face/${ib}`],
        distance: 5, direction: 'normal', operation: 'new',
      })
      expect(result.status).toBe('ok')
      // Two disjoint prisms, each 100 area * 5: face B was not dropped.
      const { volume, count } = mintedVolume(scope, table, store)
      expect(count).toBe(2)
      expect(volume).toBeCloseTo(1000, 2)
    } finally {
      scope.dispose()
    }
  })

  it('symmetric multi-face extrude splits each face into a pair first', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store = twoBoxes(scope, table)
      const ia = topFaceIndex(scope, table.get<OccShape>(store.body_a.shape!))
      const ib = topFaceIndex(scope, table.get<OccShape>(store.body_b.shape!))
      const result = solve(scope, table, store, {
        sketch: [`@body_a/face/${ia}`, `@body_b/face/${ib}`],
        distance: 6, direction: 'symmetric', operation: 'new',
      })
      expect(result.status).toBe('ok')
      // Each face sweeps 3 either side of its plane: 100 * 6 per face.
      const { volume, count } = mintedVolume(scope, table, store)
      expect(count).toBe(2)
      expect(volume).toBeCloseTo(1200, 2)
    } finally {
      scope.dispose()
    }
  })

  it('reverse multi-face extrude sweeps every picked face the other way', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      const store = twoBoxes(scope, table)
      const ia = topFaceIndex(scope, table.get<OccShape>(store.body_a.shape!))
      const ib = topFaceIndex(scope, table.get<OccShape>(store.body_b.shape!))
      const result = solve(scope, table, store, {
        sketch: [`@body_a/face/${ia}`, `@body_b/face/${ib}`],
        distance: 5, direction: 'reverse', operation: 'new',
      })
      expect(result.status).toBe('ok')
      const { volume, count } = mintedVolume(scope, table, store)
      expect(count).toBe(2)
      expect(volume).toBeCloseTo(1000, 2)
    } finally {
      scope.dispose()
    }
  })
})
