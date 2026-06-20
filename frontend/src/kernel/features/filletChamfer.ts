// The fillet/chamfer leaf pair. It routes each edge query to the body that owns it (the
// @body_<id> token is only a hint -- geometry wins), resolves the queries to OCC edges via a
// per-body edge index, applies the modifier with lineage, and updates the body store in place.
//
// The OCC modifier producer lives in occ/edgeModifier.ts. Edge resolution mirrors the Python
// three-tier scheme: exact ancestry-query match -> geometry-hash match (ignoring a stale @body
// token) -> face query (all edges of a face).

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import type { Repository } from '../query'
import { ref, makeAncestryQuery, parseAncestry, bodyIdOf } from '../query'
import { edgeGeometryHash, faceGeometryHash, isGeomKeyedLineage } from '../geomHash'
import { edgeLineageTokens } from '../faceQuery'
import { resolveBody } from './shared'
import { faceCentroid, faceNormal, edgeToGeom } from '../occ/primitives'
import {
  applyFilletWithLineage,
  applyFilletWithDiff,
  applyChamferWithLineage,
  applyChamferWithDiff,
  type EdgeModifierResult,
} from '../occ/edgeModifier'

type Dict = Record<string, unknown>

export interface EdgeFeatureResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
}

interface EdgeIndex {
  queryToEdge: Map<string, OccShape>
  hashToEdge: Map<string, OccShape>
}

function exploreEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  return out
}

function exploreFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Face_1(exp.Current())))
  return out
}

/** geom hashes of body.brep_diff.new_edges (mirrors `_brep_diff_new_edge_hashes`). */
function brepDiffNewEdgeHashes(oc: OccModule, scope: DisposeScope, diff: BrepDiff | null): Set<string> {
  const out = new Set<string>()
  if (diff === null || diff.new_edges.length === 0) return out
  for (const raw of diff.new_edges) {
    try {
      const { ed } = edgeToGeom(oc, scope, raw as OccShape)
      if (ed.kind === 'line') {
        const s = (ed as { start: number[] }).start
        const e = (ed as { end: number[] }).end
        out.add(edgeGeometryHash({ kind: 'line', start: s, end: e }))
        out.add(edgeGeometryHash({ kind: 'line', start: e, end: s }))
      } else if (ed.kind === 'circle' || ed.kind === 'arc') {
        out.add(edgeGeometryHash(ed as unknown as Record<string, unknown>))
      }
    } catch {
      // skip un-hashable edges (splines, freed handles)
    }
  }
  return out
}

/** Build the per-body edge index (mirrors `_build_edge_index`). */
function buildEdgeIndex(oc: OccModule, scope: DisposeScope, table: HandleTable, body: Body): EdgeIndex {
  const queryToEdge = new Map<string, OccShape>()
  const hashToEdge = new Map<string, OccShape>()
  if (body.shape === null) return { queryToEdge, hashToEdge }
  const shape = table.get<OccShape>(body.shape)

  const uniq: OccShape[] = []
  for (const e of exploreEdges(oc, scope, shape)) {
    if (uniq.some((u) => (u as OccSubShape).IsSame(e as OccSubShape))) continue
    uniq.push(e)
  }

  const hasModifier =
    body.brep_diff !== null && body.modified_by.length > 0 && body.modified_by[body.modified_by.length - 1] !== body.created_by
  const newEdgeHashes = hasModifier ? brepDiffNewEdgeHashes(oc, scope, body.brep_diff) : new Set<string>()

  uniq.forEach((te, idx) => {
    const { ed } = edgeToGeom(oc, scope, te)
    const edgeType = ed.kind === 'line' ? 'straightedge' : 'edge'
    const geomHash = edgeGeometryHash(ed as unknown as Record<string, unknown>)
    if (!hashToEdge.has(geomHash)) hashToEdge.set(geomHash, te)
    if (body.created_by) {
      let edgeCreatedBy = body.created_by
      if (newEdgeHashes.has(geomHash)) edgeCreatedBy = body.modified_by[body.modified_by.length - 1]
      const ids = [ref(geomHash), ref(edgeCreatedBy), ref(body.id)]
      if (isGeomKeyedLineage(body.edge_lineage, 'gedge_')) {
        ids.push(...edgeLineageTokens(ed as unknown as Record<string, unknown>, body.edge_lineage))
      } else if (body.profile_queries.length > 0) {
        ids.push(...body.profile_queries)
      }
      queryToEdge.set(makeAncestryQuery(ids, edgeType), te)
    }
    queryToEdge.set(`?${body.id}:edge:${idx}`, te)
  })

  return { queryToEdge, hashToEdge }
}

