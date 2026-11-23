import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { LineSegment, Sketch, Topology } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { initializeTools } from '@/tools'

/**
 * The scene probe for a sketch with areas. It mounts the same components the
 * viewport composes (the area fill and the entity lines/dots in one tree) and
 * records what each primitive is told to do with its render order and its pass.
 *
 * The user-visible defect: a sketch area's polygon runs along the CENTRE of its
 * boundary lines, so the fill covers the inner half of every idle line's width.
 * The fill and the lines must therefore both be in the sorted transparent pass
 * and the fill must sort below every line layer. Being opaque vs transparent is
 * not a stable order: three draws the whole opaque list before the transparent
 * one, so an opaque line can never escape a transparent fill's 10% white.
 *
 * "One Line2 per entity edge" is part of the probe: a second mount of the same
 * sketch would paint a clean copy over the fill, which is one explanation the
 * report offered for the mode that looked right.
 */

const captured = vi.hoisted(() => ({
  lines: [] as Array<Record<string, unknown>>,
  dashed: [] as Array<Record<string, unknown>>,
  dots: [] as Array<Record<string, unknown>>,
}))

vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { captured.lines.push(props); return null },
}))
vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))
vi.mock('@/components/Geometry3D/dimensions', () => ({
  DashedLine: (props: Record<string, unknown>) => { captured.dashed.push(props); return null },
}))
vi.mock('@/components/Geometry3D/DotMesh', () => ({
  Dot: (props: Record<string, unknown>) => { captured.dots.push(props); return null },
}))

const SQUARE: Sketch = {
  l1: { start: [0, 0], end: [4, 0] },
  l2: { start: [4, 0], end: [4, 4] },
  l3: { start: [4, 4], end: [0, 4] },
  l4: { start: [0, 4], end: [0, 0] },
} as unknown as Sketch

const SQUARE_TOPOLOGY = {
  vertices: {
    v0: { x: 0, y: 0 }, v1: { x: 4, y: 0 }, v2: { x: 4, y: 4 }, v3: { x: 0, y: 4 },
  },
  intersection_points: {},
  edges: [],
  surfaces: [{
    query: '?4;@sk1',
    boundary: [
      { kind: 'line', start: [0, 0], end: [4, 0], start_vertex: 'v0', end_vertex: 'v1' },
      { kind: 'line', start: [4, 0], end: [4, 4], start_vertex: 'v1', end_vertex: 'v2' },
      { kind: 'line', start: [4, 4], end: [0, 4], start_vertex: 'v2', end_vertex: 'v3' },
      { kind: 'line', start: [0, 4], end: [0, 0], start_vertex: 'v3', end_vertex: 'v0' },
    ],
  }],
} as unknown as Topology

// The fill is the only mesh whose parent carries a shapeGeometry, which keeps
// the probe off the vertex-dot meshes.
function fillMeshes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('shapegeometry')]
    .map(g => g.parentElement as HTMLElement)
}

async function mountScene({ isEditing }: { isEditing: boolean }) {
  const [{ TopologySurfaces }, { EntityLines }] = await Promise.all([
    import('@/components/Geometry3D/Surfaces'),
    import('@/components/Geometry3D/EntityLines'),
  ])
  const view = render(
    <>
      <TopologySurfaces
        topology={SQUARE_TOPOLOGY}
        isEditing={isEditing}
        activeFeatureId={isEditing ? 'sk1' : undefined}
      />
      <EntityLines
        sketch={SQUARE}
        featureId="sk1"
        color="#3a4048"
        lineWidth={2}
        isEditing={isEditing}
      />
    </>,
  )
  return view
}

beforeEach(() => {
  captured.lines.length = 0
  captured.dashed.length = 0
  captured.dots.length = 0
  usePartEditorStore.setState({ features: [], parts: {} })
  useEditorState.setState({
    normalSelection: new Set(),
    hoveredSelectionId: null,
    hoveredConstraintEntityIds: new Set(),
    hoveredVertexId: null,
    editingFeatureId: null,
    rollbackPosition: null,
  })
})

