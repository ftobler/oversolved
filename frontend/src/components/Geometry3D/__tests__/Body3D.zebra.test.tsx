// The zebra row is a viewer preference, so the body reads it from the store
// instead of taking another prop. What this render can observe is the material
// tag and the fact that toggling never grows the material count: the patch is
// installed on the one declarative material, so no per-toggle instance leaks.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { Mesh3D } from '@/types/cad'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
  face_queries: ['f0'],
  triangle_to_face: [0],
}

const defaults = {
  shading: true,
  edges: true,
  zebra: false,
  curvature: false,
  zebra_stripes: 12,
  curvature_kind: 'mean' as const,
  curvature_range: null,
}

beforeEach(() => {
  useViewOptionsStore.setState({ ...defaults })
})

async function renderBody(props: Record<string, unknown> = {}) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} {...props} />)
}

function materialName(container: HTMLElement): string | null {
  const material = container.querySelector('meshphysicalmaterial')
  return material ? (material.getAttribute('name') ?? (material as unknown as { name: string }).name ?? null) : null
}

describe('Body3D zebra', () => {
  it('uses the plain body material while zebra is off', async () => {
    const { container } = await renderBody()
    expect(materialName(container)).toBe('body-material')
  })

  it('tags the material as the zebra program while zebra is on', async () => {
    useViewOptionsStore.setState({ zebra: true })
    const { container } = await renderBody()
    expect(materialName(container)).toBe('zebra-material')
  })

  it('does not accumulate material instances across toggles', async () => {
    useViewOptionsStore.setState({ zebra: true })
    const on = await renderBody()
    expect(on.container.querySelectorAll('meshphysicalmaterial')).toHaveLength(1)
    on.unmount()

    useViewOptionsStore.setState({ zebra: false })
    const off = await renderBody()
    expect(off.container.querySelectorAll('meshphysicalmaterial')).toHaveLength(1)
    expect(materialName(off.container)).toBe('body-material')
  })

  it('draws no zebra material while shading is off', async () => {
    useViewOptionsStore.setState({ zebra: true })
    const { container } = await renderBody({ showFaces: false })
    expect(container.querySelector('meshphysicalmaterial')).toBeNull()
  })
})
