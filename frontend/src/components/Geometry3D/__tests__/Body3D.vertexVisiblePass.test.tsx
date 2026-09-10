// The pick pass now draws B-rep vertices as 3x3x3 px cubes (see
// picking/VertexIdLayer). That change is confined to the offscreen ID buffer;
// the beauty pass must keep rendering vertices exactly as before -- an
// invisible POINT_HIT_PIXELS hit sphere plus a POINT_VIS_PIXELS dot that only
// appears on hover or selection.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useFrame } from '@react-three/fiber'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { POINT_HIT_PIXELS, POINT_VIS_PIXELS } from '@/components/Geometry3D/constants'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  // p2w requires a real orthographic camera now; the degenerate `{}` mock used
  // to be read as a zoom-less fallback of 1.
  useThree: () => ({ camera: { isOrthographicCamera: true, zoom: 1 } }),
}))

// A VertexInstancePainter whose sync is a spy shared across instances, so a test
// can assert the per-frame vertex pass never touched it while the body is hidden.
const { syncSpy } = vi.hoisted(() => ({ syncSpy: vi.fn(() => false) }))
vi.mock('@/components/Geometry3D/vertexInstancePainter', () => ({
  VertexInstancePainter: class {
    sync = syncSpy
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
  syncSpy.mockClear()
  vi.mocked(useFrame).mockClear()
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
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

/** The frame callback Body3D registered, invoked with a stub frame state. */
function runFrame() {
  const cb = vi.mocked(useFrame).mock.calls.at(-1)![0]
  act(() => { cb({ camera: { isOrthographicCamera: true, zoom: 1 } } as never, 0) })
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

  it('the per-frame vertex pass does nothing while the body is hidden', async () => {
    await renderBody(false)
    runFrame()
    expect(syncSpy).not.toHaveBeenCalled()
  })

  it('the per-frame vertex pass runs without throwing once the body is visible', async () => {
    await renderBody(true)
    // Refs are null under the @react-three/fiber mock, so the callback still
    // returns early on the null mesh ref -- the point is only that the new
    // `if (!visible) return` guard does not block the visible path.
    expect(() => runFrame()).not.toThrow()
  })

  it('keeps the visible-pass pixel sizes independent of the pick cube size', async () => {
    const { VERTEX_PICK_CUBE_PIXELS } = await import('@/picking')
    expect(POINT_HIT_PIXELS).toBe(20)
    expect(POINT_VIS_PIXELS).toBe(4)
    expect(VERTEX_PICK_CUBE_PIXELS).not.toBe(POINT_HIT_PIXELS)
    expect(VERTEX_PICK_CUBE_PIXELS).not.toBe(POINT_VIS_PIXELS)
  })
})
