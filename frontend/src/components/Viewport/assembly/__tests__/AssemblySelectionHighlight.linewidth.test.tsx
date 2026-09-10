// Regression: assembly-mode edge highlight overlays had no linewidth prop, so
// they fell back to the three.js/browser default of 1px while the part editor
// drew the same highlight at 3px. This locks both overlays to the shared
// EDGE_HIGHLIGHT_LINE_WIDTH constant so the two editors read the same.
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import AssemblySelectionHighlight from '@/components/Viewport/assembly/AssemblySelectionHighlight'
import { EDGE_HIGHLIGHT_LINE_WIDTH } from '@/components/Geometry3D/constants'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

function body(): AssemblyPickBody {
  return {
    handle: 'B',
    bodyKey: 'B',
    faces: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['f0'],
    },
    edges: {
      segmentPositions: new Float32Array([0, 0, 0, 1, 1, 1]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e0'],
    },
    vertices: { vertices: [[9, 9, 9]], vertexQueries: ['v0'] },
    faceBoundaries: null,
  }
}

describe('AssemblySelectionHighlight edge overlay linewidth', () => {
  it('applies EDGE_HIGHLIGHT_LINE_WIDTH to the selected edge overlay', () => {
    const { container } = render(
      <AssemblySelectionHighlight pickBodies={[body()]} selection={new Set(['e0'])} hovered={null} />
    )
    const mat = container.querySelector('linebasicmaterial')
    expect(mat?.getAttribute('linewidth')).toBe(String(EDGE_HIGHLIGHT_LINE_WIDTH))
  })

  it('applies EDGE_HIGHLIGHT_LINE_WIDTH to the hovered edge overlay', () => {
    const { container } = render(
      <AssemblySelectionHighlight pickBodies={[body()]} selection={new Set()} hovered="e0" />
    )
    const mat = container.querySelector('linebasicmaterial')
    expect(mat?.getAttribute('linewidth')).toBe(String(EDGE_HIGHLIGHT_LINE_WIDTH))
  })
})
