// The fillet/chamfer leaf pair. Edge resolution is construction-lineage based,
// never geometry: exact ancestry-query match -> UUID match (@u| in the query +
// ancestryRepo.byUuid) -> stable ancestry + classifier match -> face query (all
// edges of a face, resolved by face UUID). Geometry-based tiers (descriptor and
// geom-hash) were deliberately dropped so resolution survives geometry edits.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape, OccSubShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body, BrepDiff } from '../types3d'
import { Repository, ref, makeAncestryQuery, parseAncestry, bodyIdOf, isClassifierId, constructionUuidToken } from '../query'
import { edgeGeometryHash, faceGeometryHash, geometryClassifiers } from '../geomHash'
import { bestDescriptorMatch, type GeomDescriptor } from '../geomDescriptor'
import { resolveBody, resolveBodyIds } from './shared'
import { resplitBody } from './bodySplit'
import { bodyFrame, edgeRepresentativePoint } from '../occ/tessellation'
import { faceCentroid, faceNormal, edgeToGeom, type Vec3 } from '../occ/primitives'
import { linearHandle, type FeatureHandle } from './featureHandles'
import {
  applyFilletWithLineage,
  applyChamferWithLineage,
  type EdgeModifierResult,
  type OldNames,
} from '../occ/edgeModifier'

type Dict = Record<string, unknown>

interface EdgeFeatureResult {
  [key: string]: unknown
  status: string
  body_id: string
  body_ids: string[]
}

export interface EdgeIndex {
  queryToEdge: Map<string, OccShape>
  // Query strings claimed by more than one distinct edge (a non-unique query,
  // e.g. an edge lacking a construction @u| uuid). The exact-match tier refuses
  // these rather than last-wins onto an arbitrary edge -- see resolveEdgesWithIndex.
  ambiguousQueries: Set<string>
  ancestryRepo: Repository
}

