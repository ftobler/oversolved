import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { registerBodyCallbacks, resetBodyCallbacksForTest } from '../bodyDispatchCallbacks'
import { brepFaceAdapter, brepEdgeAdapter, brepVertexAdapter, clearBrepHover } from '../brepAdapters'

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
    pendingPickField: null,
    planeSelectionFeatureId: null,
    hovered3DSurfaceId: null,
    hoveredBodyId: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
  })
})

afterEach(() => {
  resetBodyCallbacksForTest()
  useSketchEditorStore.setState({
    hoveredBodyId: null,
    hoveredFaceNormal: null,
    hoveredFaceCenter: null,
    hovered3DSurfaceId: null,
  })
})

describe('body3dHoverViaIdBuffer', () => {
  it('face hover sets hovered3DSurfaceId, hoveredBodyId, and calls updateFaceGeometry', () => {
    let faceQueryCalled = ''
    registerBodyCallbacks('feat1/b1', {
      featureId: 'feat1',
      bodyId: 'b1',
      mesh: stubMesh(['@feat1/face/0', '@feat1/face/1']),
      edgeQueries: undefined,
      vertexQueries: undefined,
      setHoveredEdgeIndex: () => {},
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: (q: string) => { faceQueryCalled = q },
      clearFaceGeometry: () => {},
    })

    brepFaceAdapter.onHover('@feat1/face/0')

    const s = useSketchEditorStore.getState()
    expect(s.hovered3DSurfaceId).toBe('@feat1/face/0')
    expect(s.hoveredBodyId).toBe('feat1')
    expect(faceQueryCalled).toBe('@feat1/face/0')
  })

  it('edge hover sets hoveredEdgeIndex and hoveredBodyId', () => {
    let edgeIdx: number | null = -1
    registerBodyCallbacks('feat2/b1', {
      featureId: 'feat2',
      bodyId: 'b1',
      mesh: stubMesh(),
      edgeQueries: ['@feat2/edge/0', '@feat2/edge/1'],
      vertexQueries: undefined,
      setHoveredEdgeIndex: (idx: number | null) => { edgeIdx = idx },
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepEdgeAdapter.onHover('@feat2/edge/1')

    expect(edgeIdx).toBe(1)
    expect(useSketchEditorStore.getState().hoveredBodyId).toBe('feat2')
  })

  it('vertex hover sets hoveredVertexIndex and hoveredBodyId', () => {
    let vtxIdx: number | null = -1
    registerBodyCallbacks('feat3/b1', {
      featureId: 'feat3',
      bodyId: 'b1',
      mesh: stubMesh(),
      edgeQueries: undefined,
      vertexQueries: ['@feat3/vertex/0'],
      setHoveredEdgeIndex: () => {},
      setHoveredVertexIndex: (idx: number | null) => { vtxIdx = idx },
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => {},
    })

    brepVertexAdapter.onHover('@feat3/vertex/0')

    expect(vtxIdx).toBe(0)
    expect(useSketchEditorStore.getState().hoveredBodyId).toBe('feat3')
  })

  it('transition from face to edge clears face fields and sets edge fields', () => {
    let edgeIdx: number | null = -1
    let faceGeometryCleared = false

    registerBodyCallbacks('feat4/b1', {
      featureId: 'feat4',
      bodyId: 'b1',
      mesh: stubMesh(['@feat4/face/0']),
      edgeQueries: ['@feat4/edge/0'],
      vertexQueries: undefined,
      setHoveredEdgeIndex: (idx: number | null) => {
        edgeIdx = idx
      },
      setHoveredVertexIndex: () => {},
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => { faceGeometryCleared = true },
    })

    // Step 1: hover face
    brepFaceAdapter.onHover('@feat4/face/0')
    expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBe('@feat4/face/0')

    // Step 2: hover edge (should clear face hover first, then apply edge hover)
    // The dispatcher calls clearBrepHover then the edge adapter.
    clearBrepHover()
    brepEdgeAdapter.onHover('@feat4/edge/0')

    expect(faceGeometryCleared).toBe(true)
    expect(useSketchEditorStore.getState().hovered3DSurfaceId).toBeNull()
    expect(useSketchEditorStore.getState().hoveredFaceNormal).toBeNull()
    expect(useSketchEditorStore.getState().hoveredFaceCenter).toBeNull()
    expect(edgeIdx).toBe(0)
    expect(useSketchEditorStore.getState().hoveredBodyId).toBe('feat4')
  })

  it('clearBrepHover resets all hover state', () => {
    let edgeIdx: number | null = -1
    let vtxIdx: number | null = -1
    let faceCleared = false

    registerBodyCallbacks('feat5/b1', {
      featureId: 'feat5',
      bodyId: 'b1',
      mesh: stubMesh(['@feat5/face/0']),
      edgeQueries: ['@feat5/edge/0'],
      vertexQueries: ['@feat5/vertex/0'],
      setHoveredEdgeIndex: (idx: number | null) => { edgeIdx = idx },
      setHoveredVertexIndex: (idx: number | null) => { vtxIdx = idx },
      updateFaceGeometryForQuery: () => {},
      clearFaceGeometry: () => { faceCleared = true },
    })

    // Set up some hover state first
    brepFaceAdapter.onHover('@feat5/face/0')
    brepEdgeAdapter.onHover('@feat5/edge/0')
    brepVertexAdapter.onHover('@feat5/vertex/0')

    clearBrepHover()

    const s = useSketchEditorStore.getState()
    expect(s.hovered3DSurfaceId).toBeNull()
    expect(s.hoveredBodyId).toBeNull()
    expect(s.hoveredFaceNormal).toBeNull()
    expect(s.hoveredFaceCenter).toBeNull()
    expect(edgeIdx).toBeNull()
    expect(vtxIdx).toBeNull()
    expect(faceCleared).toBe(true)
  })
})
