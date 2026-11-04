// @vitest-environment node
//
// The touch warning asks two different questions, and it needs both probes.
// `shapesIntersect` (a bare Common) sees a body the new solid overlaps or fully
// encloses; `shapesTouch` (a boundary distance) sees a body it only shares a
// face with, which the Common reads as no solid at all. This pins the split on
// real OCC, beside `bodyOpsProbeFallback.test.ts`, which pins the Common's own
// three failure outcomes. Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { shapesIntersect, shapesTouch } from '../../occ/booleans'
import { makeBoxAt } from '../../occ/primitives'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

function probes(occ: OccModule, a: OccShape, b: OccShape) {
  return {
    intersect: shapesIntersect(occ, a, b),
    touch: shapesTouch(occ, a, b),
  }
}

describe.skipIf(!oc)('shapesTouch vs shapesIntersect (real OCC)', () => {
  it('calls a shared face a touch and not an intersection', () => {
    const scope = new DisposeScope()
    try {
      const a = scope.track(makeBoxAt(oc!, scope, [0, 0, 0], 2, 2, 2))
      const b = scope.track(makeBoxAt(oc!, scope, [2, 0, 0], 2, 2, 2))
      expect(probes(oc!, a, b)).toEqual({ intersect: false, touch: true })
    } finally {
      scope.dispose()
    }
  })

  it('calls a volume overlap both', () => {
    const scope = new DisposeScope()
    try {
      const a = scope.track(makeBoxAt(oc!, scope, [0, 0, 0], 2, 2, 2))
      const b = scope.track(makeBoxAt(oc!, scope, [1, 0, 0], 2, 2, 2))
      expect(probes(oc!, a, b)).toEqual({ intersect: true, touch: true })
    } finally {
      scope.dispose()
    }
  })

  it('calls a gap neither', () => {
    const scope = new DisposeScope()
    try {
      const a = scope.track(makeBoxAt(oc!, scope, [0, 0, 0], 2, 2, 2))
      const b = scope.track(makeBoxAt(oc!, scope, [3, 0, 0], 2, 2, 2))
      expect(probes(oc!, a, b)).toEqual({ intersect: false, touch: false })
    } finally {
      scope.dispose()
    }
  })

  it('reports a nested body as both an intersection and a touch', () => {
    // Not a gap in the distance probe: this build answers Value() == 0 with
    // InnerSolution() == true when one solid encloses the other, so the nested
    // body reads as a touch as well as a solid Common. Pinned because the
    // warning's rationale says a face contact is the distance probe's job; it
    // must not also lose the enclosed case if the probe changes.
    const scope = new DisposeScope()
    try {
      const big = scope.track(makeBoxAt(oc!, scope, [0, 0, 0], 6, 6, 6))
      const small = scope.track(makeBoxAt(oc!, scope, [2, 2, 2], 1, 1, 1))
      expect(probes(oc!, big, small)).toEqual({ intersect: true, touch: true })
    } finally {
      scope.dispose()
    }
  })
})
