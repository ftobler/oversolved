// Highlight buffers for the assembly's B-rep selection, computed without a
// viewport.
//
// The part editor recolours a body's own vertex-colour attribute per face
// (Body3D). The assembly cannot: its render meshes carry no per-triangle face
// ids. But `pickGeometry` (AssemblyPickBody[]) already holds, per body, the
// non-indexed face triangles, the edge segments and the vertex points, each
// keyed by `assemblyEntityKey` and already in solved-pose world coordinates.
// So the overlay is built here by pulling out exactly the triangles/segments/
// points whose key is selected or hovered, and a thin component turns these
// into three.js geometry.
//
// Pure: no three.js, no store. Selection wins over hover for an entity that is
// both, so a hovered-and-selected face draws once, in the selected colour.

import type { AssemblyPickBody } from '@/utils/assemblyPick'
import type { Vec3 } from '@/utils/transform3d'

export interface AssemblySelectionGeometry {
  /** Non-indexed triangle positions (9 floats per triangle). */
  selectedFaces: Float32Array
  hoveredFaces: Float32Array
  /** Line-segment positions (6 floats per segment). */
  selectedEdges: Float32Array
  hoveredEdges: Float32Array
  /** Face boundary-loop line segments (6 floats per segment), same precedence
   *  rule as the tint: a face that is both selected and hovered draws only here. */
  selectedFaceBoundary: Float32Array
  hoveredFaceBoundary: Float32Array
  selectedVertices: Vec3[]
  hoveredVertices: Vec3[]
}

const EMPTY: AssemblySelectionGeometry = {
  selectedFaces: new Float32Array(0),
  hoveredFaces: new Float32Array(0),
  selectedEdges: new Float32Array(0),
  hoveredEdges: new Float32Array(0),
  selectedFaceBoundary: new Float32Array(0),
  hoveredFaceBoundary: new Float32Array(0),
  selectedVertices: [],
  hoveredVertices: [],
}

function pushTriangle(out: number[], positions: Float32Array, tri: number): void {
  const base = tri * 9
  for (let k = 0; k < 9; k++) out.push(positions[base + k])
}

function pushSegment(out: number[], positions: Float32Array, seg: number): void {
  const base = seg * 6
  for (let k = 0; k < 6; k++) out.push(positions[base + k])
}

/** Appends a whole face's boundary loop (variable segment count, unlike the
 *  fixed-stride edge/vertex layers). */
function pushBoundary(out: number[], segments: Float32Array): void {
  for (let k = 0; k < segments.length; k++) out.push(segments[k])
}

/**
 * Split every pickable face triangle, edge segment and vertex into selected /
 * hovered / neither, keeping only the first two. Returns the shared empty result
 * when nothing is selected or hovered, so an idle scene allocates nothing.
 */
export function buildAssemblySelectionGeometry(
  pickBodies: readonly AssemblyPickBody[],
  selection: ReadonlySet<string>,
  hovered: string | null,
): AssemblySelectionGeometry {
  if (selection.size === 0 && hovered === null) return EMPTY

  const selFaces: number[] = []
  const hovFaces: number[] = []
  const selEdges: number[] = []
  const hovEdges: number[] = []
  const selFaceBoundary: number[] = []
  const hovFaceBoundary: number[] = []
  const selVerts: Vec3[] = []
  const hovVerts: Vec3[] = []

  for (const body of pickBodies) {
    const { faces, edges, vertices, faceBoundaries } = body

    if (faces) {
      const { triangleToFace, faceQueries, positions } = faces
      for (let tri = 0; tri < triangleToFace.length; tri++) {
        const query = faceQueries[triangleToFace[tri]]
        if (query === undefined) continue
        if (selection.has(query)) pushTriangle(selFaces, positions, tri)
        else if (query === hovered) pushTriangle(hovFaces, positions, tri)
      }

      if (faceBoundaries) {
        const { faceQueries: boundaryQueries } = faces
        for (const [faceIdx, segments] of faceBoundaries) {
          const query = boundaryQueries[faceIdx]
          if (query === undefined) continue
          // Selection wins over hover, same as the tint above: a face that is
          // both draws its selected-colour outline only.
          if (selection.has(query)) pushBoundary(selFaceBoundary, segments)
          else if (query === hovered) pushBoundary(hovFaceBoundary, segments)
        }
      }
    }

    if (edges) {
      const { segmentToEdge, edgeQueries, segmentPositions } = edges
      for (let seg = 0; seg < segmentToEdge.length; seg++) {
        const query = edgeQueries[segmentToEdge[seg]]
        if (query === undefined) continue
        if (selection.has(query)) pushSegment(selEdges, segmentPositions, seg)
        else if (query === hovered) pushSegment(hovEdges, segmentPositions, seg)
      }
    }

    if (vertices) {
      const { vertices: points, vertexQueries } = vertices
      points.forEach((p, i) => {
        const query = vertexQueries[i]
        if (selection.has(query)) selVerts.push(p)
        else if (query === hovered) hovVerts.push(p)
      })
    }
  }

  return {
    selectedFaces: Float32Array.from(selFaces),
    hoveredFaces: Float32Array.from(hovFaces),
    selectedEdges: Float32Array.from(selEdges),
    hoveredEdges: Float32Array.from(hovEdges),
    selectedFaceBoundary: Float32Array.from(selFaceBoundary),
    hoveredFaceBoundary: Float32Array.from(hovFaceBoundary),
    selectedVertices: selVerts,
    hoveredVertices: hovVerts,
  }
}