/** Resolve a face ancestry query to all OCC edges of the matching face. */
function resolveFaceToEdges(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  q: string,
  body: Body,
): OccShape[] {
  let ids: string[]
  try {
    ;[ids] = parseAncestry(q)
  } catch {
    return []
  }
  const targetHash = ids.find((i) => i.startsWith('@gface_'))
  if (targetHash === undefined || body.shape === null) return []
  const shape = table.get<OccShape>(body.shape)
  for (const face of exploreFaces(oc, scope, shape)) {
    const gh = faceGeometryHash(faceCentroid(oc, scope, face), faceNormal(oc, scope, face))
    if (ref(gh) === targetHash) return exploreEdges(oc, scope, face)
  }
  return []
}

/** Resolve edge queries against a prebuilt index (mirrors `_resolve_edges_with_index`). */
function resolveEdgesWithIndex(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
  index: EdgeIndex,
  edgeQueries: string[],
): OccShape[] {
  const result: OccShape[] = []
  const addUnique = (e: OccShape): void => {
    if (!result.some((r) => (r as OccSubShape).IsSame(e as OccSubShape))) result.push(e)
  }

  for (const q of edgeQueries) {
    let edge = index.queryToEdge.get(q)
    if (edge === undefined && q.startsWith('?')) {
      try {
        const [ids] = parseAncestry(q)
        for (const id of ids) {
          if (id.startsWith('@gedge_')) {
            edge = index.hashToEdge.get(id.slice(1))
            if (edge !== undefined) break
          }
        }
      } catch {
        // ignore geom-hash resolution failure
      }
    }
    if (edge === undefined && q.includes('gface_')) {
      for (const fe of resolveFaceToEdges(oc, scope, table, q, body)) addUnique(fe)
    }
    if (edge !== undefined) addUnique(edge)
  }
  return result
}

/** Resolve edge queries to OCC edges on a body (mirrors `_resolve_fillet_edges`). */
export function resolveFilletEdges(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
  edgeQueries: string[],
): OccShape[] {
  if (body.shape === null || edgeQueries.length === 0) return []
  return resolveEdgesWithIndex(oc, scope, table, body, buildEdgeIndex(oc, scope, table, body), edgeQueries)
}

type ApplyFn = (
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  withLineage: boolean,
  faceLineage: Record<string, string[]>,
  edgeLineage: Record<string, string[]>,
) => EdgeModifierResult

/**
 * Shared body-resolution + edge-application for fillet and chamfer (mirrors
 * `_apply_edge_feature`). Throws ValueError-style errors for the caller to wrap.
 */
