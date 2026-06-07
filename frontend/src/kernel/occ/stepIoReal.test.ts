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
import { stepShapeToBytes, stepBytesToShape, shapeToStlBytes } from './stepIo'
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

// ─── STL export (ported from test_geometry_shape_to_stl.py) ───

describe.skipIf(!oc)('shapeToStlBytes (real OCC)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('serialises a box to non-empty STL bytes', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const bytes = shapeToStlBytes(occ, scope, box)
      expect(bytes.length).toBeGreaterThan(0)
      // Binary STL has an 80-byte header + 4-byte triangle count.
      expect(bytes.length).toBeGreaterThan(84)
    } finally {
      scope.dispose()
    }
  })

  it('STL bytes encode a valid triangle count', () => {
    /** Binary STL: bytes 80-83 (little-endian uint32) carry the triangle count.
     *  A 10x10x10 box should have at least 12 triangles (2 per face × 6 faces). */
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const bytes = shapeToStlBytes(occ, scope, box)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const triCount = view.getUint32(80, true)
      expect(triCount).toBeGreaterThanOrEqual(12)
    } finally {
      scope.dispose()
    }
  })

  it('tessellation deflection affects triangle count', () => {
    /** A finer deflection (smaller value) produces more triangles. */
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const coarse = shapeToStlBytes(occ, scope, box, 1.0)
      const fine = shapeToStlBytes(occ, scope, box, 0.01)
      const coarseTri = new DataView(coarse.buffer, coarse.byteOffset, coarse.byteLength).getUint32(80, true)
      const fineTri = new DataView(fine.buffer, fine.byteOffset, fine.byteLength).getUint32(80, true)
      expect(fineTri).toBeGreaterThanOrEqual(coarseTri)
    } finally {
      scope.dispose()
    }
  })
})
