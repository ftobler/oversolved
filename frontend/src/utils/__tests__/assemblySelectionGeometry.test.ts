import { describe, it, expect } from 'vitest'
import { buildAssemblySelectionGeometry } from '@/utils/assemblySelectionGeometry'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

// One body: two triangles (faces f0, f1), two edge segments (e0, e1), two
// vertices (v0, v1). Positions are placeholders; only the routing by key is
// under test.
function body(): AssemblyPickBody {
  return {
    bodyKey: 'B',
    faces: {
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,  // triangle 0 -> face 0
        2, 0, 0, 3, 0, 0, 2, 1, 0,  // triangle 1 -> face 1
      ]),
      triangleToFace: new Uint32Array([0, 1]),
      faceQueries: ['f0', 'f1'],
    },
    edges: {
      segmentPositions: new Float32Array([
        0, 0, 0, 1, 1, 1,  // segment 0 -> edge 0
        2, 2, 2, 3, 3, 3,  // segment 1 -> edge 1
      ]),
      segmentToEdge: new Uint32Array([0, 1]),
      edgeQueries: ['e0', 'e1'],
    },
    vertices: {
      vertices: [[9, 9, 9], [8, 8, 8]],
      vertexQueries: ['v0', 'v1'],
    },
    faceBoundaries: new Map([
      [0, new Float32Array([0, 0, 0, 1, 0, 0])],  // face 0's boundary loop, one segment
      [1, new Float32Array([2, 0, 0, 3, 0, 0, 3, 0, 0, 2, 1, 0])],  // face 1's, two segments
    ]),
  }
}

describe('buildAssemblySelectionGeometry', () => {
  it('allocates nothing when idle', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(), null)
    expect(g.selectedFaces.length).toBe(0)
    expect(g.hoveredFaces.length).toBe(0)
    expect(g.selectedVertices).toEqual([])
  })

  it('extracts the selected face triangle', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(['f1']), null)
    expect(Array.from(g.selectedFaces)).toEqual([2, 0, 0, 3, 0, 0, 2, 1, 0])
    expect(g.hoveredFaces.length).toBe(0)
  })

  it('routes hover to the hovered buffers only', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(), 'e0')
    expect(Array.from(g.hoveredEdges)).toEqual([0, 0, 0, 1, 1, 1])
    expect(g.selectedEdges.length).toBe(0)
  })

  it('lets selection win over hover for the same entity', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(['f0']), 'f0')
    expect(g.selectedFaces.length).toBe(9)
    expect(g.hoveredFaces.length).toBe(0)
  })

  it('collects selected and hovered vertices', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(['v0']), 'v1')
    expect(g.selectedVertices).toEqual([[9, 9, 9]])
    expect(g.hoveredVertices).toEqual([[8, 8, 8]])
  })

  it('extracts the selected face boundary loop', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(['f1']), null)
    expect(Array.from(g.selectedFaceBoundary)).toEqual([2, 0, 0, 3, 0, 0, 3, 0, 0, 2, 1, 0])
    expect(g.hoveredFaceBoundary.length).toBe(0)
  })

  it('routes the hovered face boundary loop to its own buffer', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(), 'f0')
    expect(Array.from(g.hoveredFaceBoundary)).toEqual([0, 0, 0, 1, 0, 0])
    expect(g.selectedFaceBoundary.length).toBe(0)
  })

  it('lets selection win over hover for a face boundary loop, not both', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(['f0']), 'f0')
    expect(Array.from(g.selectedFaceBoundary)).toEqual([0, 0, 0, 1, 0, 0])
    expect(g.hoveredFaceBoundary.length).toBe(0)
  })

  it('allocates no face boundary when the body has none', () => {
    const b = body()
    b.faceBoundaries = null
    const g = buildAssemblySelectionGeometry([b], new Set(['f0']), null)
    expect(g.selectedFaces.length).toBe(9)
    expect(g.selectedFaceBoundary.length).toBe(0)
  })

  it('draws mate-highlighted keys in the hover buffers', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(), null, new Set(['f1', 'e0']))
    expect(Array.from(g.hoveredFaces)).toEqual([2, 0, 0, 3, 0, 0, 2, 1, 0])
    expect(Array.from(g.hoveredEdges)).toEqual([0, 0, 0, 1, 1, 1])
    expect(g.selectedFaces.length).toBe(0)
  })

  it('a key that is both selected and mate-highlighted draws only in the selected colour', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(['f0']), null, new Set(['f0']))
    expect(g.selectedFaces.length).toBe(9)
    expect(g.hoveredFaces.length).toBe(0)
  })

  it('a mate-highlighted key alongside a separately hovered key draws both in the hover buffer', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(), 'e0', new Set(['f1']))
    expect(Array.from(g.hoveredFaces)).toEqual([2, 0, 0, 3, 0, 0, 2, 1, 0])
    expect(Array.from(g.hoveredEdges)).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('allocates nothing when mateHighlighted is an empty set and nothing else is active', () => {
    const g = buildAssemblySelectionGeometry([body()], new Set(), null, new Set())
    expect(g.hoveredFaces.length).toBe(0)
    expect(g.selectedFaces.length).toBe(0)
  })
})
