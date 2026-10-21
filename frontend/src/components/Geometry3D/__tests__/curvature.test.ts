// Known-shape calibration for the discrete curvature fallback. The kernel's
// BRepLProp binding is absent from the pinned OCCT build, so these fixtures are
// how the mesh estimator earns its place: each has an analytic answer.
import { describe, it, expect } from 'vitest'
import {
  autoRange,
  autoRangeFromMeshes,
  computeCurvature,
  effectiveCurvatureRange,
  type CurvatureField,
} from '@/components/Geometry3D/curvature'
import { icosphere, openCylinder, plane, torus } from '@/testing/curvatureFixtures'
import type { Mesh3D } from '@/types/cad'

function fieldOf(surface: { positions: Float32Array; indices: Uint32Array }): CurvatureField {
  return computeCurvature(surface.positions, surface.indices)
}

function average(values: Float32Array): number {
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function asMesh(surface: { positions: Float32Array; indices: Uint32Array }): Mesh3D {
  return { vertices: surface.positions, faces: surface.indices }
}

describe('discrete curvature', () => {
  it('gives a sphere mean curvature 1/r at every vertex', () => {
    const surface = icosphere(2, 3)
    const field = fieldOf(surface)
    for (const value of field.mean) expect(value).toBeCloseTo(0.5, 2)
    // The Gauss-Bonnet total still lands on 4 pi K for the sphere's area.
    const gaussian = average(field.gaussian)
    expect(gaussian).toBeCloseTo(1 / 4, 2)
  })

  it('gives a plane zero mean and zero Gaussian curvature inside it', () => {
    const segments = 8
    const field = fieldOf(plane(4, segments))
    for (const value of field.mean) expect(Math.abs(value)).toBeLessThan(1e-6)
    // The perimeter is a polygonal boundary, not a smooth one: its corners carry
    // the Gauss-Bonnet geodesic-curvature defect by design. Only interior
    // vertices describe the surface.
    const row = segments + 1
    for (let y = 1; y < segments; y++) {
      for (let x = 1; x < segments; x++) {
        expect(Math.abs(field.gaussian[y * row + x])).toBeLessThan(1e-3)
      }
    }
  })

  it('gives a cylinder 1/(2r) mean and zero Gaussian on its interior ring', () => {
    const radius = 2
    const radial = 64
    const surface = openCylinder(radius, 2, radial, 2)
    const field = fieldOf(surface)
    // Ring 1 is the interior one: sample every vertex there.
    for (let i = 0; i < radial; i++) {
      const vertex = radial + i
      expect(field.mean[vertex]).toBeCloseTo(1 / (2 * radius), 2)
      expect(Math.abs(field.gaussian[vertex])).toBeLessThan(1e-3)
    }
  })

  it('changes the sign of mean curvature between the torus sides', () => {
    // A fat torus: the inner side is a saddle with a negative mean curvature,
    // not merely a smaller positive one (that needs minor > major / 2).
    const major = 2.5
    const minor = 1.5
    const majorSegments = 64
    const minorSegments = 32
    const surface = torus(major, minor, majorSegments, minorSegments)
    const field = fieldOf(surface)

    let outer: number | null = null
    let inner: number | null = null
    for (let i = 0; i < surface.positions.length / 3; i++) {
      const x = surface.positions[i * 3]
      const y = surface.positions[i * 3 + 1]
      const radial = Math.hypot(x, y)
      if (Math.abs(radial - (major + minor)) < 1e-4) outer = field.mean[i]
      if (Math.abs(radial - (major - minor)) < 1e-4) inner = field.mean[i]
    }
    expect(outer).not.toBeNull()
    expect(inner).not.toBeNull()
    expect(outer!).toBeGreaterThan(0)
    expect(inner!).toBeLessThan(0)
  })

  it('also flips Gaussian curvature between the torus sides', () => {
    const major = 3
    const minor = 1
    const majorSegments = 64
    const minorSegments = 32
    const surface = torus(major, minor, majorSegments, minorSegments)
    const field = fieldOf(surface)

    let outer: number | null = null
    let inner: number | null = null
    for (let i = 0; i < surface.positions.length / 3; i++) {
      const radial = Math.hypot(surface.positions[i * 3], surface.positions[i * 3 + 1])
      if (Math.abs(radial - (major + minor)) < 1e-4) outer = field.gaussian[i]
      if (Math.abs(radial - (major - minor)) < 1e-4) inner = field.gaussian[i]
    }
    expect(outer).not.toBeNull()
    expect(inner).not.toBeNull()
    expect(outer!).toBeGreaterThan(0)
    expect(inner!).toBeLessThan(0)
  })

  it('caches the field per mesh', async () => {
    const { curvatureForMesh } = await import('@/components/Geometry3D/curvature')
    const mesh = asMesh(icosphere(1, 2))
    expect(curvatureForMesh(mesh)).toBe(curvatureForMesh(mesh))
  })
})

describe('curvature auto range', () => {
  it('clamps a single outlier instead of stretching the ramp', () => {
    const samples = new Float32Array(101)
    for (let i = 0; i < 100; i++) samples[i] = i / 100
    samples[100] = 1000
    const range = autoRange(samples)
    expect(range).not.toBeNull()
    expect(range![1]).toBeLessThan(1.01)
    // Symmetric, so a flat face stays at the neutral middle.
    expect(range![0]).toBeCloseTo(-range![1], 10)
  })

  it('falls back to a neutral range for a flat scene', () => {
    expect(autoRange(new Float32Array([0, 0, 0]))).toEqual([0, 0])
    expect(effectiveCurvatureRange(null, [0, 0])).toEqual([-1, 1])
  })

  it('prefers a manual range over the derived one', () => {
    expect(effectiveCurvatureRange([0.2, 0.4], [-3, 3])).toEqual([0.2, 0.4])
    expect(effectiveCurvatureRange(null, [-3, 3])).toEqual([-3, 3])
  })

  it('spans every visible mesh, not just the first', () => {
    const sphereMesh = asMesh(icosphere(2, 2))
    const planeMesh = asMesh(plane(4, 4))
    const range = autoRangeFromMeshes([sphereMesh, planeMesh], 'mean')
    expect(range).not.toBeNull()
    expect(range![1]).toBeGreaterThan(0.45)
    expect(range![1]).toBeLessThan(0.55)
    expect(range![0]).toBeCloseTo(-range![1], 10)
  })

  it('samples a huge mesh down to a bounded count', () => {
    const mesh = asMesh(icosphere(2, 3))
    expect(autoRangeFromMeshes([mesh], 'gaussian', 10)).not.toBeNull()
  })
})
