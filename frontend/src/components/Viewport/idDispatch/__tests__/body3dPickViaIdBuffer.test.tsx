import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { registerBodyCallbacks, resetBodyCallbacksForTest } from '../bodyDispatchCallbacks'
import type { Mesh3D } from '@/types/cad'

// Click outcome is centralized in the dispatcher: every selectable layer
// toggles normalSelection with exactly the clicked query (no @bodyId added),
// regardless of whether a pick field is active (the chip consumes downstream).
const click = (q: string) => useSketchEditorStore.getState().toggleNormalSelection(q)

function stubMesh(faceQueries?: string[]): Mesh3D {
  return {
    faces: [],
    positions: [],
    face_queries: faceQueries ?? [],
  } as unknown as Mesh3D
}

beforeEach(() => {
  resetBodyCallbacksForTest()
  setSketchCallback('onMutation', vi.fn())
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    activePickField: null,
    hoveredSelectionId: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
  })
})

afterEach(() => {
  resetBodyCallbacksForTest()
})

describe('body3dPickViaIdBuffer', () => {
  it('face click toggles normalSelection with face query, not @bodyId', () => {
    registerBodyCallbacks('feat1/b1', {
      featureId: 'feat1',
      bodyId: 'b1',
      mesh: stubMesh(['@feat1/face/0', '@feat1/face/1']),
      edgeQueries: undefined,
      vertexQueries: undefined,
      updateFaceGeometryForIndex: () => {},
      clearFaceGeometry: () => {},
    })

    click('@feat1/face/0')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat1/face/0')).toBe(true)
    expect(sel.has('@feat1/b1')).toBe(false)
    expect(sel.size).toBe(1)
  })

  it('edge click toggles normalSelection with edge query, not @bodyId', () => {
    registerBodyCallbacks('feat2/b1', {
      featureId: 'feat2',
      bodyId: 'b1',
      mesh: stubMesh(),
      edgeQueries: ['@feat2/edge/0', '@feat2/edge/1'],
      vertexQueries: undefined,
      updateFaceGeometryForIndex: () => {},
      clearFaceGeometry: () => {},
    })

    click('@feat2/edge/1')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat2/edge/1')).toBe(true)
    expect(sel.has('@feat2')).toBe(false)
    expect(sel.has('@feat2/b1')).toBe(false)
  })

  it('vertex click toggles normalSelection with vertex query, not @bodyId', () => {
    registerBodyCallbacks('feat3/b1', {
      featureId: 'feat3',
      bodyId: 'b1',
      mesh: stubMesh(),
      edgeQueries: undefined,
      vertexQueries: ['@feat3/vertex/0'],
      updateFaceGeometryForIndex: () => {},
      clearFaceGeometry: () => {},
    })

    click('@feat3/vertex/0')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat3/vertex/0')).toBe(true)
    expect(sel.size).toBe(1)
  })

  it('face click with a pick field active still toggles normalSelection (chip consumes downstream)', () => {
    registerBodyCallbacks('feat4/b1', {
      featureId: 'feat4',
      bodyId: 'b1',
      mesh: stubMesh(['@feat4/face/0']),
      edgeQueries: undefined,
      vertexQueries: undefined,
      updateFaceGeometryForIndex: () => {},
      clearFaceGeometry: () => {},
    })

    useSketchEditorStore.getState().setActivePickField({ featureId: 'feat4', field: 'plane' })
    click('@feat4/face/0')

    // No parallel plane-commit path: the click lands in normalSelection and
    // the active pick field consumes it via usePickField (Layer 2).
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat4/face/0')).toBe(true)
  })
})
