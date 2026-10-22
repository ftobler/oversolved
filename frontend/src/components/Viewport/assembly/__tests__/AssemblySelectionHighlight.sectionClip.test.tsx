// The assembly highlight overlays are drawn on top with depthTest off, so an
// unclipped one would paint a selected or hovered half over the cut and the two
// editors would disagree about what the section removed.
import { describe, it, expect, afterEach } from 'vitest'
import { act, render } from '@testing-library/react'
import AssemblySelectionHighlight from '@/components/Viewport/assembly/AssemblySelectionHighlight'
import type { AssemblyPickBody } from '@/utils/assemblyPick'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

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

afterEach(() => {
  act(() => useSectionStore.setState({ ...DEFAULT_SECTION_STATE }))
})

describe('AssemblySelectionHighlight section clipping', () => {
  it('clips every highlight material while a section is on', () => {
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, resolved: true })
    const { container } = render(
      <AssemblySelectionHighlight
        pickBodies={[body()]}
        selection={new Set(['f0', 'e0', 'v0'])}
        hovered="e0"
      />,
    )
    const materials = [
      ...container.querySelectorAll('meshbasicmaterial'),
      ...container.querySelectorAll('linebasicmaterial'),
      ...container.querySelectorAll('pointsMaterial, pointsmaterial'),
    ]
    expect(materials.length).toBeGreaterThan(0)
    for (const material of materials) {
      expect(material.hasAttribute('clippingplanes')).toBe(true)
    }
  })

  it('leaves the overlays unclipped when the section is off', () => {
    const { container } = render(
      <AssemblySelectionHighlight pickBodies={[body()]} selection={new Set(['e0'])} hovered={null} />,
    )
    const material = container.querySelector('linebasicmaterial')
    expect(material?.hasAttribute('clippingplanes')).toBe(false)
  })
})
