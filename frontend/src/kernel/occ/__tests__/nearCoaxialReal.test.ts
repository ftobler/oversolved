// @vitest-environment node
//
// The boolean clean's coaxial-wall guard: a shape carries a cylinder coaxial
// with a helix axis when the two axes are one line (parallel and a document
// grid step apart at most). That is the geometry whose face merge spins, so a
// false positive only costs a seam and a false negative costs the whole solve;
// both sides of the band are pinned here. Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeCylinder } from '../primitives'
import { shapeHasCoaxialCylinder } from '../nearCoaxial'

const oc = await loadOcc()

describe.skipIf(!oc)('shapeHasCoaxialCylinder (real OCC)', () => {
  it('answers true for the same axis, either direction', () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const scope = new DisposeScope()
    try {
      const cylinder = scope.track(makeCylinder(oc, scope, [0, 0, 0], [0, 0, 1], 4, 6))
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [0, 0, 2], axis: [0, 0, 1] })).toBe(true)
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [0, 0, 2], axis: [0, 0, -1] })).toBe(true)
      // A point on the same line, a pitch away, is still the same line.
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [0, 0, 5], axis: [0, 0, 1] })).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('answers false for a parallel axis off the line, a crossing axis, and a box', () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const scope = new DisposeScope()
    try {
      const cylinder = scope.track(makeCylinder(oc, scope, [0, 0, 0], [0, 0, 1], 4, 6))
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [0.001, 0, 0], axis: [0, 0, 1] })).toBe(false)
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [0, 0, 0], axis: [1, 0, 0] })).toBe(false)
      const box = scope.track(makeBox(oc, scope, 2, 2, 2))
      expect(shapeHasCoaxialCylinder(oc, scope, box, { origin: [0, 0, 0], axis: [0, 0, 1] })).toBe(false)
    } finally {
      scope.dispose()
    }
  })

  it('reads one document grid step as coaxial and a visible offset as not', () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const scope = new DisposeScope()
    try {
      const cylinder = scope.track(makeCylinder(oc, scope, [0, 0, 0], [0, 0, 1], 4, 6))
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [5e-7, 0, 0], axis: [0, 0, 1] })).toBe(true)
      expect(shapeHasCoaxialCylinder(oc, scope, cylinder, { origin: [1e-3, 0, 0], axis: [0, 0, 1] })).toBe(false)
    } finally {
      scope.dispose()
    }
  })
})
