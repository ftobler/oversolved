// Zebra stripes are only meaningful when the tessellation carries smooth
// per-vertex normals: a flat normal per triangle would make every stripe jump
// at every triangle edge and the analysis would report G0 breaks everywhere.
// The worker sends shared vertices per curved face, so `computeVertexNormals`
// averages the surrounding triangles into the radial normal the shader needs.
import { describe, it, expect } from 'vitest'
import type { Mesh3D } from '@/types/cad'
import { buildBodySurfaceGeometry } from '@/components/Geometry3D/bodyGeometry'

/** An open cylinder around +Z with shared ring vertices, wound outward. */
function cylinder(radius: number, height: number, segments: number): Mesh3D {
  const vertices: [number, number, number][] = []
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      vertices.push([radius * Math.cos(angle), radius * Math.sin(angle), ring * height])
    }
  }
  const faces: [number, number, number][] = []
  for (let i = 0; i < segments; i++) {
    const b0 = i
    const b1 = (i + 1) % segments
    const t0 = segments + i
    const t1 = segments + ((i + 1) % segments)
    faces.push([b0, b1, t1], [b0, t1, t0])
  }
  return { vertices, faces }
}

function normalsOf(mesh: Mesh3D): Float32Array {
  const geometry = buildBodySurfaceGeometry(mesh)
  return geometry.getAttribute('normal').array as Float32Array
}

describe('smooth body normals', () => {
  it('varies the normal across a cylinder side instead of per triangle', () => {
    const segments = 16
    const radius = 2
    const normals = normalsOf(cylinder(radius, 3, segments))

    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const nx = normals[i * 3]
      const ny = normals[i * 3 + 1]
      const nz = normals[i * 3 + 2]
      // Radial, not the flat chord of the two triangles meeting at the ring.
      // The average is area-weighted over an uneven quad split, so it leans a
      // few degrees off the exact radius; the direction is what matters.
      const radial = nx * Math.cos(angle) + ny * Math.sin(angle)
      expect(radial).toBeGreaterThan(0.995)
      expect(Math.abs(nz)).toBeLessThan(1e-5)
    }

    // The neighbouring ring vertices really do carry different normals; a
    // per-face normal would repeat the same value around the side.
    expect(normals[0]).not.toBeCloseTo(normals[3], 2)
  })

  it('keeps the normals on the top ring too, not only the bottom one', () => {
    const segments = 12
    const normals = normalsOf(cylinder(1, 2, segments))
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2
      const nx = normals[(segments + i) * 3]
      const ny = normals[(segments + i) * 3 + 1]
      expect(nx * Math.cos(angle) + ny * Math.sin(angle)).toBeGreaterThan(0.99)
    }
  })
})
