
import type { OccHandle } from './occ/handleTable'

/** History from an OCC boolean operation, classifying output sub-shapes. */
export interface BrepDiff {
  new_faces: unknown[]
  inherited_faces: unknown[]
  new_edges: unknown[]
  inherited_edges: unknown[]
  modified_input_faces: unknown[]
  deleted_input_faces: unknown[]
  modified_input_edges: unknown[]
  deleted_input_edges: unknown[]
}

/** A BrepDiff with every classification list empty. */
export function emptyBrepDiff(): BrepDiff {
  return {
    new_faces: [],
    inherited_faces: [],
    new_edges: [],
    inherited_edges: [],
    modified_input_faces: [],
    deleted_input_faces: [],
    modified_input_edges: [],
    deleted_input_edges: [],
  }
}

/** A 3D solid body tracked through the feature stack. */
export interface Body {
  id: string
  created_by: string
  modified_by: string[]
  // OCC handle (opaque) or null for bodies without geometry.
  shape: OccHandle | null
  sketch_id: string
  brep_diff: BrepDiff | null
  profile_queries: string[]
  /**
   * Construction-by-name identity (query-naming-by-construction). `face_names`/
   * `edge_names` map the in-build copy-stable geom-hash key to a construction
   * UUID; `face_ancestry`/`edge_ancestry` map each UUID to its ancestral fallback
   * tokens. The geom-hash key is a transient in-build join only; it never enters
   * a persisted query.
   */
  face_names?: Record<string, string>
  edge_names?: Record<string, string>
  face_ancestry?: Record<string, string[]>
  edge_ancestry?: Record<string, string[]>
  /**
   * True when the body's geometry originates from a STEP import (as opposed to
   * native modelling). Imported B-rep carries freeform faces and STEP tolerances
   * that make ShapeUpgrade_UnifySameDomain's face fold spin uncatchably, so
   * booleans against an imported body skip the face merge. Propagated across
   * modifications and cut splits; native tools never set it.
   */
  imported?: boolean
}

/** Cached state at a single feature boundary for partial rebuild. */
export interface FeatureCheckpoint {
  spec: Record<string, unknown>
  result: Record<string, unknown>
  repo_snapshot: Record<string, unknown>
  body_store_snapshot: Record<string, Body>
  bodies_snapshot: Record<string, unknown>
}

/** Checkpoint cache passed from one build() call to the next. It is the
 *  solver's private state; the main-thread copy (the `_build_state` stub) is
 *  shared and must never be mutated by consumers. */
export interface BuildState {
  feature_order: string[]
  checkpoints: Record<string, FeatureCheckpoint>
}

/** A right-handed 3D coordinate frame. */
export interface Frame3D {
  origin: [number, number, number]
  x_axis: [number, number, number]
  y_axis: [number, number, number]
  normal: [number, number, number]
}

export function frameFromPlaneTransform(pt: {
  rotation: number[]
  origin: number[]
}): Frame3D {
  const r = pt.rotation
  return {
    origin: [pt.origin[0], pt.origin[1], pt.origin[2]],
    x_axis: [r[0], r[1], r[2]],
    y_axis: [r[3], r[4], r[5]],
    normal: [r[6], r[7], r[8]],
  }
}

export function frameToPlaneTransform(f: Frame3D): {
  rotation: number[]
  origin: number[]
} {
  return {
    rotation: f.x_axis.concat(f.y_axis, f.normal),
    origin: f.origin,
  }
}

/** Compute orthonormal (x_axis, y_axis) for a plane given its unit normal. */
export function normalToFrame(normal: [number, number, number]): {
  x_axis: [number, number, number]
  y_axis: [number, number, number]
} {
  const [nx, ny, nz] = normal
  let ax = 0.0
  let ay = 0.0
  let az = 1.0
  if (Math.abs(nz) >= 0.9) {
    ax = 1.0
    ay = 0.0
    az = 0.0
  }
  let cx = ny * az - nz * ay
  let cy = nz * ax - nx * az
  let cz = nx * ay - ny * ax
  const mag = Math.sqrt(cx * cx + cy * cy + cz * cz)
  if (mag > 1e-12) {
    cx /= mag
    cy /= mag
    cz /= mag
  } else {
    cx = 1.0
    cy = 0.0
    cz = 0.0
  }
  const yx = ny * cz - nz * cy
  const yy = nz * cx - nx * cz
  const yz = nx * cy - ny * cx
  return {
    x_axis: [cx, cy, cz],
    y_axis: [yx, yy, yz],
  }
}

/** Local 2D coordinates of a 3D world point on a sketch plane: the in-plane
 *  components of (world - frame.origin) along the frame's x/y axes. A point off
 *  the plane projects to the foot of its perpendicular. Used to express the
 *  document origin (0,0,0) in a sketch's local frame -- only [0,0] when the
 *  plane passes through the global origin (the builtin planes), nonzero for a
 *  sketch on an offset/projected face. */
export function projectWorldToFrame(
  world: readonly [number, number, number],
  frame: Frame3D,
): [number, number] {
  const d: [number, number, number] = [
    world[0] - frame.origin[0],
    world[1] - frame.origin[1],
    world[2] - frame.origin[2],
  ]
  return [
    d[0] * frame.x_axis[0] + d[1] * frame.x_axis[1] + d[2] * frame.x_axis[2],
    d[0] * frame.y_axis[0] + d[1] * frame.y_axis[1] + d[2] * frame.y_axis[2],
  ]
}
