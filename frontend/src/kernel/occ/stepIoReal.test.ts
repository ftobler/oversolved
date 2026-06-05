// @vitest-environment node
//
// Phase 3 gated test: STEP export (shape -> bytes) via STEPControl_Writer,
// round-tripped back through stepBytesToShape and verified by volume parity.
// opencascade.js must run under node (its emscripten FS path for STEP differs
// from the browser Worker's --target web FS).
//
// Skips when opencascade.js is absent. Install:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import type { OccModule } from './occTypes'
import { makeBox } from './primitives'
import { stepShapeToBytes, stepBytesToShape } from './stepIo'
import { volumeOf } from './booleans'

const oc = await loadOcc()

describe.skipIf(!oc)('stepShapeToBytes (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('serialises a box to valid STEP bytes', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 5, 5, 5))
      const bytes = stepShapeToBytes(occ, scope, box)
      const text = new TextDecoder().decode(bytes)
      expect(text).toContain('ISO-10303-21')
      expect(text).toContain('MANIFOLD_SOLID_BREP')
      expect(text).toContain('END-ISO-10303-21')
    } finally {
      scope.dispose()
    }
  })

  it('round-trips a box through STEP export -> import with volume parity', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 3, 4, 5))
      const originalVolume = volumeOf(occ, scope, box)

      const bytes = stepShapeToBytes(occ, scope, box)
      const reimported = scope.track(stepBytesToShape(occ, scope, bytes))
      const roundTripVolume = volumeOf(occ, scope, reimported)

      expect(originalVolume).toBeCloseTo(60, 1) // 3*4*5
      expect(roundTripVolume).toBeCloseTo(originalVolume, 1)
    } finally {
      scope.dispose()
    }
  })

  it('round-trips a box at non-uniform scale', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const bytes = stepShapeToBytes(occ, scope, box)
      const reimported = scope.track(stepBytesToShape(occ, scope, bytes, 2.0))
      const vol = volumeOf(occ, scope, reimported)
      expect(vol).toBeCloseTo(8000, 1) // 20*20*20
    } finally {
      scope.dispose()
    }
  })
})