describe.each([
  { name: 'idle', isEditing: false },
  { name: 'editing', isEditing: true },
])('sketch area layering ($name)', ({ isEditing }) => {
  it('draws exactly one area fill and one Line2 per entity edge', async () => {
    const { container } = await mountScene({ isEditing })

    expect(fillMeshes(container)).toHaveLength(1)
    expect(captured.lines).toHaveLength(Object.keys(SQUARE).length)
  })

  it('keeps the fill below every line and dot', async () => {
    const { container } = await mountScene({ isEditing })

    const fillOrder = Number(fillMeshes(container)[0].getAttribute('renderorder'))
    for (const line of captured.lines) {
      expect(line.transparent, 'line pass').toBe(true)
      expect(line.renderOrder as number).toBeGreaterThan(fillOrder)
    }
    for (const dot of captured.dots) {
      expect(dot.transparent, 'dot pass').toBe(true)
      expect(dot.renderOrder as number).toBeGreaterThan(fillOrder)
    }
  })

  it('carries the fill layer order and opacity on the area mesh', async () => {
    const { container } = await mountScene({ isEditing })

    const fill = fillMeshes(container)[0]
    // The mesh sorts below every line layer. depthWrite is pinned by the layer
    // contract in renderOrder.test.tsx: React omits a false attribute on this
    // stubbed intrinsic, so it cannot be read back from the DOM here.
    expect(fill.getAttribute('renderorder')).toBe('-1')
    const material = fill.querySelector('meshbasicmaterial')
    expect(material?.getAttribute('opacity')).toBe('0.1')
  })
})

describe('draw preview layering', () => {
  it('puts the live preview line and dots in the transparent pass above the fill', async () => {
    initializeTools()
    useEditorState.setState({
      activeTool: 'line',
      drawPoints: [[0, 0]],
      drawSnapRefs: [null],
      drawHover: [5, 5],
      hoveredVertexId: null,
      hoveredVertexPosition: null,
      hoveredSnapKind: null,
      hoveredSelectionId: null,
      alignmentSnapPoint: null,
      alignmentSnapKind: null,
    })
    const { DrawPreview } = await import('@/components/Geometry3D/Drawing')
    render(<DrawPreview featureId="sk1" activeFeatureId="sk1" />)

    expect(captured.lines).toHaveLength(1)
    expect(captured.lines[0].transparent).toBe(true)
    expect(captured.lines[0].renderOrder ?? 0).toBeGreaterThan(-1)
    expect(captured.dots.length).toBeGreaterThan(0)
    for (const dot of captured.dots) expect(dot.transparent, 'preview dot pass').toBe(true)
  })
})

describe('sketch area layering under interaction states', () => {
  it('a hovered entity still draws above the fill, on the highlight layer', async () => {
    useEditorState.setState({ hoveredSelectionId: 'entity:sk1:l1' })
    await mountScene({ isEditing: false })

    const hovered = captured.lines.find(l => l.color === '#ffffff')
    expect(hovered?.transparent).toBe(true)
    expect(hovered?.renderOrder).toBe(999)
  })

  it('a selected entity stays above the fill at the edit layer', async () => {
    useEditorState.setState({ normalSelection: new Set(['entity:sk1:l2']) })
    await mountScene({ isEditing: false })

    const selected = captured.lines.find(l => l.color === '#ff9800')
    expect(selected?.transparent).toBe(true)
    expect(selected?.renderOrder).toBe(10)
  })

  it('a hinted line above the fill is transparent too', async () => {
    usePartEditorStore.setState({
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 10, direction: 'normal' } },
      ],
      parts: {},
    })
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    await mountScene({ isEditing: false })

    const hinted = captured.lines.find(l => l.color === '#4fc3f7')
    expect(hinted?.transparent).toBe(true)
    expect(hinted?.renderOrder).toBe(10)
  })

  it('a dashed construction line takes the same pass as a solid one', async () => {
    const sketch = { c1: { ...(SQUARE.l1 as LineSegment), construction: true } } as unknown as Sketch
    const [{ EntityLines }] = await Promise.all([import('@/components/Geometry3D/EntityLines')])
    render(<EntityLines sketch={sketch} featureId="sk1" color="#3a4048" lineWidth={1} />)

    expect(captured.dashed).toHaveLength(1)
    expect(captured.dashed[0].transparent).toBe(true)
    expect(captured.dashed[0].renderOrder as number).toBeGreaterThan(-1)
  })
})