/** Payload registered per edge in the ancestry repo; carries the OCC shape back out. */
interface AncestryEdgePayload {
  type: string
  classifiers: string[]
  shape: OccShape
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

/**
 * Register an edge under its exact-match query, guarding query uniqueness.
 * When a second DISTINCT edge claims a query already in the map, the query is
 * non-unique (typically an edge lacking a construction @u| uuid): record it in
 * `ambiguous` so the exact-match tier later refuses it, rather than silently
 * overwriting -- last-wins would actuate the fillet on an arbitrary
 * last-in-OCC-order edge (fail-wrong). Mirrors the AmbiguousQueryError fail-safe
 * of resolveByStableAncestry, now applied to the exact-match tier too.
 */
export function registerExactEdge(
  queryToEdge: Map<string, OccShape>,
  ambiguous: Set<string>,
  query: string,
  edge: OccShape,
): void {
  const prior = queryToEdge.get(query)
  if (prior !== undefined && !(prior as OccSubShape).IsSame(edge as OccSubShape)) {
    ambiguous.add(query)
  }
  queryToEdge.set(query, edge)
}

/** Build the per-body edge index for fillet/chamfer edge resolution. */
function buildEdgeIndex(oc: OccModule, scope: DisposeScope, table: HandleTable, body: Body): EdgeIndex {
  const queryToEdge = new Map<string, OccShape>()
  const ambiguousQueries = new Set<string>()
  const ancestryRepo = new Repository()
  if (body.shape === null) return { queryToEdge, ambiguousQueries, ancestryRepo }
  const shape = table.get<OccShape>(body.shape)

  const uniq: OccShape[] = []
  for (const e of exploreEdges(oc, scope, shape)) {
    if (uniq.some((u) => (u as OccSubShape).IsSame(e as OccSubShape))) continue
    uniq.push(e)
  }

  const hasModifier =
    body.brep_diff !== null && body.modified_by.length > 0 && body.modified_by[body.modified_by.length - 1] !== body.created_by
  const newEdgeHashes = hasModifier ? brepDiffNewEdgeHashes(oc, scope, body.brep_diff) : new Set<string>()
  const { center, half } = bodyFrame(oc, scope, shape)

  uniq.forEach((te, idx) => {
    const { ed } = edgeToGeom(oc, scope, te)
    const edgeType = ed.kind === 'line' ? 'straightedge' : 'edge'
    const geomHash = edgeGeometryHash(ed as unknown as Record<string, unknown>)
    if (body.created_by) {
      let edgeCreatedBy = body.created_by
      if (newEdgeHashes.has(geomHash)) edgeCreatedBy = body.modified_by[body.modified_by.length - 1]
      const uuid = body.edge_names?.[geomHash] ?? null
      const pt = edgeRepresentativePoint(ed)
      const classifiers = pt ? geometryClassifiers(pt, center, half) : []
      const ids: string[] = []
      if (uuid) ids.push(constructionUuidToken(uuid))
      ids.push(ref(edgeCreatedBy), ref(body.id))
      const ancestryTokens = (uuid && body.edge_ancestry) ? (body.edge_ancestry[uuid] ?? null) : null
      if (ancestryTokens && ancestryTokens.length) ids.push(...ancestryTokens)
      else if (body.profile_queries.length > 0) ids.push(...body.profile_queries)
      if (classifiers.length) ids.push(...classifiers.map(ref))
      registerExactEdge(queryToEdge, ambiguousQueries, makeAncestryQuery(ids, edgeType), te)

      const stableIds = ids.filter((t) => !isClassifierId(t))
      if (edgeCreatedBy !== body.created_by) stableIds.push(ref(body.created_by))
      const payload: AncestryEdgePayload = { type: edgeType, classifiers, shape: te }
      ancestryRepo.registerAncestor(stableIds, payload, uuid)
    }
    queryToEdge.set(`?${body.id}:edge:${idx}`, te)
  })

  return { queryToEdge, ambiguousQueries, ancestryRepo }
}

/**
 * Descriptor-tier face picker (the @gdf| half of `resolveFaceToEdges`).
 * Pure: returns the winning candidate or undefined when the match is
 * tight-ambiguous or a near-tie (fail-safe -- the caller returns no edges
 * rather than filleting the wrong face's edges). Extracted so the refusal
 * contract can be unit-tested without OCC.
 */
export function pickFaceByDescriptor<T>(
  qd: GeomDescriptor,
  candidates: Array<[T, GeomDescriptor]>,
): T | undefined {
  return bestDescriptorMatch(qd, candidates)
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
  if (body.shape === null) return []
  const shape = table.get<OccShape>(body.shape)

  const uuidTok = ids.find((i) => i.startsWith('@u|'))
  const faceUuid = uuidTok !== undefined ? uuidTok.slice(3) : null
  if (faceUuid !== null && body.face_names) {
    for (const face of exploreFaces(oc, scope, shape)) {
      const gh = faceGeometryHash(
        faceCentroid(oc, scope, face),
        faceNormal(oc, scope, face),
      )
      if (body.face_names[gh] === faceUuid) return exploreEdges(oc, scope, face)
    }
  }
  return []
}

/** Resolve edge queries against a prebuilt index. */
export function resolveEdgesWithIndex(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
  index: EdgeIndex,
  edgeQueries: string[],
  bodyStore: Record<string, unknown> | null = null,
): OccShape[] {
  const result: OccShape[] = []
  const addUnique = (e: OccShape): void => {
    if (!result.some((r) => (r as OccSubShape).IsSame(e as OccSubShape))) result.push(e)
  }

  const isFaceQuery = (q: string): boolean => {
    try {
      const [, typeRestriction] = parseAncestry(q)
      return typeRestriction === 'face' || typeRestriction === 'flatface' || typeRestriction === 'cylinderface'
    } catch {
      return false
    }
  }

  for (const q of edgeQueries) {
    // An ambiguous exact hit (a query claimed by 2+ distinct edges) is refused,
    // not guessed: treat it as a miss so it falls through to the ancestry tier,
    // which fails safe on the same lineage rather than filleting the wrong edge.
    let edge = index.ambiguousQueries.has(q) ? undefined : index.queryToEdge.get(q)
    if (edge === undefined && q.startsWith('?') && !isFaceQuery(q)) {
      edge = resolveByStableAncestry(index.ancestryRepo, q, bodyStore)
    }
    if (edge === undefined && isFaceQuery(q)) {
      for (const fe of resolveFaceToEdges(oc, scope, table, q, body)) addUnique(fe)
    }
    if (edge !== undefined) addUnique(edge)
  }
  return result
}

/**
 * Stable-ancestry tier: resolve a stored query whose gedge_ hash no longer
 * matches any current edge (the edge moved when an upstream dimension changed)
 * by its geometry-independent tokens -- creating feature, body, sketch-entity
 * lineage -- with classifiers narrowing ancestral siblings (e.g. the two seam
 * edges of overlapping extruded circles, distinguished only by @cls_yp/@cls_yn).
 * An ambiguous match stays unresolved: fail safe over filleting the wrong edge.
 */
function resolveByStableAncestry(
  repo: Repository,
  q: string,
  bodyStore: Record<string, unknown> | null = null,
): OccShape | undefined {
  try {
    const resolved = repo.query(q, null, bodyStore)
    if (resolved !== null && typeof resolved === 'object' && 'shape' in resolved) {
      const payload = resolved as AncestryEdgePayload
      // The repo's classifier tier only runs on 2+ candidates, so a lone
      // lineage-sharing sibling can come back when the true edge dropped out
      // of the candidate set. Validate the stored spatial role before
      // actuating: an unmatched classifier means unresolved, not a guess.
      const [ids] = parseAncestry(q)
      const wanted = ids.filter(isClassifierId).map((i) => i.slice(1))
      if (wanted.every((c) => payload.classifiers.includes(c))) return payload.shape
    }
  } catch {
    // AmbiguousQueryError or a malformed ancestry string: leave unresolved
  }
  return undefined
}

/** Resolve edge queries to OCC edges on a body (mirrors `_resolve_fillet_edges`). */
export function resolveFilletEdges(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
  edgeQueries: string[],
  bodyStore: Record<string, unknown> | null = null,
): OccShape[] {
  if (body.shape === null || edgeQueries.length === 0) return []
  return resolveEdgesWithIndex(oc, scope, table, body, buildEdgeIndex(oc, scope, table, body), edgeQueries, bodyStore)
}

type ApplyFn = (
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  oldNames: OldNames | null,
) => EdgeModifierResult

/**
 * Grab point + outward direction for the editing handle of an edge modifier:
 * the midpoint of the picked edge, pulling along the average normal of its two
 * adjacent faces (the direction a growing fillet/chamfer visually expands in).
 * Computed on the PRE-modifier shape, where the picked edge still exists.
 */
function edgeHandleGeometry(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edge: OccShape,
): { anchor: Vec3; direction: Vec3 } | null {
  const ad = scope.track(new oc.BRepAdaptor_Curve_2(edge))
  const mid = ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2)
  const anchor: Vec3 = [mid.X(), mid.Y(), mid.Z()]

