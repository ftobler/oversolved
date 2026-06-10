// Port of `_solve_extrude` (solver_features_brep.py): the extrude leaf, the
// simplest brep producer and the first phase-2f feature. It resolves each
// profile reference to 2D loops (or a body face), builds the tool solid with
// per-entity lineage, and applies the body operation (add / cut / new).
//
// This is the wiring layer: collectExtrudeLoops (faceProfile.ts), resolveDirection
// (shared.ts), extrudeProfileWithLineage (occ/prismLineage.ts), and
// applyBodyOperation (bodyOps.ts) do the work. Like every OCC-backed leaf it
// takes (oc, scope, table) ahead of the Python (feature, globalRepo, bodyStore)
// signature; the caller owns `scope` and disposes it after ancestry registration.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { parseAncestry } from '../query'
import { faceNormal, makePrism, type Vec3 } from '../occ/primitives'
import { booleanWithHistory } from '../occ/booleans'
import { collectExtrudeLoops } from './faceProfile'
import { resolveDirection, type PlaneLike } from './shared'
import { applyBodyOperation, type BodyOperation } from './bodyOps'
import { extrudeProfileWithLineage } from '../occ/prismLineage'

type Dict = Record<string, unknown>
type Lineage = Record<string, string[]>

export interface ExtrudeResult {
  [key: string]: unknown
  status: string
  body_id: string
}

/**
 * Structural (non-index) entity tokens of a surface query (mirrors
 * `_surface_entity_ids`), sorted. Only `?...` ancestry queries carry them.
 */
function surfaceEntityIds(surface: Dict): string[] {
  const query = (surface.query as string) ?? ''
  if (!query.startsWith('?')) return []
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return []
  }
  // Dedup like Python's frozenset (parseAncestry can repeat ids) before sorting.
  return [...new Set(ids.filter((i) => i.startsWith('@') && i.includes('/')))].sort()
}

function fuse(oc: OccModule, scope: DisposeScope, a: OccShape, b: OccShape): OccShape {
  return booleanWithHistory(oc, scope, a, b, 'fuse').shape
}

/** Solve an extrude feature into the body store (mirrors `_solve_extrude`). */
export function solveExtrude(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ExtrudeResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.extrude as Dict) ?? {}
  const mergeTarget = ((sub.merge_target as string) ?? (feature.merge_target as string)) ?? null
  const merged: Dict = { ...sub, ...feature }

  const sketchRaw = merged.sketch
  const sketchRefs: string[] = Array.isArray(sketchRaw)
    ? (sketchRaw as string[]).filter((s) => s)
    : sketchRaw
      ? [sketchRaw as string]
      : []
  const distance = Number((merged.distance as number) || (merged.depth as number) || 1.0)

  if (distance === 0) throw new Error('extrude: distance must be non-zero')
  if (sketchRefs.length === 0) {
    throw new Error('extrude: requires at least one profile reference')
  }

  const allLoops: Dict[][] = []
  const cqFaces: OccShape[] = []
  let firstPt: PlaneLike | null = null
  let firstSketchId = ''
  const profileErrors: string[] = []
  const profileQueries: string[] = []
  const faceLineage: Lineage = {}
  const edgeLineage: Lineage = {}

  for (const sketchRef of sketchRefs) {
    let resolved
    try {
      resolved = collectExtrudeLoops(
        oc,
        scope,
        table,
        sketchRef,
        featureId,
        distance,
        globalRepo,
        bodyStore,
      )
    } catch (exc) {
      profileErrors.push(exc instanceof Error ? exc.message : String(exc))
      continue
    }
    if (resolved.face !== null) {
      cqFaces.push(resolved.face)
    } else {
      allLoops.push(...resolved.loops)
    }
    const topo = (globalRepo.elements.get('_topo_' + resolved.sketchId) as Dict | undefined) ?? {}
    for (const surface of (topo.surfaces as Dict[]) ?? []) {
      profileQueries.push(...surfaceEntityIds(surface))
    }
    if (firstPt === null) {
      firstPt = resolved.plane
      firstSketchId = resolved.sketchId
    }
  }

  if (profileErrors.length && cqFaces.length === 0 && allLoops.length === 0) {
    throw new Error(profileErrors.join('; '))
  }

  const bodyId = 'body_' + featureId
  const result: ExtrudeResult = { status: 'ok', body_id: bodyId }
  const operation = ((merged.operation as string) ?? 'add') as BodyOperation
  const direction = (merged.direction as string) ?? 'normal'

  let toolShape: OccShape
  if (cqFaces.length === 0 && allLoops.length === 0) {
    // No profile geometry resolved -> no part. A part-less extrude is a failed
    // extrude (surfaced as a red feature), not a silent ok. (profileErrors are
    // already empty here -- a non-empty set threw above.)
    result.status = 'error'
    result.exception = 'extrude: no closed profile found in the referenced sketch; no part created'
    result.mesh_warning = 'no closed profile found; body has no shape'
    return result
  } else if (cqFaces.length > 0 && allLoops.length === 0) {
    const faceNormalVec = faceNormal(oc, scope, cqFaces[0])
    const reverseVec = faceNormalVec.map((n) => -n) as Vec3
    if (direction === 'symmetric') {
      const half = distance / 2.0
      let tool = fuse(
        oc,
        scope,
        makePrism(oc, scope, cqFaces[0], faceNormalVec, half),
        makePrism(oc, scope, cqFaces[0], reverseVec, half),
      )
      for (const f of cqFaces.slice(1)) {
        const pos = makePrism(oc, scope, f, faceNormalVec, half)
        const neg = makePrism(oc, scope, f, reverseVec, half)
        tool = fuse(oc, scope, tool, fuse(oc, scope, pos, neg))
      }
      toolShape = tool
    } else if (direction === 'reverse') {
      let tool = makePrism(oc, scope, cqFaces[0], reverseVec, distance)
      for (const f of cqFaces.slice(1)) tool = fuse(oc, scope, tool, makePrism(oc, scope, f, reverseVec, distance))
      toolShape = tool
    } else {
      let tool = makePrism(oc, scope, cqFaces[0], faceNormalVec, distance)
      for (const f of cqFaces.slice(1)) tool = fuse(oc, scope, tool, makePrism(oc, scope, f, faceNormalVec, distance))
      toolShape = tool
    }
  } else {
    const normal = (firstPt?.normal as number[]) ?? [0, 0, 1]
    const [directionVec, effectiveDistance, effectivePlane] = resolveDirection(
      normal,
      firstPt as PlaneLike,
      direction,
      distance,
    )
    const lineage = extrudeProfileWithLineage(
      oc,
      scope,
      allLoops,
      effectivePlane,
      directionVec as Vec3,
      effectiveDistance,
      firstSketchId,
    )
    toolShape = lineage.solid
    Object.assign(faceLineage, lineage.faceLineage)
    Object.assign(edgeLineage, lineage.edgeLineage)
  }

  const opResult = applyBodyOperation(oc, scope, table, {
    toolShape,
    bodyStore,
    operation,
    mergeTarget,
    bodyId,
    featureId,
    sketchId: firstSketchId,
    opName: 'extrude',
    profileQueries,
    faceLineage,
    edgeLineage,
  })
  Object.assign(result, opResult)

  if (profileErrors.length) {
    result.status = 'partial'
    result.exception = profileErrors.join('; ')
  }

  return result
}
