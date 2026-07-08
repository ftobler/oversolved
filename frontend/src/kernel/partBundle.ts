// A PartBundle is a rev-keyed, derivable artifact built from a PartDoc by a
// transient OCC worker (the bundle builder). It carries everything an assembly
// solver needs — meshes, edge curves, and an anchor dict — so the assembly
// worker never touches OCC or runs solveLocally. The bundle is cached in
// IndexedDb keyed by (doc_id, doc_rev); a miss triggers a cold rebuild.

export type AnchorKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'line' | 'circle' | 'point'

export interface Anchor {
  kind: AnchorKind
  point: [number, number, number]
  axis: [number, number, number]
  geom_hash: string
  created_by: string
}

export interface EdgeCurve {
  id: string
  kind: 'line' | 'circle' | 'ellipse' | 'b-spline'
  point: [number, number, number]
  axis?: [number, number, number]
  radius?: number
  endpoints: [[number, number, number], [number, number, number]]
}

export interface BodyMesh {
  mesh: {
    vertices: Float32Array
    indices: Uint32Array
    faceIdsPerTriangle: Uint32Array
  }
  edges: EdgeCurve[]
}

export interface PartBundle {
  doc_id: string
  doc_rev: number
  bodies: BodyMesh[]
  anchors: Record<string, Anchor>
}
