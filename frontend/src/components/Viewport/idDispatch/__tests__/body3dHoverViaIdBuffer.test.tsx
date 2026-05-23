import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { registerBodyCallbacks, resetBodyCallbacksForTest } from '../bodyDispatchCallbacks'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter, clearAllHover } from '../brepAdapters'

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
  useSketchEditorStore.setState({
    hoveredSelectionId: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
  })
})

describe('body3dHoverViaIdBuffer', () => {
  it('face hover sets hoveredSelectionId and calls updateFaceGeometry', () => {
    let faceQueryCalled = ''
    registerBodyCallbacks('feat1/b1', {
      featureId: 'feat1',
      bodyId: 'b1',
      mesh: stubMesh(['@feat1/face/0', '@feat1/face/1']),
      edgeQueries: undefined,
      vertexQueries: undefined,
      updateFaceGeometryForQuery: (q: string) => { faceQueryCalled = q },
      clearFaceGeometry: () => {},
    })

    brepFaceAdapter.onHover('@feat1/face/0')

    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBe('@feat1/face/0')
    expect(faceQueryCalled).toBe('@feat1/face/0')
  })

  it('edge hover sets hoveredSelectionId', () => {
    registerBodyCallbacks('feat2/b1', {
      featureId: 'feat2',
      bodyId: 'b1',
      mesh: stubMesh(),
      edgeQueries: ['@feat2/edge/0', '@feat2/edge/1'],
      vertexQueries: undefined,
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepEdgeAdapter.onHover('@feat2/edge/1')

    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBe('@feat2/edge/1')
  })

  it('vertex hover sets hoveredSelectionId', () => {
    registerBodyCallbacks('feat3/b1', {
      featureId: 'feat3',
      bodyId: 'b1',
      mesh: stubMesh(),
      edgeQueries: undefined,
      vertexQueries: ['@feat3/vertex/0'],
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepVertexAdapter.onHover('@feat3/vertex/0')

    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBe('@feat3/vertex/0')
  })

  it('transition from face to edge clears old hover and sets new hoveredSelectionId', () => {
    let faceGeometryCleared = false

    registerBodyCallbacks('feat4/b1', {
      featureId: 'feat4',
      bodyId: 'b1',
      mesh: stubMesh(['@feat4/face/0']),
      edgeQueries: ['@feat4/edge/0'],
      vertexQueries: undefined,
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => { faceGeometryCleared = true },
    })

    // Step 1: hover face
    brepFaceAdapter.onHover('@feat4/face/0')
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@feat4/face/0')

    // Step 2: hover edge (should clear face hover first, then apply edge hover)
    clearAllHover()
    brepEdgeAdapter.onHover('@feat4/edge/0')

    expect(faceGeometryCleared).toBe(true)
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('@feat4/edge/0')
  })

  it('clearAllHover resets all hover state', () => {
    let faceCleared = false

    registerBodyCallbacks('feat5/b1', {
      featureId: 'feat5',
      bodyId: 'b1',
      mesh: stubMesh(['@feat5/face/0']),
      edgeQueries: ['@feat5/edge/0'],
      vertexQueries: ['@feat5/vertex/0'],
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => { faceCleared = true },
    })

    // Set up some hover state first
    brepFaceAdapter.onHover('@feat5/face/0')

    clearAllHover()

    const s = useSketchEditorStore.getState()
    expect(s.hoveredSelectionId).toBeNull()
    expect(s.hoveredFaceNormal).toBeNull()
    expect(s.hoveredFaceCenter).toBeNull()
    expect(faceCleared).toBe(true)
  })
})
