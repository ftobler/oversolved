// Face-extension helpers that outlived the slab move-face route.
//
// The direct tweak (`moveFaceTweak.ts`) does not extend neighbours: it rebuilds
// the changed edges from surface intersections. Defeature's wedge rung still
// needs a bounded analytic face on a support surface, and the shell/tessellation
// paths read edge convexity, so those two helpers stay here. The slab
// construction, cell classifier, set path and volume oracle were deleted with
// the compatibility route.

import { type DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import type { EdgeKind } from '@/types/cad'
import { TOL_MOVE_FACE_TANGENT } from '../solverConstants'
import { extendNeighbour } from './moveFaceExtend'

/** The edge convexity BRepOffset_Analyse reports, narrowed to the four the
 *  move-face rules care about. The union itself lives beside EdgeData in
 *  `types/cad.ts`, because the solve now publishes it on every edge too. */
export type { EdgeKind } from '@/types/cad'

/**
 * A large bounded face on `face`'s underlying surface. Rung 1's analytic window
 * for plane, cylinder, cone, sphere and torus; a freeform support has no
 * analytic primitive and is refused by name (defeature's wedge rung quotes it).
 * `margin` is accepted for the defeature caller's historical signature.
 */
export function extendNeighbourFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  L: number,
  margin: number = L,
): OccShape {
  return extendNeighbour(oc, scope, face, L, margin).face
}

/**
 * One `BRepOffset_Analyse_2(body, tol)` per call; the returned function reports
 * each edge's convexity. `TOL_MOVE_FACE_TANGENT` is the angular tolerance, the
 * same "tangent" the project treats a smooth join as. An edge the analyse does
 * not know reports 'other'.
 */
export function classifyFaceEdges(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
): (edge: OccShape) => EdgeKind {
  const analyse = scope.track(new oc.BRepOffset_Analyse_2(part, TOL_MOVE_FACE_TANGENT))
  const names: Record<number, EdgeKind> = {
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Convex.value]: 'convex',
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Concave.value]: 'concave',
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Tangential.value]: 'tangent',
    [oc.ChFiDS_TypeOfConcavity.ChFiDS_Other.value]: 'other',
  }
  return (edge: OccShape): EdgeKind => {
    const list = scope.track(analyse.Type(edge))
    if (list.Size() === 0) return 'other'
    return names[scope.track(list.First_1()).Type_2().value] ?? 'other'
  }
}
