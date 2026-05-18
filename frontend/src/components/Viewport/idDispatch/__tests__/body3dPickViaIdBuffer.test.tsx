import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { registerBodyCallbacks, resetBodyCallbacksForTest } from '../bodyDispatchCallbacks'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter } from '../brepAdapters'
import type { Mesh3D } from '@/types/cad'

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
    planeSelectionFeatureId: null,
    hovered3DSurfaceId: null,
    hoveredBodyId: null,
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
      setHoveredEdgeIndex: () => {},
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepFaceAdapter.onClick('@feat1/face/0')

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
      setHoveredEdgeIndex: () => {},
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepEdgeAdapter.onClick('@feat2/edge/1')

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
      setHoveredEdgeIndex: () => {},
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepVertexAdapter.onClick('@feat3/vertex/0')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('@feat3/vertex/0')).toBe(true)
    expect(sel.size).toBe(1)
  })

  it('face click with planeSelectionFeatureId commits plane selection', () => {
    registerBodyCallbacks('feat4/b1', {
      featureId: 'feat4',
      bodyId: 'b1',
      mesh: stubMesh(['@feat4/face/0']),
      edgeQueries: undefined,
      vertexQueries: undefined,
      setHoveredEdgeIndex: () => {},
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    useSketchEditorStore.setState({ planeSelectionFeatureId: 'feat4' })
    brepFaceAdapter.onClick('@feat4/face/0')

    // The click should not toggle normalSelection when in plane mode.
    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.size).toBe(0)
  })

})
