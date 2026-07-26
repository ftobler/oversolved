import { describe, it, expect } from 'vitest'
import { AssemblySelectionIndex, buildAssemblySelectionGeometry } from '@/utils/assemblySelectionGeometry'
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

  it('collects every triangle of a face, including non-contiguous ones', () => {
    const b = body()
    b.faces = {
      // Triangles 0 and 2 belong to face 0, triangle 1 to face 1.
      positions: new Float32Array([
        0, 0, 0, 1, 0, 0, 0, 1, 0,
        9, 9, 9, 9, 9, 9, 9, 9, 9,
        2, 0, 0, 3, 0, 0, 2, 1, 0,
      ]),
      triangleToFace: new Uint32Array([0, 1, 0]),
      faceQueries: ['f0', 'f1'],
    }
    const g = buildAssemblySelectionGeometry([b], new Set(['f0']), null)
    expect(Array.from(g.selectedFaces)).toEqual([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      2, 0, 0, 3, 0, 0, 2, 1, 0,
    ])
  })

  it('drops a triangle naming a face the body has no query for', () => {
    const b = body()
    b.faces = {
      positions: new Float32Array(18),
      triangleToFace: new Uint32Array([0, 7]),  // face 7 does not exist
      faceQueries: ['f0'],
    }
    b.faceBoundaries = null
    const g = buildAssemblySelectionGeometry([b], new Set(['f0']), null)
    expect(g.selectedFaces.length).toBe(9)
  })
})

/**
 * A body whose geometry reads are observable, so "did the build touch this body
 * at all?" can be asserted directly rather than timed. `triangles` sets how
 * heavy it is; the index must not care.
 */
function countingBody(key: string, triangles: number): { pick: AssemblyPickBody; reads: () => number } {
  let reads = 0
  const positions = new Float32Array(triangles * 9)
  const triangleToFace = new Uint32Array(triangles)
  const segmentToEdge = new Uint32Array(triangles)
  for (let i = 0; i < triangles; i++) {
    triangleToFace[i] = i
    segmentToEdge[i] = i
  }
  const faces = { faceQueries: Array.from({ length: triangles }, (_, i) => `${key}:face${i}`) } as NonNullable<AssemblyPickBody['faces']>
  Object.defineProperty(faces, 'positions', { get: () => { reads++; return positions } })
  Object.defineProperty(faces, 'triangleToFace', { get: () => { reads++; return triangleToFace } })
  const edges = { edgeQueries: Array.from({ length: triangles }, (_, i) => `${key}:edge${i}`) } as NonNullable<AssemblyPickBody['edges']>
  Object.defineProperty(edges, 'segmentPositions', { get: () => { reads++; return new Float32Array(triangles * 6) } })
  Object.defineProperty(edges, 'segmentToEdge', { get: () => { reads++; return segmentToEdge } })
  return {
    pick: { bodyKey: key, faces, edges, vertices: null, faceBoundaries: null },
    reads: () => reads,
  }
}

describe('AssemblySelectionIndex', () => {
  it('touches no geometry of a body that owns nothing active', () => {
    const heavy = countingBody('heavy', 5000)
    const light = countingBody('light', 2)
    const index = new AssemblySelectionIndex([heavy.pick, light.pick])

    // Constructing the index reads the query lists only: the primitive
    // groupings are what cost O(triangles), and they stay unbuilt.
    expect(heavy.reads()).toBe(0)

    index.build(new Set(), 'light:face0', undefined)
    expect(heavy.reads()).toBe(0)
  })

  it('keeps the hover cost off the selected buffers', () => {
    const b = body()
    const index = new AssemblySelectionIndex([b])
    // One Set instance across both builds, as the store hands out: it replaces
    // the selection Set only when the selection actually changes.
    const selection = new Set(['f0'])
    const first = index.build(selection, 'e0', undefined)
    const second = index.build(selection, 'e1', undefined)
    // Same selection, different hover: the selected buffers must come back by
    // reference, or the component disposes and re-uploads them on every move.
    expect(second.selectedFaces).toBe(first.selectedFaces)
    expect(second.selectedFaceBoundary).toBe(first.selectedFaceBoundary)
    expect(Array.from(second.hoveredEdges)).toEqual([2, 2, 2, 3, 3, 3])
  })

  it('reuses one empty buffer identity for a colour that draws nothing', () => {
    const index = new AssemblySelectionIndex([body()])
    const a = index.build(new Set(['f0']), null, undefined)
    const b2 = index.build(new Set(['f1']), null, undefined)
    expect(a.hoveredFaces).toBe(b2.hoveredFaces)
    expect(a.hoveredVertices).toBe(b2.hoveredVertices)
  })

  it('rebuilds the selected buffers when the selection changes', () => {
    const index = new AssemblySelectionIndex([body()])
    const a = index.build(new Set(['f0']), null, undefined)
    const b2 = index.build(new Set(['f1']), null, undefined)
    expect(Array.from(a.selectedFaces)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0])
    expect(Array.from(b2.selectedFaces)).toEqual([2, 0, 0, 3, 0, 0, 2, 1, 0])
  })

  it('draws a hovered entity that is also selected only in the selected colour', () => {
    const index = new AssemblySelectionIndex([body()])
    const g = index.build(new Set(['f0']), 'f0', new Set(['f0']))
    expect(g.selectedFaces.length).toBe(9)
    expect(g.hoveredFaces.length).toBe(0)
  })
})
