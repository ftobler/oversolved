// The pick pass now draws B-rep vertices as 3x3x3 px cubes (see
// picking/VertexIdLayer). That change is confined to the offscreen ID buffer;
// the beauty pass must keep rendering vertices exactly as before -- an
// invisible POINT_HIT_PIXELS hit sphere plus a POINT_VIS_PIXELS dot that only
// appears on hover or selection.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { POINT_HIT_PIXELS, POINT_VIS_PIXELS } from '@/components/Geometry3D/constants'
import type { Mesh3D } from '@/types/cad'

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
const vertices: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
const vertexQueries = ['@ex1/vertex/0', '@ex1/vertex/1', '@ex1/vertex/2']

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
})

async function renderBody() {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(
    <Body3D
      featureId="ex1"
      bodyId="body_ex1"
      mesh={mesh}
      vertices={vertices}
      vertexQueries={vertexQueries}
    />
  )
}

describe('Body3D visible vertex pass (unchanged by the pick-cube refactor)', () => {
  it('still renders the hit sphere and the dot as two instanced meshes', async () => {
    const { container } = await renderBody()
    const instanced = container.querySelectorAll('instancedmesh')
    expect(instanced.length).toBe(2)
  })

  it('both vertex meshes are unit spheres, scaled to screen pixels at runtime', async () => {
    const { container } = await renderBody()
    const geos = [...container.querySelectorAll('spheregeometry')]
    expect(geos.length).toBe(2)
    // Radius 1 is what lets useFrame scale by POINT_HIT_PIXELS / POINT_VIS_PIXELS.
    for (const g of geos) expect(g.getAttribute('args')).toMatch(/^1,/)
  })

  it('the visible dot is hidden until a vertex is hovered or selected', async () => {
    const { container } = await renderBody()
    const dot = container.querySelectorAll('instancedmesh')[1]
    expect(dot.getAttribute('visible')).not.toBe('true')
  })

  it('keeps the visible-pass pixel sizes independent of the pick cube size', async () => {
    const { VERTEX_PICK_CUBE_PIXELS } = await import('@/picking')
    expect(POINT_HIT_PIXELS).toBe(20)
    expect(POINT_VIS_PIXELS).toBe(4)
    expect(VERTEX_PICK_CUBE_PIXELS).not.toBe(POINT_HIT_PIXELS)
    expect(VERTEX_PICK_CUBE_PIXELS).not.toBe(POINT_VIS_PIXELS)
  })
})
