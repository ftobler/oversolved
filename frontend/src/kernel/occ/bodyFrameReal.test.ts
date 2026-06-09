// @vitest-environment node
//
// "Tessellation for eyes only" -- the edge-sampled body AABB.
//
// The cls_* classifier frame must be derivable from the B-rep alone, never from
// the render mesh. These tests pin the mechanism: `bodyFrame` (vertices + edge
// samples) reproduces the mesh AABB on a cylinder where a vertex-only box would
// collapse, and faces + edges classify against that one shared frame. Skips when
// opencascade.js is absent (npm run occ:install).

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { HandleTable } from './handleTable'
import { DisposeScope } from './disposeScope'
import { buildCylinder } from './shapes'
import { solidToMesh, solidToEdges, bodyFrame } from './tessellation'
import { readSolidVertices, type Vec3 } from './primitives'
import type { OccModule } from './occTypes'

const oc = await loadOcc()

function aabbHalf(points: Vec3[] | number[][]): Vec3 {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
  }
  return [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]
}

function clsTokens(queries: string[]): Set<string> {
  const out = new Set<string>()
  for (const q of queries) {
    for (const m of q.match(/cls_[a-z0-9_]+/g) ?? []) out.add(m)
  }
  return out
}

describe.skipIf(!oc)('bodyFrame: mesh-free classifier AABB', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable')
    occ = oc
  })

  // spec 5: the edge-sampled box matches the mesh box on the common curved body
  // (a cylinder), where a vertex-only box collapses -- proving the edge samples,
  // not the vertices, carry the radial extent.
  it('matches the mesh AABB on a cylinder where a vertex-only box collapses', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildCylinder(occ, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 3, height: 10 })
    const solid = table.get(h)
    const scope = new DisposeScope()
    try {
      const mesh = solidToMesh(occ, table, h)
      const meshHalf = aabbHalf(mesh.vertices)
      const vertexHalf = aabbHalf(readSolidVertices(occ, scope, solid))
      const frame = bodyFrame(occ, scope, solid)

      // Edge-sampled box recovers the radius (exact, vs the slightly-under mesh
      // chord) and the full height.
      expect(frame.half[0]).toBeCloseTo(3, 1)
      expect(frame.half[1]).toBeCloseTo(3, 1)
      expect(frame.half[2]).toBeCloseTo(5, 5)
      expect(frame.half[0]).toBeCloseTo(meshHalf[0], 1)
      expect(frame.half[1]).toBeCloseTo(meshHalf[1], 1)

      // A vertex-only box has no radial extent: the cylinder's only B-rep
      // vertices are the seam endpoints, so x/y collapse to ~0.
      expect(vertexHalf[0]).toBeLessThan(0.5)
      expect(vertexHalf[1]).toBeLessThan(0.5)
    } finally {
      scope.dispose()
      table.release(h)
      table.assertNoLeaks()
    }
  })

  // spec 6: faces and edges classify against the SAME frame. The cap faces and
  // the circular cap edges of a cylinder must agree on the z-classifier.
  it('classifies cap faces and cap edges against one shared frame', () => {
    const table = new HandleTable({ finalizerGuard: false })
    const h = buildCylinder(occ, table, { center: [0, 0, 0], axis: [0, 0, 1], radius: 3, height: 10 })
    try {
      const mesh = solidToMesh(occ, table, h, { createdBy: 'ex1', bodyId: 'body_ex1' })
      const edgeResult = solidToEdges(occ, table, h, { createdBy: 'ex1', bodyId: 'body_ex1' })

      const faceCls = new Set(mesh.face_data.flatMap((fd) => fd.classifiers ?? []))
      const edgeCls = clsTokens(edgeResult.edge_queries)

      // Both caps classify on z; faces and edges land on the same tokens.
      expect(faceCls.has('cls_zp')).toBe(true)
      expect(faceCls.has('cls_zn')).toBe(true)
      expect(edgeCls.has('cls_zp')).toBe(true)
      expect(edgeCls.has('cls_zn')).toBe(true)
    } finally {
      table.release(h)
      table.assertNoLeaks()
    }
  })
})