  const normals: Vec3[] = []
  for (const face of exploreFaces(oc, scope, shape)) {
    const owns = exploreEdges(oc, scope, face).some((e) =>
      (e as OccSubShape).IsSame(edge as OccSubShape))
    if (!owns) continue
    normals.push(faceNormal(oc, scope, face))
    if (normals.length === 2) break
  }
  if (normals.length === 0) return null
  const sum: Vec3 = normals.reduce<Vec3>((a, n) => [a[0] + n[0], a[1] + n[1], a[2] + n[2]], [0, 0, 0])
  const len = Math.hypot(sum[0], sum[1], sum[2])
  // Opposing normals (tangent faces) collapse the average; fall back to one side.
  const dir = len > 1e-9 ? ([sum[0] / len, sum[1] / len, sum[2] / len] as Vec3) : normals[0]
  return { anchor, direction: dir }
}

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
  makeHandle?: (anchor: Vec3, direction: Vec3) => FeatureHandle | null,
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
    return resolveEdgesWithIndex(oc, scope, table, body, indexFor(bid), [q], bodyStore).length > 0
  }

  const groups = new Map<string, string[]>()
  const unresolved: string[] = []
  if (sourceBody) {
    // `resolveBodyIds` rather than a local created_by scan: a feature ref can
    // name several bodies, and every edge would otherwise be grouped onto
    // whichever sibling came first. A ref matching nothing stays as-is, so the
    // group lookup below reports it as unresolved.
    let resolvedSrc = sourceBody
    if (!(sourceBody in bodyStore)) {
      const ids = resolveBodyIds(sourceBody, bodyStore)
      if (ids.length > 1) {
        throw new Error(
          `${featureKind}: source body '${sourceBody}' names ${ids.length} bodies ` +
          `(${ids.join(', ')}); pick one`,
        )
      }
      if (ids.length === 1) resolvedSrc = ids[0]
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
  let handle: FeatureHandle | null = null
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

    const topoEdges = resolveEdgesWithIndex(oc, scope, table, body, indexFor(bid), qlist, bodyStore)
    if (topoEdges.length === 0) {
      unresolved.push(...qlist)
      continue
    }

    // Editing handle geometry from the first picked edge, taken before the
    // modifier consumes it.
    if (handle === null && makeHandle !== undefined) {
      const geom = edgeHandleGeometry(oc, scope, oldShape, topoEdges[0])
      if (geom !== null) handle = makeHandle(geom.anchor, geom.direction)
    }

    const wantNames = Object.keys(body.face_names ?? {}).length > 0 || Object.keys(body.edge_names ?? {}).length > 0
    const oldNames: OldNames | null = wantNames
      ? {
          createdBy: featureId,
          faceNames: body.face_names ?? {},
          edgeNames: body.edge_names ?? {},
          faceAncestry: body.face_ancestry ?? {},
          edgeAncestry: body.edge_ancestry ?? {},
        }
      : null
    const res = applyFn(oc, scope, oldShape, topoEdges, oldNames)

    if (res.names !== null) {
      body.face_names = res.names.faceNames
      body.edge_names = res.names.edgeNames
      body.face_ancestry = res.names.faceAncestry
      body.edge_ancestry = res.names.edgeAncestry
    }
    // A chamfer removes material and can sever a thin web, so even this leaf
    // can turn one body into two.
    applied.push(...resplitBody(oc, scope, table, bodyStore, body, scope.track(res.shape), featureId))
    body.brep_diff = res.diff
    body.modified_by.push(featureId)
  }

  if (applied.length === 0) throw new Error(`${featureKind}: no edges resolved`)

  if (unresolved.length > 0) {
    return {
      status: 'partial',
      body_id: applied[0],
      body_ids: applied,
      exception: `${featureKind}: ${unresolved.length} edge(s) could not be resolved`,
      ...(handle !== null && { handle }),
    }
  }
  return { status: 'ok', body_id: applied[0], body_ids: applied, ...(handle !== null && { handle }) }
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
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('fillet: radius must be positive')
  return applyEdgeFeature(oc, scope, table, merged, bodyStore, 'fillet', (o, s, shape, edges, nm) =>
    applyFilletWithLineage(o, s, shape, radius, edges, nm),
  // unit_scale=1 here is a 1:1 UX approximation: dragging along the
  // face-bisector normal is not the exact radius/bisector-travel relation
  // (r = d_bisector * sin(theta/2) for the included edge angle), but it is
  // close enough for a freehand tweak and re-anchors on every rebuild.
  (anchor, direction) => linearHandle('radius', anchor, direction, radius),
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
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('chamfer: distance must be positive')
  return applyEdgeFeature(oc, scope, table, merged, bodyStore, 'chamfer', (o, s, shape, edges, nm) =>
    applyChamferWithLineage(o, s, shape, distance, edges, chamferMode, angle, nm),
  // See fillet above: unit_scale=1 is a 1:1 UX approximation along the
  // face-bisector normal, not the exact chamfer geometry relation.
  (anchor, direction) => linearHandle('distance', anchor, direction, distance),
  )
}
