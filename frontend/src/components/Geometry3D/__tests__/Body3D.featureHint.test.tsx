// The viewport half of the relation hint: a selected feature tints exactly the
// faces it created, and nothing else. The flags are the observable input to the
// colour painter; a hint must never reach a doomed body or a hover.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import type { Mesh3D, PartFeature } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorStore } from '@/stores/partEditorStore'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const calls = vi.hoisted(() => [] as { hinted?: readonly boolean[] | null }[])

vi.mock('@/components/Geometry3D/useHighlightColors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/useHighlightColors')>()
  return {
    ...actual,
    useHighlightColors: (params: { hinted?: readonly boolean[] | null }) => {
      calls.push(params)
      return actual.useHighlightColors(params as never)
    },
  }
})

// Two triangles, two B-rep faces, so the face-indexed hint array and the paint
// runs share one count.
const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0]),
  faces: new Uint32Array([0, 1, 2, 3, 4, 5]),
  face_queries: ['face-ex1', 'face-cut1'],
  face_created_by: ['ex1', 'cut1'],
  triangle_to_face: [0, 1],
}

const ex1: PartFeature = { id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: 10 } }
const cut1: PartFeature = { id: 'cut1', kind: 'extrude', extrude: { sketch: '@sk2', distance: 5, operation: 'cut' } }

beforeEach(() => {
  calls.length = 0
  usePartEditorStore.setState({ features: [ex1, cut1], bodies: {} })
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    hoveredSelectionId: null,
    hoveredPickKey: null,
  })
})

async function renderBody(props: Record<string, unknown> = {}) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} {...props} />)
}

/** The face painter is the first of the two useHighlightColors calls a render
 *  makes; keep the current render's pair rather than a previous render's. */
const faceHint = () => calls[calls.length - 2]?.hinted

describe('Body3D feature face hint', () => {
  it('tints only the faces the selected feature created', async () => {
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    await renderBody()
    expect(faceHint()).toEqual([true, false])
  })

  it('tints the other feature when its row is selected', async () => {
    useEditorState.setState({ normalSelection: new Set(['@cut1']) })
    await renderBody()
    expect(faceHint()).toEqual([false, true])
  })

  it('hints nothing for a body whose faces no selected feature created', async () => {
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    const other: Mesh3D = {
      ...mesh,
      face_queries: ['face-other1', 'face-other2'],
      face_created_by: ['other1', 'other2'],
    }
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="other1" bodyId="body_other" mesh={other} />)
    expect(faceHint()?.some(Boolean)).toBe(false)
  })

  it('keeps an unrelated body on the shared all-false array when the selection changes', async () => {
    const other: Mesh3D = {
      ...mesh,
      face_queries: ['face-other1', 'face-other2'],
      face_created_by: ['other1', 'other2'],
    }
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    const { rerender } = render(<Body3D featureId="other1" bodyId="body_other" mesh={other} />)
    const before = faceHint()
    act(() => {
      useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    })
    rerender(<Body3D featureId="other1" bodyId="body_other" mesh={other} />)
    expect(faceHint()).toBe(before)
  })

  it('hovering a feature row or a face paints no hint', async () => {
    useEditorState.setState({
      normalSelection: new Set(),
      hoveredSelectionId: '@ex1',
      hoveredPickKey: 'body_ex1#face#0',
    })
    await renderBody()
    expect(faceHint()?.some(Boolean)).toBe(false)
  })

  it('a doomed body paints no hint', async () => {
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    await renderBody({ doomed: true })
    expect(faceHint()).toBeNull()
  })

  it('a selected face marks a tree row but tints no sibling face in 3D', async () => {
    const facePick = makeAncestryQuery(['@ex1', '@body_ex1'], 'flatface')
    useEditorState.setState({ normalSelection: new Set([facePick]) })
    await renderBody()
    expect(faceHint()?.some(Boolean)).toBe(false)
  })

  it('the legacy per-triangle face path carries no hint', async () => {
    // No `triangle_to_face` means no B-rep face index to attribute, so the
    // legacy path is flat: it never receives a hint array.
    const legacy: Mesh3D = { ...mesh, triangle_to_face: undefined }
    useEditorState.setState({ normalSelection: new Set(['@ex1']) })
    const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
    render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={legacy} />)
    expect(faceHint()).toBeNull()
  })
})
