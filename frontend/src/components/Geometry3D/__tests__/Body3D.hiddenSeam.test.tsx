import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

import type { EdgeData, Mesh3D } from '@/types/cad'
import { COLOR_SELECTED } from '@/components/Geometry3D/constants'
import { useEditorState } from '@/hooks/useEditorState'

/**
 * The seam rule at the Body3D seam: the beauty pass and the ID layer skip a
 * hidden edge, but the overlay stays index-keyed. A seam picked into a document
 * (MCP `select`, a restored selection set) therefore still draws its highlight
 * instead of becoming an invisible selection.
 */

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { paints } = vi.hoisted(() => ({
  paints: [] as { count: number; colorFloats: number; runs: { count: number; eachRun: (i: number, v: (s: number, c: number) => void) => void } }[],
}))

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: { geometry: { getAttribute: (n: string) => { array: ArrayLike<number> } | undefined }; runs: { count: number; eachRun: (i: number, v: (s: number, c: number) => void) => void } }) => {
      const color = params.geometry.getAttribute('color')
      paints.push({
        count: params.runs.count,
        colorFloats: color ? color.array.length : 0,
        runs: params.runs,
      })
      return actual.useHighlightColors(params as never)
    },
  }
})

const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
  face_queries: ['f0'],
  triangle_to_face: [0],
}

// Edge 1 is the body's seam: hidden from the beauty pass and the ID layer.
const edges: EdgeData[] = [
  { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
  { kind: 'line', start: [1, 0, 0], end: [1, 0, 1] },
  { kind: 'line', start: [2, 0, 0], end: [3, 0, 0] },
]
const QUERIES = ['?e0', '?seam', '?e2']
const SEAM_PICK_KEY = 'ex1/body_ex1#edge#1'

function resetStore(overrides: Record<string, unknown> = {}) {
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
    ...overrides,
  } as never)
}

async function renderBody() {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(
    <Body3D
      featureId="ex1"
      bodyId="body_ex1"
      mesh={mesh}
      edges={edges}
      edgeQueries={QUERIES}
      hiddenEdges={[1]}
    />,
  )
}

function edgePaint() {
  // Face runs count faces (1); the edge paint counts all three input edges.
  return paints.find(p => p.count === edges.length)
}

beforeEach(() => {
  paints.length = 0
  resetStore()
})

describe('Body3D hidden seam', () => {
  it('builds the beauty buffer without the hidden edge but keeps its run slot', async () => {
    await renderBody()
    const paint = edgePaint()
    expect(paint).toBeDefined()
    // Two visible lines, 6 floats each; the seam owns run 1 with zero segments,
    // so its run is empty and every later offset stays put.
    expect(paint!.colorFloats).toBe(2 * 6)
    let seamVisited = false
    paint!.runs.eachRun(1, (_start, count) => { seamVisited = true; expect(count).toBe(0) })
    expect(seamVisited).toBe(false)
    // The third edge still owns the final run: one segment, two vertices.
    let thirdRun = -1
    paint!.runs.eachRun(2, (_start, count) => { thirdRun = count })
    expect(thirdRun).toBe(2)
  })

  it('still draws the overlay of a seam held by the selection store', async () => {
    resetStore({
      normalSelection: new Set([QUERIES[1]]),
      selectedPicks: new Map([[QUERIES[1], new Set([SEAM_PICK_KEY])]]),
    })
    const { container } = await renderBody()
    const selected = [...container.querySelectorAll('linebasicmaterial')]
      .filter(el => el.getAttribute('color') === COLOR_SELECTED)
    // The overlay exists, so lazyGeometryCache built edge 1's segments with no
    // hidden set: an explicit selection draws a primitive the viewport hides.
    expect(selected).toHaveLength(1)
    // The beauty pass is still the hidden-seam one.
    expect(edgePaint()!.colorFloats).toBe(2 * 6)
  })
})
