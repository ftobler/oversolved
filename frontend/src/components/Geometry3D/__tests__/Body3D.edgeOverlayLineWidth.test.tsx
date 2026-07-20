// Regression guard for the edge highlight overlay linewidth. Both the hover
// and selected overlays must render at EDGE_HIGHLIGHT_LINE_WIDTH so Part
// Editor and Assembly mode read the same (see AssemblySelectionHighlight's
// matching test).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { EDGE_HIGHLIGHT_LINE_WIDTH } from '@/components/Geometry3D/constants'
import type { Mesh3D, EdgeData } from '@/types/cad'

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
const edges: EdgeData[] = [{ kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }]

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
})

describe('Body3D edge overlay linewidth', () => {
  it('renders the selected edge overlay at EDGE_HIGHLIGHT_LINE_WIDTH', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['@ex1/edge/0']) } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    const { container } = render(
      <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} edges={edges} edgeQueries={['@ex1/edge/0']} />
    )
    const mat = container.querySelector('linebasicmaterial')
    expect(mat?.getAttribute('linewidth')).toBe(String(EDGE_HIGHLIGHT_LINE_WIDTH))
  })

  it('renders the hovered edge overlay at EDGE_HIGHLIGHT_LINE_WIDTH', async () => {
    useSketchEditorStore.setState({ hoveredSelectionId: '@ex1/edge/0' } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    const { container } = render(
      <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} edges={edges} edgeQueries={['@ex1/edge/0']} />
    )
    const mat = container.querySelector('linebasicmaterial')
    expect(mat?.getAttribute('linewidth')).toBe(String(EDGE_HIGHLIGHT_LINE_WIDTH))
  })
})
