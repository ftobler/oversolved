// The AO pre-pass only sees a body whose face mesh carries the occluder layer.
// That mesh is unmounted by the Shading row, so the bit is applied by the
// mesh's own ref at attach: an effect keyed on transparency alone lost it after
// shading off and on, and the pre-pass then drew nothing for that body.
//
// A DOM render never builds a THREE.Mesh, so the wiring is observed where it
// crosses into the layer module: which bodies ask for the bit and with what
// opacity answer.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { occluderCalls } = vi.hoisted(() => ({
  occluderCalls: [] as { opaque: boolean }[],
}))

vi.mock('@/components/Viewport/ambientOcclusion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Viewport/ambientOcclusion')>()
  return {
    ...actual,
    applyAoOccluder: (layers: unknown, opaque: boolean) => {
      occluderCalls.push({ opaque })
      actual.applyAoOccluder(layers as Parameters<typeof actual.applyAoOccluder>[0], opaque)
    },
  }
})

const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
  face_queries: ['f0'],
  triangle_to_face: [0],
}

beforeEach(() => {
  occluderCalls.length = 0
})

// Imported at module scope: Body3D pulls the whole geometry tree, and paying
// that transform inside a test counts it against the test timeout.
import Body3D from '@/components/Geometry3D/Body3D'

function renderBody(props: Record<string, unknown> = {}) {
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} {...props} />)
}

describe('Body3D ambient occlusion occluders', () => {
  it('marks the face mesh as an occluder when it attaches', () => {
    renderBody()
    expect(occluderCalls).toHaveLength(1)
    expect(occluderCalls[0].opaque).toBe(true)
  })

  it('re-applies the bit when shading off then on remounts the face mesh', () => {
    const { container, rerender } = renderBody({ showFaces: false })
    expect(container.querySelector('mesh')).toBeNull()
    expect(occluderCalls).toHaveLength(0)

    rerender(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} showFaces />)

    expect(occluderCalls).toHaveLength(1)
    expect(occluderCalls[0].opaque).toBe(true)
  })

  it('keeps a transparent body out of the pre-pass', () => {
    renderBody({ transparency: 0.4 })
    expect(occluderCalls.at(-1)?.opaque).toBe(false)
  })

  it('re-applies the bit when the body turns transparent while mounted', () => {
    const { rerender } = renderBody()
    rerender(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} transparency={0.5} />)
    expect(occluderCalls.at(-1)?.opaque).toBe(false)
  })
})
