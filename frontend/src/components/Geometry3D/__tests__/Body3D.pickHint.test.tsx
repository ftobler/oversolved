// The picked-primitive half of the relation hint: a selected (or being-edited)
// feature draws the edges/faces it picked that still exist, and a pick the last
// solve refused is painted in the failure colour. The flags are the observable
// input to the colour painter; the precedence itself is the painter's.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { EdgeData, Mesh3D, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorStore } from '@/stores/partEditorStore'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

interface PaintCall {
  hinted?: readonly boolean[] | null
  hintedFailed?: readonly boolean[] | null
}

const calls = vi.hoisted(() => [] as PaintCall[])

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: PaintCall) => {
      calls.push(params)
      return actual.useHighlightColors(params as never)
    },
  }
})

const pickOne = makeAncestryQuery(['@u|one', '@ex1', '@body_ex1'], 'straightedge')
const pickTwo = makeAncestryQuery(['@u|two', '@ex1', '@body_ex1'], 'straightedge')
const pickedFace = makeAncestryQuery(['@u|shellface', '@ex1', '@body_ex1'], 'flatface')

const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2]),
  face_queries: ['face-ex1'],
  face_created_by: ['ex1'],
  triangle_to_face: [0],
}

const edges: EdgeData[] = [
  { kind: 'line', start: [0, 0, 0], end: [1, 0, 0] },
  { kind: 'line', start: [0, 0, 0], end: [0, 1, 0] },
]

const ex1: PartFeature = { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 10 } }
const fi1: PartFeature = { id: 'fi1', kind: 'fillet', fillet: { edges: [pickOne, pickTwo], radius: 20 } }

function setSolve(failedEdges: string[] = []) {
  usePartEditorStore.setState({
    features: [ex1, fi1],
    bodies: {
      body_ex1: {
        id: 'body_ex1', created_by: 'ex1', modified_by: [],
        edges, edge_queries: [pickOne, pickTwo],
      },
    },
    solveResults: failedEdges.length > 0
      ? { fi1: { status: 'partial', body_id: 'body_ex1', failed_edges: failedEdges } }
      : { fi1: { status: 'exception' } },
  })
}

beforeEach(() => {
  calls.length = 0
  setSolve()
  useEditorState.setState({
    editingFeatureId: null,
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  })
})

async function renderBody(props: Record<string, unknown> = {}) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} edges={edges} edgeQueries={[pickOne, pickTwo]} {...props} />)
}

/** The edge painter is the last useHighlightColors call a render makes. */
const edgePaint = () => calls[calls.length - 1]
/** The face painter is the call before it. */
const facePaint = () => calls[calls.length - 2]

describe('Body3D picked-primitive hint', () => {
  it('a selected failed fillet draws exactly its picks', async () => {
    setSolve()
    useEditorState.setState({ normalSelection: new Set(['@fi1']) })
    await renderBody()
    expect(edgePaint().hinted).toEqual([true, true])
    expect(edgePaint().hintedFailed?.some(Boolean)).toBe(false)
  })

  it('a refused pick is painted in the failure colour, the other stays a hint', async () => {
    setSolve([pickTwo])
    useEditorState.setState({ normalSelection: new Set(['@fi1']) })
    await renderBody()
    expect(edgePaint().hinted).toEqual([true, false])
    expect(edgePaint().hintedFailed).toEqual([false, true])
  })

  it('an open editor hints its picks with no row selected', async () => {
    setSolve()
    useEditorState.setState({ editingFeatureId: 'fi1' })
    await renderBody()
    expect(edgePaint().hinted).toEqual([true, true])
  })

  it('a built fillet draws no pick and still tints the faces it created', async () => {
    // The blend consumed both picked edges: they are no longer on the body, and
    // the two blend faces now name the fillet as their creator.
    usePartEditorStore.setState({ features: [ex1, fi1], bodies: {} })
    useEditorState.setState({ normalSelection: new Set(['@fi1']) })
    const built: Mesh3D = { ...mesh, face_created_by: ['fi1'] }
    await renderBody({ mesh: built, edgeQueries: [] })
    expect(edgePaint().hinted?.some(Boolean)).toBe(false)
    expect(facePaint().hinted).toEqual([true])
  })

  it('a refused face pick of a shell is painted on the face', async () => {
    // The face analogue: shell/move_face/delete_face refuse a face the same way
    // a fillet refuses an edge, so the face tint carries the mark.
    const shelled: Mesh3D = { ...mesh, face_queries: [pickedFace], face_created_by: ['ex1'] }
    const shellFeature: PartFeature = { id: 'sh1', kind: 'shell', shell: { faces: [pickedFace], thickness: 1 } }
    usePartEditorStore.setState({
      features: [ex1, shellFeature],
      bodies: {
        body_ex1: {
          id: 'body_ex1', created_by: 'ex1', modified_by: [],
          mesh: { vertices: [], faces: [], face_queries: [pickedFace] },
        },
      },
      solveResults: { sh1: { status: 'partial', body_id: 'body_ex1', failed_faces: [pickedFace] } },
    })
    useEditorState.setState({ normalSelection: new Set(['@sh1']) })
    await renderBody({ mesh: shelled, edgeQueries: [] })
    expect(facePaint().hinted?.some(Boolean)).toBe(false)
    expect(facePaint().hintedFailed).toEqual([true])
  })

  it('hovering paints no pick hint', async () => {
    setSolve()
    useEditorState.setState({ hoveredSelectionId: '@fi1', hoveredPickKey: 'body_ex1#edge#0' })
    await renderBody()
    expect(edgePaint().hinted?.some(Boolean)).toBe(false)
    expect(edgePaint().hintedFailed?.some(Boolean)).toBe(false)
  })

  it('a doomed body paints no pick hint', async () => {
    setSolve([pickTwo])
    useEditorState.setState({ normalSelection: new Set(['@fi1']) })
    await renderBody({ doomed: true })
    expect(edgePaint().hinted).toBeNull()
    expect(edgePaint().hintedFailed).toBeNull()
  })
})
