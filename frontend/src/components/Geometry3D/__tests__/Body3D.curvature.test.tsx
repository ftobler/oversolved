// The curvature row is the only thing that may ask for a curvature field. This
// is the "analysis runs on request" half of the plan: a normal render must not
// compute it, and turning the row on must put the attribute on the geometry the
// material samples.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render, act } from '@testing-library/react'
import type { Mesh3D } from '@/types/cad'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import { icosphere } from '@/testing/curvatureFixtures'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { curvatureSpy, surfaces } = vi.hoisted(() => ({
  curvatureSpy: vi.fn(),
  surfaces: [] as THREE.BufferGeometry[],
}))

vi.mock('@/components/Geometry3D/curvature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/curvature')>()
  return {
    ...actual,
    curvatureForMesh: (mesh: Mesh3D) => {
      curvatureSpy(mesh)
      return actual.curvatureForMesh(mesh)
    },
  }
})

vi.mock('@/components/Geometry3D/bodyGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/bodyGeometry')>()
  return {
    ...actual,
    buildBodySurfaceGeometry: (mesh: Mesh3D) => {
      const geometry = actual.buildBodySurfaceGeometry(mesh)
      surfaces.push(geometry)
      return geometry
    },
  }
})

const fixture = icosphere(1, 2)
const mesh: Mesh3D = { vertices: fixture.positions, faces: fixture.indices }

beforeEach(() => {
  curvatureSpy.mockClear()
  surfaces.length = 0
  useViewOptionsStore.setState({ shading: true, edges: true, zebra: false, curvature: false, curvature_range: null, curvatureAutoRange: null })
})

async function renderBody() {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} />)
}

function materialName(container: HTMLElement): string | null {
  const material = container.querySelector('meshphysicalmaterial')
  return material ? (material.getAttribute('name') ?? (material as unknown as { name: string }).name ?? null) : null
}

describe('Body3D curvature', () => {
  it('computes nothing while the row is off', async () => {
    await renderBody()
    expect(curvatureSpy).not.toHaveBeenCalled()
    expect(surfaces[0]?.getAttribute('aCurvature')).toBeUndefined()
  })

  it('adds the vertex attribute and switch the material when the row turns on', async () => {
    const { container } = await renderBody()
    expect(materialName(container)).toBe('body-material')

    await act(async () => {
      useViewOptionsStore.setState({ curvature: true })
    })

    expect(curvatureSpy).toHaveBeenCalledTimes(1)
    expect(materialName(container)).toBe('curvature-material')
    const attribute = surfaces.at(-1)?.getAttribute('aCurvature') as THREE.BufferAttribute | undefined
    expect(attribute).toBeDefined()
    expect(attribute!.itemSize).toBe(2)
    expect(attribute!.count).toBe(mesh.vertices.length / 3)
  })

  it('does not recompute the field for a range or kind change', async () => {
    const { container } = await renderBody()
    await act(async () => { useViewOptionsStore.setState({ curvature: true }) })
    expect(curvatureSpy).toHaveBeenCalledTimes(1)

    await act(async () => {
      useViewOptionsStore.setState({ curvature_kind: 'gaussian', curvature_range: [0.1, 0.2] })
    })
    expect(curvatureSpy).toHaveBeenCalledTimes(1)
    expect(materialName(container)).toBe('curvature-material')
  })
})
