// H1: the edge highlight painter used to count run offsets from an unconditional
// per-edge segment count, while the colour buffer it wrote was sized from the
// one-pass builder that SKIPS degenerate edges. One skipped edge then shifted
// every later run past the end of the Float32Array. Both now come from the same
// single traversal (edgeSegmentGeometry), so a degenerate edge can never push a
// run offset past the colour buffer.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { EdgeData, Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Capture the runs AND the geometry of every useHighlightColors call so a test
// can read the colour buffer the painter writes into.
const { paints } = vi.hoisted(() => ({
  paints: [] as { count: number; colorFloats: number; runs: { count: number; eachRun: (i: number, v: (s: number, c: number) => void) => void } }[],
}))

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: { geometry: THREE.BufferGeometry; runs: { count: number; eachRun: (i: number, v: (s: number, c: number) => void) => void } }) => {
      const color = params.geometry.getAttribute('color')
      paints.push({
        count: params.runs.count,
        colorFloats: color ? (color.array as ArrayLike<number>).length : 0,
        runs: params.runs,
      })
      return actual.useHighlightColors(params as never)
    },
  }
})

// A three-triangle strip.
const mesh: Mesh3D = {
  vertices: new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0,
    2, 0, 0, 3, 0, 0, 3, 1, 0,
    4, 0, 0, 5, 0, 0, 5, 1, 0,
  ]),
  faces: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
}

// A valid line, a degenerate arc (NaN angles -> skipped by the builder), a valid line.
const edges: EdgeData[] = [
  { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
  { kind: 'arc', center: [0, 0, 0], radius: 1, axis: [0, 0, 1], x_axis: [1, 0, 0],
    angle_start: NaN, angle_end: NaN },
  { kind: 'line', start: [2, 0, 0], end: [3, 0, 0] },
]

beforeEach(() => {
  paints.length = 0
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  } as never)
})

describe('the edge painter runs count from the built buffer', () => {
  it('a degenerate edge does not push run offsets past the colour buffer', async () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['?e2']) } as never)
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(
      <Body3D
        featureId="ex1"
        bodyId="body_ex1"
        mesh={mesh}
        edges={edges}
        edgeQueries={['?e0', '?e1', '?e2']}
      />,
    )

    // The edge paint is the call whose runs count equals the input edge count (3)
    // and whose colour buffer is the line-segments buffer (2 built segments x 6).
    const edgePaint = paints.find(p => p.count === edges.length && p.colorFloats === 2 * 6)
    expect(edgePaint).toBeDefined()

    for (let i = 0; i < edgePaint!.runs.count; i++) {
      edgePaint!.runs.eachRun(i, (vertexStart, vertexCount) => {
        expect((vertexStart + vertexCount) * 3).toBeLessThanOrEqual(edgePaint!.colorFloats)
      })
    }
  })

  it('emits one run per input edge, including the skipped one', async () => {
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(
      <Body3D
        featureId="ex1"
        bodyId="body_ex1"
        mesh={mesh}
        edges={edges}
        edgeQueries={['?e0', '?e1', '?e2']}
      />,
    )
    const edgePaint = paints.find(p => p.count === edges.length && p.colorFloats === 2 * 6)
    expect(edgePaint!.runs.count).toBe(3)
  })
})