function applyEdgeFeature(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  bodyStore: Record<string, Body>,
  featureKind: string,
  applyFn: ApplyFn,
): EdgeFeatureResult {
  const featureId = (feature.id as string) ?? ''
  const edges = (feature.edges as string[]) ?? []
  if (edges.length === 0) throw new Error(`${featureKind}: requires at least one edge`)
  if (Object.keys(bodyStore).length === 0) throw new Error(`${featureKind}: no bodies in body_store`)

  const sourceBody = (feature.source_body as string) ?? ''
  const indexCache = new Map<string, EdgeIndex>()
  const indexFor = (bid: string): EdgeIndex => {
    let idx = indexCache.get(bid)
    if (idx === undefined) {
      idx = buildEdgeIndex(oc, scope, table, bodyStore[bid])
      indexCache.set(bid, idx)
    }
    return idx
  }
  const contains = (bid: string, q: string): boolean => {
    const body = bodyStore[bid]
    if (body === undefined || body.shape === null) return false
    return resolveEdgesWithIndex(oc, scope, table, body, indexFor(bid), [q]).length > 0
  }

  const groups = new Map<string, string[]>()
  const unresolved: string[] = []
  if (sourceBody) {
    let resolvedSrc = sourceBody
    if (!(sourceBody in bodyStore)) {
      for (const [bid, body] of Object.entries(bodyStore)) {
        if (body.created_by === sourceBody) {
          resolvedSrc = bid
          break
        }
      }
    }
    groups.set(resolvedSrc, [...edges])
  } else {
    for (const q of edges) {
      let named = bodyIdOf(q, bodyStore)
      const isDefault = named === null && Object.keys(bodyStore).length === 1
      if (isDefault) named = Object.keys(bodyStore)[0]
      let target: string | null = null
      if (named && named in bodyStore && contains(named, q)) {
        target = named
      } else {
        for (const bid of Object.keys(bodyStore)) {
          if (bid !== named && contains(bid, q)) {
            target = bid
            break
          }
        }
      }
      if (target === null && named !== null && named in bodyStore && !isDefault) target = named
      if (target === null) {
        unresolved.push(q)
        continue
      }
      groups.set(target, [...(groups.get(target) ?? []), q])
    }
  }

  const applied: string[] = []
  for (const [bid, qlist] of groups) {
    let body: Body
    try {
      body = resolveBody(bid, bodyStore)
    } catch {
      unresolved.push(...qlist)
      continue
    }
    if (body.shape === null) {
      unresolved.push(...qlist)
      continue
    }
    const oldShape = table.get<OccShape>(body.shape)
    try {
      if ((oldShape as unknown as { IsNull(): boolean }).IsNull()) {
        unresolved.push(...qlist)
        continue
      }
    } catch {
      unresolved.push(...qlist)
      continue
    }

    const topoEdges = resolveEdgesWithIndex(oc, scope, table, body, indexFor(bid), qlist)
    if (topoEdges.length === 0) {
      unresolved.push(...qlist)
      continue
    }

    const wantLineage = Object.keys(body.face_lineage).length > 0 || Object.keys(body.edge_lineage).length > 0
    const res = applyFn(oc, scope, oldShape, topoEdges, wantLineage, body.face_lineage, body.edge_lineage)

    const oldHandle = body.shape
    scope.track(res.shape)
    body.shape = table.register(scope.detach(res.shape), body.created_by)
    table.release(oldHandle)
    if (res.faceLineage !== null) body.face_lineage = res.faceLineage
    if (res.edgeLineage !== null) body.edge_lineage = res.edgeLineage
    body.brep_diff = res.diff
    body.modified_by.push(featureId)
    applied.push(body.id)
  }

  if (applied.length === 0) throw new Error(`${featureKind}: no edges resolved`)

  if (unresolved.length > 0) {
    return {
      status: 'partial',
      body_id: applied[0],
      body_ids: applied,
      exception: `${featureKind}: ${unresolved.length} edge(s) could not be resolved`,
    }
  }
  return { status: 'ok', body_id: applied[0], body_ids: applied }
}

/** Solve a fillet feature (mirrors `_solve_fillet`). */
export function solveFillet(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): EdgeFeatureResult {
  const sub = (feature.fillet as Dict) ?? {}
  const merged: Dict = { ...sub, ...feature }
  const radiusRaw = merged.radius
  const radius = Number(radiusRaw !== undefined && radiusRaw !== null ? radiusRaw : 1.0)
  if (radius <= 0) throw new Error('fillet: radius must be positive')
  return applyEdgeFeature(oc, scope, table, merged, bodyStore, 'fillet', (o, s, shape, edges, withLineage, fl, el) =>
    withLineage
      ? applyFilletWithLineage(o, s, shape, radius, edges, fl, el)
      : applyFilletWithDiff(o, s, shape, radius, edges),
  )
}

/** Solve a chamfer feature (mirrors `_solve_chamfer`). */
export function solveChamfer(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  _globalRepo: Repository,
  bodyStore: Record<string, Body>,
): EdgeFeatureResult {
  const sub = (feature.chamfer as Dict) ?? {}
  const chamferMode = (sub.kind as string) ?? 'distance'
  const merged: Dict = { ...sub, ...feature }
  const distanceRaw = merged.distance
  const distance = Number(distanceRaw !== undefined && distanceRaw !== null ? distanceRaw : 1.0)
  const angleRaw = merged.angle
  const angle = Number(angleRaw !== undefined && angleRaw !== null ? angleRaw : 45.0)
  if (distance <= 0) throw new Error('chamfer: distance must be positive')
  return applyEdgeFeature(oc, scope, table, merged, bodyStore, 'chamfer', (o, s, shape, edges, withLineage, fl, el) =>
    withLineage
      ? applyChamferWithLineage(o, s, shape, distance, edges, chamferMode, angle, fl, el)
      : applyChamferWithDiff(o, s, shape, distance, edges, chamferMode, angle),
  )
}
