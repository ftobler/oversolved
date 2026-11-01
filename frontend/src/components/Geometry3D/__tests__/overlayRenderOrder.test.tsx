import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'

import type { Mesh3D, EdgeData } from '@/types/cad'
import { COLOR_HOVER, COLOR_SELECTED, RENDER_ORDER_HIGHLIGHT, overlayLineMaterialProps } from '@/components/Geometry3D/constants'
import { HighlightOverlays } from '@/components/Geometry3D/highlightOverlay'
import { useEditorState } from '@/hooks/useEditorState'

/**
 * Hover and selection overlays are one drawing recipe. They used to be two: the
 * selection drew last (renderOrder 999) with a transparent material, the hover
 * drew at order 0 with an opaque one, so the section cap and any transparent
 * body painted over a hovered edge or face while the selected one beside it
 * stayed visible. These assertions pin the shared layer and blending.
 */

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
const EDGE_QUERY = '@ex1/edge/0'

function resetStore(overrides: Record<string, unknown> = {}) {
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    ...overrides,
  } as never)
}

// The overlay lineSegments whose material carries `color`. The plain body
// wireframe also draws with a lineBasicMaterial but has no colour attribute in
// the DOM (it is built in code), so the colour is what isolates the overlays.
function overlayFor(container: HTMLElement, color: string) {
  const material = [...container.querySelectorAll('linebasicmaterial')]
    .find(el => el.getAttribute('color') === color) as HTMLElement | undefined
  expect(material, `no overlay painted ${color}`).toBeDefined()
  return { material: material!, segments: material!.parentElement as HTMLElement }
}

async function renderBody() {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(
    <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} edges={edges} edgeQueries={[EDGE_QUERY]} />,
  )
}

beforeEach(() => {
  resetStore()
})

describe('overlay material recipe', () => {
  it('returns the same recipe for both colours', () => {
    const hover = overlayLineMaterialProps(COLOR_HOVER)
    const selected = overlayLineMaterialProps(COLOR_SELECTED)
    expect({ ...hover, color: 'shared' }).toEqual({ ...selected, color: 'shared' })
    expect(hover.transparent).toBe(true)
    expect(hover.depthTest).toBe(false)
  })

  it('paints the hover and the selection colour through the one component', () => {
    // One call, both flag arrays: the selected primitive takes the selection
    // colour and the hovered one the hover colour, at the shared layer. This is
    // the component-level half of "the colours differ, nothing else does".
    const geometry = new THREE.BufferGeometry()
    const geos = { get: () => geometry, dispose: () => {}, size: () => 2 }
    const { container } = render(
      <HighlightOverlays
        geos={geos}
        selected={[true, false]}
        hovered={[false, true]}
        selectedColor={COLOR_SELECTED}
        hoveredColor={COLOR_HOVER}
        clippingPlanes={null}
        active
      />,
    )

    const colours = [...container.querySelectorAll('linebasicmaterial')]
      .map(el => el.getAttribute('color'))
    expect(colours).toEqual([COLOR_SELECTED, COLOR_HOVER])
    for (const material of container.querySelectorAll('linebasicmaterial')) {
      expect((material.parentElement as HTMLElement).getAttribute('renderorder'))
        .toBe(String(RENDER_ORDER_HIGHLIGHT))
    }
  })
})

describe('Body3D overlays share render order and blending', () => {
  // react-dom drops the `transparent` boolean for these host elements, so the
  // blending half of the recipe is asserted on overlayLineMaterialProps above;
  // what is pinned here is that BOTH states reach the shared component, and
  // that the component puts them at the shared order. Only the first render
  // needs the longer budget: it pays Body3D's whole geometry import graph in
  // jsdom, while the later renders reuse the loaded modules.
  const FIRST_MOUNT_TIMEOUT = 15_000

  it('a hovered edge draws at the highlight order', async () => {
    resetStore({ hoveredSelectionId: EDGE_QUERY })
    const { container } = await renderBody()

    const { segments } = overlayFor(container, COLOR_HOVER)
    expect(segments.getAttribute('renderorder')).toBe(String(RENDER_ORDER_HIGHLIGHT))
  }, FIRST_MOUNT_TIMEOUT)

  it('a selected edge draws at the same order', async () => {
    resetStore({ normalSelection: new Set([EDGE_QUERY]) })
    const { container } = await renderBody()

    const { segments } = overlayFor(container, COLOR_SELECTED)
    expect(segments.getAttribute('renderorder')).toBe(String(RENDER_ORDER_HIGHLIGHT))
  })

  it('a hovered face outline carries the same layer as the edge overlays', async () => {
    resetStore({ hoveredSelectionId: 'f0' })
    const { container } = await renderBody()

    const { segments } = overlayFor(container, COLOR_HOVER)
    expect(segments.getAttribute('renderorder')).toBe(String(RENDER_ORDER_HIGHLIGHT))
  })

  it('a selected face outline carries the same layer as the edge overlays', async () => {
    resetStore({ normalSelection: new Set(['f0']) })
    const { container } = await renderBody()

    const { segments } = overlayFor(container, COLOR_SELECTED)
    expect(segments.getAttribute('renderorder')).toBe(String(RENDER_ORDER_HIGHLIGHT))
  })

  it('a face that is both selected and hovered draws the selection colour only', async () => {
    resetStore({ normalSelection: new Set(['f0']), hoveredSelectionId: 'f0' })
    const { container } = await renderBody()

    overlayFor(container, COLOR_SELECTED)
    const hoverCount = [...container.querySelectorAll('linebasicmaterial')]
      .filter(el => el.getAttribute('color') === COLOR_HOVER).length
    expect(hoverCount).toBe(0)
  })
})
