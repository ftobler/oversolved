// Face-query resolution shared by the shell leaf and (in principle) any other
// consumer that picks faces by construction. Mirrors the edge index
// (features/filletChamfer.ts): the construction-UUID tier resolves a query's
// `@u|<uuid>` token against the body's `face_uuids` in canonical order, then a
// per-body Repository recovers a face whose UUID died by its stable ancestry
// tokens plus classifiers. An ambiguous match stays unresolved -- never a guess.

import type { DisposeScope } from '../../occ/disposeScope'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { HandleTable } from '../../occ/handleTable'
import type { Body } from '../../types3d'
import { Repository, AmbiguousQueryError, ref, parseAncestry, constructionUuidToken, isClassifierId, bodyIdOf } from '../../query'
import { canonicalFaces, assertAligned } from '../../occ/bodyNames'
import { faceCentroid, faceSurfaceType, type Vec3 } from '../../occ/primitives'
import { geometryClassifiers } from '../../geomHash'
import { bodyFrame } from '../../occ/tessellation'

/** Payload registered per face in the ancestry repo; carries the OCC shape out. */
interface FaceAncestryPayload {
  type: string
  classifiers: string[]
  shape: OccShape
}

/** The per-body face lookup: UUID -> face, plus the stable-ancestry fallback. */
export interface FaceIndex {
  byUuid: Map<string, OccShape>
  ancestryRepo: Repository
}

/** Build the per-body face index for construction-based face resolution. */
export function buildFaceIndex(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  body: Body,
): FaceIndex {
  const byUuid = new Map<string, OccShape>()
  const ancestryRepo = new Repository()
  if (body.shape === null) return { byUuid, ancestryRepo }
  const shape = table.get<OccShape>(body.shape)
  const faces = canonicalFaces(oc, scope, shape) as OccShape[]
  assertAligned(faces.length, body.face_uuids, `${body.id} face index`)
  const { center, half } = bodyFrame(oc, scope, shape)

  faces.forEach((face, idx) => {
    const uuid = body.face_uuids?.[idx] ?? null
    if (uuid) byUuid.set(uuid, face)
    if (!body.created_by) return
    const centroid = faceCentroid(oc, scope, face) as Vec3
    const classifiers = geometryClassifiers(centroid, center, half)
    const ids: string[] = []
    if (uuid) ids.push(constructionUuidToken(uuid))
    ids.push(ref(body.created_by), ref(body.id))
    const ancestryTokens = (uuid && body.face_ancestry) ? (body.face_ancestry[uuid] ?? null) : null
    if (ancestryTokens && ancestryTokens.length) ids.push(...ancestryTokens)
    else if (body.profile_queries.length > 0) ids.push(...body.profile_queries)
    if (classifiers.length) ids.push(...classifiers.map(ref))
    const stableIds = ids.filter((t) => !isClassifierId(t))
    const payload: FaceAncestryPayload = { type: faceSurfaceType(oc, scope, face), classifiers, shape: face }
    ancestryRepo.registerAncestor(stableIds, payload, uuid)
  })

  return { byUuid, ancestryRepo }
}

/** Per-body FaceIndex cache for one solve; building it walks every face and
 *  computes a bodyFrame, so a caller resolving several refs shares one. */
export function makeFaceIndexCache(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
): (body: Body) => FaceIndex {
  const cache = new Map<string, FaceIndex>()
  return (body: Body): FaceIndex => {
    let idx = cache.get(body.id)
    if (idx === undefined) {
      idx = buildFaceIndex(oc, scope, table, body)
      cache.set(body.id, idx)
    }
    return idx
  }
}

/** The `@u|<uuid>` token of a query, or null when it names none. */
export function queryFaceUuid(q: string): string | null {
  try {
    const [ids] = parseAncestry(q)
    const tok = ids.find((i) => i.startsWith('@u|'))
    return tok !== undefined ? tok.slice(3) : null
  } catch {
    return null
  }
}

/** The one body a query names, from its `@body_*` token or by resolving the
 *  face itself, or null when it names none. Shared by the shell and move-face
 *  leaves, which pick faces but act on the owning body. */
export function bodyOfQuery(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  indexFor: (body: Body) => FaceIndex,
  q: string,
): string | null {
  const named = bodyIdOf(q, bodyStore)
  if (named !== null && named in bodyStore) return named
  for (const bid of Object.keys(bodyStore)) {
    const body = bodyStore[bid]
    if (body.shape === null) continue
    if (resolveFacesByQuery(oc, scope, table, body, indexFor(body), [q], bodyStore).get(q)) return bid
  }
  return null
}

/** Stable-ancestry tier: recover a face whose UUID died, validated by its
 *  classifiers. An ambiguous match stays unresolved (fail-safe, never wrong). */
function resolveByStableAncestry(
  repo: Repository,
  q: string,
  bodyStore: Record<string, unknown> | null,
): OccShape | null {
  try {
    const resolved = repo.query(q, null, bodyStore)
    if (resolved !== null && typeof resolved === 'object' && 'shape' in resolved) {
      const payload = resolved as FaceAncestryPayload
      const [ids] = parseAncestry(q)
      const wanted = ids.filter(isClassifierId).map((i) => i.slice(1))
      if (wanted.every((c) => payload.classifiers.includes(c))) return payload.shape
    }
  } catch (e) {
    if (!(e instanceof AmbiguousQueryError)) throw e
  }
  return null
}

/**
 * Resolve face queries to OCC faces on a body, keyed by the query that produced
 * each. A query that matches nothing comes back as null rather than vanishing,
 * so a stale pick can be reported (`unresolved_faces`) and struck through.
 *
 * Only construction identity is consulted: the exact UUID tier first, then the
 * stable-ancestry tier. Geometry never decides which face a query means.
 */
export function resolveFacesByQuery(
  _oc: OccModule,
  _scope: DisposeScope,
  _table: HandleTable,
  _body: Body,
  index: FaceIndex,
  faceQueries: string[],
  bodyStore: Record<string, unknown> | null = null,
): Map<string, OccShape | null> {
  const out = new Map<string, OccShape | null>()
  const memo = new Map<string, OccShape | null>()
  for (const q of faceQueries) {
    const cached = memo.get(q)
    if (cached !== undefined) {
      out.set(q, cached)
      continue
    }
    let face: OccShape | null = null
    const uuid = queryFaceUuid(q)
    if (uuid !== null) face = index.byUuid.get(uuid) ?? null
    if (face === null && q.startsWith('?')) {
      face = resolveByStableAncestry(index.ancestryRepo, q, bodyStore)
    }
    memo.set(q, face)
    out.set(q, face)
  }
  return out
}
