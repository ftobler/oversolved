// A measurement pick resolved to the OCC sub-shape the worker measures.
//
// The main thread names a pick by the index it carries in the SOLVE's render
// arrays, and those arrays are sorted, not canonical (kernel/occ/tessellation.ts):
//
//   face    renderFaceRows  (flat-before-curved, by normal and centroid)
//   edge    renderEdgeRows  (by curve kind and geometry, degenerated dropped)
//   vertex  canonicalVertices (the explorer order; solidToVertices walks it)
//   body    the solid itself
//
// So a face or an edge index is NOT a canonical sub-shape index, and reading one
// as the other would measure a neighbour. Faces and edges therefore go through
// the same sorted-row walks the render pass uses, which share the comparator
// rather than restating the order.
//
// The resolver is read-only: it reads sub-shapes of a shape the solve holds and
// allocates its proxies in the caller's DisposeScope.
import { canonicalEdges, canonicalVertices } from './occ/bodyNames'
import { renderEdgeRows, renderFaceRows } from './occ/tessellation'
import type { DisposeScope } from './occ/disposeScope'
import type { HandleTable } from './occ/handleTable'
import type { OccModule, OccShape } from './occ/occTypes'
import type { Body } from './types3d'
import type { MeasurePickRef } from './worker/solverProtocol'

/**
 * The body store a measure request names, resolved to one of its shapes. Null
 * when the body is not in the set or its element index is out of range: the
 * caller reports that as `measure unresolved` rather than measuring a neighbour.
 */
export function resolveMeasurePick(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodies: Record<string, Body>,
  pick: MeasurePickRef,
): OccShape | null {
  const body = bodies[pick.bodyId]
  if (!body || body.shape == null) return null
  const solid = table.get<OccShape>(body.shape)
  if (pick.kind === 'body') return solid

  if (pick.kind === 'vertex') {
    return canonicalVertices(oc, scope, solid)[pick.index] ?? null
  }

  if (pick.kind === 'face') {
    return renderFaceRows(oc, scope, solid)[pick.index]?.shape ?? null
  }

  const row = renderEdgeRows(oc, scope, solid)[pick.index]
  if (!row) return null
  // The row's canonical index is the key into the canonical edge array, which
  // is where the untrimmed sub-shape with a usable geometry lives.
  return canonicalEdges(oc, scope, solid)[row.canon] ?? null
}
