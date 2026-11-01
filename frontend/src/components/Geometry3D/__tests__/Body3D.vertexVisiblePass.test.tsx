// The beauty pass draws B-rep vertices as a single hover/selection dot. The
// opacity-0 hit sphere that used to sit beside it was a raycast-era leftover:
// nothing raycasts scene vertices any more, picking reads the offscreen ID
// buffer (picking/VertexIdLayer), so the sphere only re-synced a matrix per
// vertex per frame for geometry nobody could see or hit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

import { POINT_VIS_PIXELS } from '@/components/Geometry3D/constants'
import type { Mesh3D } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

// The R3F hooks are stubbed: this suite observes the DOM React commits, not a
// live render loop. The per-frame painter is driven through a null ref under
// that stub, so its behaviour is pinned in vertexInstancePainter's own tests
// rather than pretended to here.
vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  // p2w requires a real orthographic camera now; the degenerate `{}` mock used
  // to be read as a zoom-less fallback of 1.
  useThree: () => ({ camera: { isOrthographicCamera: true, zoom: 1 } }),
}))

vi.mock('@/components/Geometry3D/vertexInstancePainter', () => ({
  VertexInstancePainter: class {
    sync() { return false }
    dispose() {}
  },
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
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  })
})

async function renderBody(visible = true) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(
    <Body3D
      featureId="ex1"
      bodyId="body_ex1"
      mesh={mesh}
      vertices={vertices}
      vertexQueries={vertexQueries}
      visible={visible}
    />
  )
}

describe('Body3D visible vertex pass', () => {
  it('draws exactly one instanced vertex mesh: the dot', async () => {
    const { container } = await renderBody()
    expect(container.querySelectorAll('instancedmesh')).toHaveLength(1)
    expect(container.querySelectorAll('spheregeometry')).toHaveLength(1)
  })

  it('the dot is a unit sphere, scaled to screen pixels at runtime', async () => {
    const { container } = await renderBody()
    // Radius 1 is what lets useFrame scale by POINT_VIS_PIXELS.
    expect(container.querySelector('spheregeometry')?.getAttribute('args')).toMatch(/^1,/)
  })

  it('carries no invisible hit mesh left over from the raycast era', async () => {
    const { container } = await renderBody()
    const transparent = [...container.querySelectorAll('meshbasicmaterial')]
      .filter(m => m.getAttribute('opacity') === '0')
    expect(transparent).toEqual([])
  })

  it('the visible dot is hidden until a vertex is hovered or selected', async () => {
    const { container } = await renderBody()
    const dot = container.querySelector('instancedmesh')
    expect(dot?.getAttribute('visible')).not.toBe('true')
  })

  it('clips the visible vertex dot while a section is on', async () => {
    act(() => useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, resolved: true }))
    try {
      const { container } = await renderBody()
      const dot = container.querySelector('meshbasicmaterial[color="white"]')
      expect(dot?.hasAttribute('clippingplanes')).toBe(true)
    } finally {
      act(() => useSectionStore.setState({ ...DEFAULT_SECTION_STATE }))
    }
  })

  it('keeps the dot size independent of the pick cube size', async () => {
    const { VERTEX_PICK_CUBE_PIXELS } = await import('@/picking')
    expect(POINT_VIS_PIXELS).toBe(4)
    expect(VERTEX_PICK_CUBE_PIXELS).not.toBe(POINT_VIS_PIXELS)
  })

  it('no longer exports the point hit pixel constant', async () => {
    const constants = await import('@/components/Geometry3D/constants')
    expect('POINT_HIT_PIXELS' in constants).toBe(false)
  })
})
