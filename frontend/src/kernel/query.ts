// The element-geometry query engine: typed Query parsing/emission plus the live ancestry
// resolver (Repository).
//
// This module is the barrel for the engine. The wire codec lives in queryWire.ts, the
// type hierarchy/coercion in queryCoerce.ts, the Repository engine in queryRepository.ts
// and the registration/eviction ops in queryAncestryOps.ts; all are re-exported here
// unchanged so existing importers keep reaching the same names through `kernel/query`.
//
// frozenset semantics: Python keys `ancestral` by a frozenset of ancestor ids and tests
// subset/superset containment hot in the drag loop. JS Set is not a value type and cannot
// be a Map key, so each entry stores both the Set (for containment) and a canonical
// sorted-join string (the Map key, deduping permutations exactly as frozenset does).

import { Repository } from './queryRepository'

export type { LocalQuery, AbsoluteQuery, AncestryQuery, Query as QueryType } from "@/types/query"

export {
  local,
  absolute,
  ancestry,
  parseQuery,
  emitWire,
  ref,
  bodyIdOf,
  parseAncestry,
  makeAncestryQuery,
  isClassifierId,
  isGeomHashId,
  isConstructionUuidId,
  constructionUuidToken,
  parseConstructionUuidId,
} from './queryWire'

export {
  Repository,
  canonical,
  isFeatureRefTag,
  setCurrentFeatureId,
  getCurrentFeatureId,
} from './queryRepository'
export type { ResolveTier } from './queryRepository'
export { AmbiguousQueryError } from './queryCoerce'
export {
  initGlobalRepo,
  evictAncestryAndRegister,
  clearBodyAncestry,
  clearConsumedBodyAncestry,
} from './queryAncestryOps'

// ─── Plane/point helpers ───

interface PlaneLike {
  origin: number[]
  x_axis: number[]
  y_axis: number[]
  normal: number[]
}

/** Query-result -> 3D point. */
export function getPoint3d(ref: Record<string, unknown>, globalRepo: Repository): number[] {
  if ("external_xy" in ref) {
    const xy = ref["external_xy"] as number[]
    const sketchId = ref["sketch_id"] as string | undefined
    if (sketchId) {
      const pt = globalRepo.elements.get("_pt_" + sketchId) as PlaneLike | undefined
      if (pt) {
        return [
          pt.origin[0] + xy[0] * pt.x_axis[0] + xy[1] * pt.y_axis[0],
          pt.origin[1] + xy[0] * pt.x_axis[1] + xy[1] * pt.y_axis[1],
          pt.origin[2] + xy[0] * pt.x_axis[2] + xy[1] * pt.y_axis[2],
        ]
      }
    }
    return [xy[0], xy[1], 0.0]
  }
  if (ref["type"] === "vertex" && "origin" in ref) return ref["origin"] as number[]
  if ("origin" in ref && !("normal" in ref)) return ref["origin"] as number[]
  if ("origin" in ref && "normal" in ref) throw new Error("reference is a plane, not a point")
  throw new Error("point reference has no coordinates")
}
