// PURE LOGIC -- no Three.js, no React refs, no store reads.
// Turns the id-buffer hit at a draw press into the snap the click resolves
// against. Every drawing tool commits from this, not from the async hover: the
// hover lags a frame and a solve commit nulls it, which is why a click on a
// vertex sometimes authored no coincident.
import type { SnapKind } from '@/registry'
import { ORIGIN_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME } from '@/picking/layerNames'
import { vertexPositionAt, type SketchGeometry } from '@/utils/geometry/drawAutoConstraints'

/** The fields of the id-buffer hit a press needs. Structural on purpose: the
 *  draw plane reads them off a `ResolvedHit`, a test can state one directly. */
export interface DrawPressHit {
  layer: string
  entityKey: string
}

/** The snap fields a draw click reads, all derived from one press pixel. */
export interface DrawPressSnap {
  hoveredVertexId: string | null
  hoveredVertexPosition: [number, number] | null
  hoveredSnapKind: SnapKind | null
  hoveredSelectionId: string | null
}

const NO_PRESS_SNAP: DrawPressSnap = {
  hoveredVertexId: null,
  hoveredVertexPosition: null,
  hoveredSnapKind: null,
  hoveredSelectionId: null,
}

/**
 * Resolve the snap under a draw press. A sketch vertex names a point, so it
 * carries the position of the entity the ref names; the origin marker names a
 * point in the sketch's own frame, which is `originLocal` (never a bare [0,0]
 * on an offset or face-based plane). Every other layer names geometry to select
 * or project, never a point pair.
 *
 * A miss answers no snap at all, deliberately: falling back to the store hover
 * would let a hover from an earlier pixel claim this click.
 */
export function resolveDrawPressSnap(
  hit: DrawPressHit | null,
  originLocal: readonly [number, number],
  geo: SketchGeometry = {},
): DrawPressSnap {
  if (hit === null) return NO_PRESS_SNAP
  if (hit.layer === SKETCH_VERTEX_LAYER_NAME) {
    return {
      hoveredVertexId: hit.entityKey,
      hoveredVertexPosition: vertexPositionAt(hit.entityKey, geo),
      hoveredSnapKind: 'vertex',
      // The vertex is also the selected element: the project tool lowers a
      // foreign vertex ref to a projected point, and keeping the two fields in
      // step means no tool needs a second source for "what was picked".
      hoveredSelectionId: hit.entityKey,
    }
  }
  if (hit.layer === ORIGIN_LAYER_NAME) {
    return {
      hoveredVertexId: hit.entityKey,
      hoveredVertexPosition: [originLocal[0], originLocal[1]],
      hoveredSnapKind: 'vertex',
      hoveredSelectionId: hit.entityKey,
    }
  }
  return { ...NO_PRESS_SNAP, hoveredSelectionId: hit.entityKey }
}
