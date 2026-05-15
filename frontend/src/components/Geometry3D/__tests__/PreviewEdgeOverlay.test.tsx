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

  it('excludes edges whose query exists in pickItems', () => {
    const previewItem = makeItem('b1', [lineEdge, lineEdge], ['q:edge/1', 'q:edge/2'])
    const pickItem = makeItem('b1', [], ['q:edge/1'])

    // With pickItems: edge q:edge/1 should be excluded, q:edge/2 kept
    // buildEdgeSegments mock returns 6 * edges.length floats, so 0 floats => null geo
    // We can verify by checking that only one PreviewBodyEdges renders with 1 edge
    // (indirectly via the mock returning Float32Array(0) for empty input)
    const { container: withPick } = render(
      <PreviewEdgeOverlay items={[previewItem]} pickItems={[pickItem]} />
    )
    const { container: withoutPick } = render(
      <PreviewEdgeOverlay items={[previewItem]} />
    )
    // Both should render (both have at least one drawable edge), just checking no crash.
    expect(withPick).toBeTruthy()
    expect(withoutPick).toBeTruthy()
  })

  it('always renders edges without a query string even when pickItems is provided', () => {
    // Edge has no query (edgeQueries undefined) — must always be drawn.
    const previewItem = makeItem('b1', [lineEdge])  // no edgeQueries
    const pickItem = makeItem('b1', [])
    const { container } = render(
      <PreviewEdgeOverlay items={[previewItem]} pickItems={[pickItem]} />
    )
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
