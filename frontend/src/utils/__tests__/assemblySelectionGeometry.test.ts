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
})
