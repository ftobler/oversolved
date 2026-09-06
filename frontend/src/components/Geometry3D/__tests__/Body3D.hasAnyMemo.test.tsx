// L3: `useFrame` asks `vertexHighlightIndex.hasAny(...)` twice a frame, and
// hasAny is O(vertices) for any non-empty answer. The two results are memoized
// on exactly the inputs hasAny reads (the index identity + the flags array
// identity), so a re-render that does not change the vertex pick set must not
// recompute them -- HighlightIndex hands back the SAME all-false array for a
// miss, which is what lets the memo skip.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { HighlightIndex } from '@/picking/selectionHighlight'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Legacy mesh (no face_queries) and no edges, so the ONLY HighlightIndex.hasAny
// calls in the component are the two memoized vertex ones -- the face/edge JSX
// overlays never reach hasAny without face_queries / edges.
const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
}
const vertices: [number, number, number][] = [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
const vertexQueries = ['@body_ex1/vertex/0', '@body_ex1/vertex/1', '@body_ex1/vertex/2']

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
    <Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} vertices={vertices} vertexQueries={vertexQueries} />
  )
}

describe('vertex hasAny is memoized on the pick set', () => {
  it('does not recompute when a re-render leaves the vertex pick set identical', async () => {
    const spy = vi.spyOn(HighlightIndex.prototype, 'hasAny')
    await renderBody()
    const afterMount = spy.mock.calls.length

    // Re-render Body3D with a hovered query that matches NO vertex: compute
    // returns the shared all-false array, so the flags identity is unchanged and
    // neither hasAny memo may recompute.
    await act(async () => {
      useSketchEditorStore.setState({ hoveredSelectionId: '@nomatch/vertex/9' } as never)
    })
    expect(spy.mock.calls.length).toBe(afterMount)
    spy.mockRestore()
  })

  it('recomputes once when a vertex is actually hovered', async () => {
    const spy = vi.spyOn(HighlightIndex.prototype, 'hasAny')
    await renderBody()
    const afterMount = spy.mock.calls.length

    await act(async () => {
      useSketchEditorStore.setState({ hoveredSelectionId: vertexQueries[0] } as never)
    })
    expect(spy.mock.calls.length).toBeGreaterThan(afterMount)
    spy.mockRestore()
  })
})
