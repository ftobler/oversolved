import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import type { EdgeData } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: () => ({}),
}))

vi.mock('../Body3D', () => ({
  buildEdgeSegments: (edges: EdgeData[]) => {
    // Return 6 floats per edge (one line segment) for non-empty input.
    return new Float32Array(edges.length * 6)
  },
}))

// Stub Three.js geometry so tests don't need a WebGL context.
vi.mock('three', () => {
  const BufferGeometry = vi.fn(() => ({
    setAttribute: vi.fn(),
    dispose: vi.fn(),
  }))
  const BufferAttribute = vi.fn()
  return { BufferGeometry, BufferAttribute }
})

// Render lineSegments as a div for DOM inspection.
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function mockLineSegments({ renderOrder, children }: {
  geometry?: unknown
  renderOrder?: number
  children?: React.ReactNode
}) {
  return <div data-testid="line-segments" data-render-order={renderOrder}>{children}</div>
}

vi.stubGlobal('lineSegments', mockLineSegments)

import PreviewEdgeOverlay from '@/components/Geometry3D/PreviewEdgeOverlay'

function makeItem(key: string, edges: EdgeData[], edgeQueries?: string[]): BodyRenderItem {
  return {
    key,
    featureId: 'feat1',
    bodyId: key,
    mesh: {} as BodyRenderItem['mesh'],
    edges,
    edgeQueries,
    visible: true,
  }
}

const lineEdge: EdgeData = { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }

describe('PreviewEdgeOverlay', () => {
  it('renders nothing when items is empty', () => {
    const { container } = render(<PreviewEdgeOverlay items={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when item has no edges', () => {
    const { container } = render(<PreviewEdgeOverlay items={[makeItem('b1', [])]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when item is not visible', () => {
    const item = { ...makeItem('b1', [lineEdge]), visible: false }
    const { container } = render(<PreviewEdgeOverlay items={[item]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a group when item has edges', () => {
    const { container } = render(<PreviewEdgeOverlay items={[makeItem('b1', [lineEdge])]} />)
    expect(container.innerHTML).not.toBe('')
  })

  it('suppresses a preview edge geometrically coincident with a ghost (pick) edge', () => {
    // Preview edge sits exactly on top of the pick body's edge, so it is
    // redundant with the solid ghost and must not be drawn again.
    const previewItem = makeItem('b1', [lineEdge])
    const pickItem = makeItem('b1', [lineEdge])
    const { container } = render(
      <PreviewEdgeOverlay items={[previewItem]} pickItems={[pickItem]} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('renders a MOVED edge even when the pick body has an edge of the same identity', () => {
    // Regression: a rigid transform/mirror keeps an edge's construction identity
    // but relocates it. Suppression keyed on identity would hide the whole
    // preview; keyed on geometry, the moved edge survives and is drawn.
    const movedEdge: EdgeData = { kind: 'line', start: [100, 0, 0], end: [101, 0, 0] }
    const previewItem = makeItem('b1', [movedEdge], ['q:edge/1'])
    const pickItem = makeItem('b1', [lineEdge], ['q:edge/1'])  // same query, old position
    const { container } = render(
      <PreviewEdgeOverlay items={[previewItem]} pickItems={[pickItem]} />
    )
    expect(container.innerHTML).not.toBe('')
  })

  it('suppresses a preview edge coincident with a ghost edge walked in the opposite direction', () => {
    // Regression (Group 7 M2): a rebuild that re-topologizes a body without
    // moving an edge can hand OCC the reversed orientation. Same physical
    // curve, so the preview line is still redundant and must not be redrawn
    // over the ghost.
    const forward: EdgeData = { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }
    const reversed: EdgeData = { kind: 'line', start: [1, 0, 0], end: [0, 0, 0] }
    const { container } = render(
      <PreviewEdgeOverlay items={[makeItem('b1', [reversed])]} pickItems={[makeItem('b1', [forward])]} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('suppresses a coincident polyline sampled from the other end', () => {
    // Same set of sampled points, reverse emission order.
    const fwd: EdgeData = { kind: 'spline', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }
    const rev: EdgeData = { kind: 'spline', points: [[2, 0, 0], [1, 0, 0], [0, 0, 0]] }
    const { container } = render(
      <PreviewEdgeOverlay items={[makeItem('b1', [rev])]} pickItems={[makeItem('b1', [fwd])]} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('still draws a genuinely relocated edge (canonicalization is not identity-blind)', () => {
    // Guard against over-suppression: a moved edge occupies a different point
    // set and must survive the order-independent key.
    const here: EdgeData = { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] }
    const moved: EdgeData = { kind: 'line', start: [100, 0, 0], end: [101, 0, 0] }
    const { container } = render(
      <PreviewEdgeOverlay items={[makeItem('b1', [moved])]} pickItems={[makeItem('b1', [here])]} />
    )
    expect(container.innerHTML).not.toBe('')
  })

  it('draws every preview edge when no pickItems are provided', () => {
    const previewItem = makeItem('b1', [lineEdge])
    const { container } = render(<PreviewEdgeOverlay items={[previewItem]} />)
    expect(container.innerHTML).not.toBe('')
  })

  it('preview is immutable: emits only non-interactive lineSegments (no onClick / onPointerOver)', () => {
    // User invariant (solver_arch.user.md §Feature Editing):
    //   "Preview is fully immutable."
    //
    // Structural check: PreviewEdgeOverlay must not attach pointer handlers to
    // any element it emits, so raycasts cannot fire selection or pick-chip
    // mutations on preview edges.
    const previewItem = makeItem('b1', [lineEdge], ['q:edge/1'])
    const { container } = render(<PreviewEdgeOverlay items={[previewItem]} />)
    // Walk every emitted DOM element and assert no pointer-event handlers in props.
    const all = container.querySelectorAll('*')
    for (const el of Array.from(all)) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase()).not.toMatch(/^onclick$|^onpointer|^onmouse/)
      }
    }
  })
})
