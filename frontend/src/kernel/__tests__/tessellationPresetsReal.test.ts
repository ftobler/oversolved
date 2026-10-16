// @vitest-environment node
//
// Real-OCC check that the three presets order as intended on a curved part: a
// cylinder's lateral surface is where angular deflection binds, so fine must
// yield strictly more triangles than normal, and normal more than coarse.
// Skips when opencascade.js is not installed (npm run occ:install).
//
// The exact "normal equals the old export" pin lives in the pure
// tessellationPresets test; there is no need to burn a real mesher on it here.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { makeCylinder } from '../occ/primitives'
import { shapeToStlBytes } from '../occ/stepIo'
import { resolveTessellation, type TessellationPreset } from '../tessellationPresets'
import type { OccModule } from '../occ/occTypes'

const oc = await loadOcc()

function triangleCount(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true)
}

// A fresh shape per call: BRepMesh may keep an already-finer triangulation when
// asked for a coarser one, which would hide the ordering.
function cylinderTriangles(occ: OccModule, preset: TessellationPreset): number {
  const scope = new DisposeScope()
  try {
    const cylinder = scope.track(makeCylinder(occ, scope, [0, 0, 0], [0, 0, 1], 10, 20))
    const { linearDeflection, angularDeflection } = resolveTessellation(preset)
    return triangleCount(shapeToStlBytes(occ, scope, cylinder, linearDeflection, angularDeflection))
  } finally {
    scope.dispose()
  }
}

describe.skipIf(!oc)('tessellation presets on a curved part (real OCC)', () => {
  it('fine meshes more triangles than normal, normal more than coarse', () => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    const fine = cylinderTriangles(oc, 'fine')
    const normal = cylinderTriangles(oc, 'normal')
    const coarse = cylinderTriangles(oc, 'coarse')
    expect(fine).toBeGreaterThan(normal)
    expect(normal).toBeGreaterThan(coarse)
  })
})
