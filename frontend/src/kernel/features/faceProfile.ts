// `_resolve_face_index_via_hash`, `_extract_loops_from_occ_face`, `_resolve_face_profile`,
// `_collect_extrude_loops`. This is the routing layer the extrude/revolve leaves call to turn a
// profile reference (a `$sketch`, a body face `@feat/face/N`, or an ancestral surface query)
// into 2D loops + the plane to build on. The OCC face->loops work lives in occ/faceLoops.ts;
// the pure surface-loop assembly is extractProfileLoops (features/shared.ts).
//
// Body shapes are HandleTable handles, so the OCC-backed branches resolve them via the table;
// the topo-surface branches (`@`/`?` against stored sketch topology) are pure and need no OCC.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable, OccHandle } from '../occ/handleTable'
import type { Body, Frame3D } from '../types3d'
import { Repository, parseAncestry, makeAncestryQuery, ref } from '../query'
import { faceCentroid, faceNormal } from '../occ/primitives'
import { faceGeometryHash } from '../geomHash'
import { extractOccFace, extractFaceLoops, computeFaceDatumFrame } from '../occ/faceLoops'
import { extractProfileLoops, parseSketchEntityRef, registerTopFace, sketchIdFromQuery, surfaceEntityIds, type PlaneLike } from './shared'

type Dict = Record<string, unknown>
type EdgeDict = Record<string, unknown>

interface FaceProfile {
  loops: EdgeDict[][]
  plane: PlaneLike
  // The OCC face when resolved from a body, else null (topo-surface paths).
  face: OccShape | null
}

function bodyShape(table: HandleTable, body: Body): OccShape {
  if (body.shape === null) throw new Error(`body ${body.id} has no shape`)
  return table.get<OccShape>(body.shape as OccHandle)
}

/**
 * Resolve an old sorted face index to the current index via the face's geometry
 * hash (mirrors `_resolve_face_index_via_hash`). Returns null when resolution
 * fails (index out of range, geometry read error, or hash not in the repo).
 */
export function resolveFaceIndexViaHash(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  oldIndex: number,
  globalRepo: Repository,
  bodyStore: Record<string, unknown> | null = null,
  faceNames?: Record<string, string>,
): number | null {
  let targetFace: OccShape
  try {
    targetFace = extractOccFace(oc, scope, shape, oldIndex)
  } catch {
    return null
  }
  const centroid = faceCentroid(oc, scope, targetFace)
  const normal = faceNormal(oc, scope, targetFace)
  const geomHash = faceGeometryHash(centroid, normal)

  // Try UUID-based resolution first: look up the construction UUID from the
  // body's face_names via the geometry hash, then query the repo by UUID
  // (identity tier, exact match). This avoids the geometry-hash tier which can
  // match an unrelated face with the same centroid+normal.
  if (faceNames && geomHash in faceNames) {
    const uuid = faceNames[geomHash]
    try {
      const uuidQuery = makeAncestryQuery([uuid], 'face')
      const faceEntry = globalRepo.query(uuidQuery, null, bodyStore) as Dict | null
      if (faceEntry && 'face_index' in faceEntry) {
        return faceEntry.face_index as number
      }
    } catch {
      // UUID query failure -> fall through to geometry hash fallback
    }
  }

  try {
    const queryStr = makeAncestryQuery([ref(geomHash)], 'face')
    const faceEntry = globalRepo.query(queryStr, null, bodyStore) as Dict | null
    if (faceEntry && 'face_index' in faceEntry) {
      return faceEntry.face_index as number
    }
  } catch {
    // query failure -> fall through to null (use the caller's old index)
  }
  return null
}

/** Loops + plane + face for a body's sorted face index (mirrors `_extract_loops_from_occ_face`). */
export function extractLoopsFromOccFace(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceIndex: number,
): FaceProfile {
  const { loops, plane, face } = extractFaceLoops(oc, scope, shape, faceIndex)
  return { loops, plane, face }
}

/**
 * Body a `@<id>/...` reference names. `<id>` is a BODY id in everything the
 * render layer mints today (utils/query/selectionId.ts topoFallbackQuery), so
 * an exact body id has to be tried FIRST: a sibling ref `body_ex1_1` would
 * otherwise be read as a feature name, looked up as `body_body_ex1_1`, miss,
 * and throw. The feature branches below stay for hand-written and legacy refs;
 * they answer with the feature's first body, which is also the index space
 * `@<feat>/face/N` was always understood in.
 */
function findBodyForRef(bodyStore: Record<string, Body>, id: string): Body | null {
  const exact = bodyStore[id]
  if (exact !== undefined && exact.shape !== null) return exact
  const prefixed = bodyStore['body_' + id]
  if (prefixed !== undefined && prefixed.shape !== null) return prefixed
  for (const b of Object.values(bodyStore)) {
    if (b.created_by === id && b.shape !== null) return b
  }
  return null
}

const SLASH_FACE = /^@([^/]+)\/face\/(\d+)$/

/**
 * Resolve a profile reference to (loops, plane, face) (mirrors
 * `_resolve_face_profile`). Handles the body-face slash form `@body/face/N`,
 * repo entries carrying body_id+face_index, `@feat`/`?...` topo-surface forms.
 */
export function resolveFaceProfile(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  sketchRef: string,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): FaceProfile {
  const slash = SLASH_FACE.exec(sketchRef)
  if (slash) {
    const refId = slash[1]
    let faceIndex = parseInt(slash[2], 10)
    const body = findBodyForRef(bodyStore, refId)
    if (body === null) throw new Error(`No body found for '${refId}'`)
    const shape = bodyShape(table, body)
    const resolved = resolveFaceIndexViaHash(oc, scope, shape, faceIndex, globalRepo, bodyStore, body.face_names)
    if (resolved !== null) faceIndex = resolved
    return extractLoopsFromOccFace(oc, scope, shape, faceIndex)
  }

  const faceEntry = globalRepo.query(sketchRef, null, bodyStore) as Dict | null
  if (faceEntry === null) throw new Error(`Profile face not found: ${sketchRef}`)

  const bodyId = faceEntry.body_id as string | undefined
  const faceIndex = faceEntry.face_index as number | undefined
  if (bodyId !== undefined && faceIndex !== undefined) {
    const body = bodyStore[bodyId]
    if (body === undefined || body.shape === null) {
      throw new Error(`Body '${bodyId}' not found or has no shape`)
    }
    return extractLoopsFromOccFace(oc, scope, bodyShape(table, body), faceIndex)
  }

  if (sketchRef.startsWith('@')) {
    const refId = sketchRef.slice(1).split('/')[0]
    const body = findBodyForRef(bodyStore, refId)
    if (body === null) throw new Error(`No body found for '${refId}'`)
    const topo = (globalRepo.elements.get('_topo_' + body.sketch_id) as Dict | undefined) ?? {}
    const surfaces = (topo.surfaces as Dict[]) ?? []
    const effectivePlane: PlaneLike = {
      origin: (faceEntry.origin as number[]) ?? [0, 0, 0],
      x_axis: (faceEntry.x_axis as number[]) ?? [1, 0, 0],
      y_axis: (faceEntry.y_axis as number[]) ?? [0, 1, 0],
      normal: (faceEntry.normal as number[]) ?? [0, 0, 1],
    }
    return { loops: extractProfileLoops(surfaces), plane: effectivePlane, face: null }
  }

  if (sketchRef.startsWith('?')) {
    const [targetIds] = parseAncestry(sketchRef)
    const sketchId = sketchIdFromQuery(sketchRef, globalRepo)
    if (sketchId === null) {
      throw new Error(`Cannot find parent sketch for surface query: ${sketchRef}`)
    }
    const surfacePt = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
    if (surfacePt === undefined) throw new Error(`Sketch plane not found for: ${sketchId}`)
    const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}
    const allSurfaces = (topo.surfaces as Dict[]) ?? []
    const matched = allSurfaces.filter((s) => {
      const q = (s.query as string) ?? ''
      if (!q.startsWith('?')) return false
      const [ids] = parseAncestry(q)
      return ids.length === targetIds.length && ids.every((v, i) => v === targetIds[i])
    })
    return {
      loops: extractProfileLoops(matched.length ? matched : allSurfaces),
      plane: surfacePt,
      face: null,
    }
  }

  throw new Error(`Cannot resolve profile from: ${sketchRef}`)
}

/**
 * Resolve a topo-fallback `@<body>/face/<idx>` ref to the face's 3D frame via
 * the body's OCC shape. Shared by the extrude-on-face profile path and the
 * on_face plane mode so a plane built from the same pick a user sees resolves
 * identically: `repo.query` has no entry for the slash form (faces register
 * under ancestry keys), so the frame has to come from the shape itself.
 */
export function resolveFaceSlashFrame(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  ref: string,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): Frame3D {
  const slash = SLASH_FACE.exec(ref)
  if (slash === null) throw new Error(`not a slash face ref: ${ref}`)
  const refId = slash[1]
  let faceIndex = parseInt(slash[2], 10)
  const body = findBodyForRef(bodyStore, refId)
  if (body === null) throw new Error(`No body found for '${refId}'`)
  const shape = bodyShape(table, body)
  const resolved = resolveFaceIndexViaHash(oc, scope, shape, faceIndex, globalRepo, bodyStore, body.face_names)
  if (resolved !== null) faceIndex = resolved
  const face = extractOccFace(oc, scope, shape, faceIndex)
  return computeFaceDatumFrame(oc, scope, face)
}

interface ExtrudeLoops {
  loops: EdgeDict[][]
  plane: PlaneLike
  sketchId: string
  face: OccShape | null
}

/**
 * Loops for a viewport pick of ONE sketch entity (`entity:<sketch>:<eid>`), i.e.
 * a click that landed on a sketch curve rather than on the area fill beside it.
 *
 * The answer is the curve's own closed loop, taken as a simple profile: the
 * pick names a boundary, and what is extruded is what that boundary encloses.
 * The loop is read from whichever of the two shapes the area builder left it in:
 *
 *  1. an undivided closed curve is already its own area (`build_standalone` in
 *     topology/dcel.rs), whose ancestry names that one entity and nothing else;
 *  2. a closed curve something crosses has no area of its own and survives as
 *     the split edges under its entity id, which chain back into its loop.
 *
 * Only the OUTER boundary is taken, never that area's `holes`. A hole in the
 * area model is not a void: the inner curve bounds its own filled area right
 * next to it, so the fill the user sees inside the picked curve is solid, and
 * the answer has to match it. It also has to match itself -- whether a chord
 * happens to divide the curve decides which branch above answers, and case 2
 * has no holes to speak of, so subtracting them in case 1 would make one drawing
 * extrude two different solids. Pick the ring's area itself to keep its hole.
 *
 * The regions the curve BORDERS are never the answer: a circle drawn inside a
 * rectangle borders the rectangle's region too, and a pick of the circle must
 * not drag the plate in with it.
 *
 * A curve that closes nothing (a lone line, an arc) is refused rather than
 * silently widened to the whole sketch. The pick is named in the error, and the
 * area fill next to the curve is still there to pick instead.
 */
function collectEntityProfileLoops(
  sketchId: string,
  eid: string,
  globalRepo: Repository,
): ExtrudeLoops {
  const plane = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  if (plane === undefined) throw new Error(`sketch not found: ${sketchId}`)
  const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}

  const token = ref(sketchId + '/' + eid)
  const ownArea = ((topo.surfaces as Dict[]) ?? []).find((s) => {
    const ids = surfaceEntityIds(s)
    return ids.length === 1 && ids[0] === token
  })
  // Either way it is one edge list to chain, and the chaining plus the closure
  // test are the same ones a real area's boundary goes through.
  const boundary = ownArea !== undefined
    ? ((ownArea.boundary as Dict[]) ?? [])
    : ((topo.edges as Dict[]) ?? []).filter((e) => e.entity_id === eid)
  const loops = boundary.length > 0 ? extractProfileLoops([{ boundary }]) : []
  if (loops.length === 0) {
    throw new Error(
      `profile entity '${eid}' of sketch ${sketchId} bounds no closed area; ` +
      'pick the area itself, or a closed entity such as a circle',
    )
  }
  return { loops, plane, sketchId, face: null }
}

/**
 * Resolve an extrude's profile to (loops, plane, sketch_id, face) (mirrors
 * `_collect_extrude_loops`). For a plain `$sketch` ref it registers the swept
 * top face and reads the sketch topology; for `@`/`?` refs it routes through
 * resolveFaceProfile; an `entity:`/`vertex:` viewport pick resolves to the area
 * that one entity bounds.
 */
export function collectExtrudeLoops(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  sketchRef: string,
  featureId: string,
  distance: number,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): ExtrudeLoops {
  const picked = parseSketchEntityRef(sketchRef)
  if (picked !== null) {
    return collectEntityProfileLoops(picked.sketchId, picked.eid, globalRepo)
  }

  if (sketchRef.startsWith('?') || sketchRef.startsWith('@')) {
    let sketchId = ''
    if (sketchRef.startsWith('?')) {
      sketchId = sketchIdFromQuery(sketchRef, globalRepo) ?? ''
    } else {
      sketchId = sketchRef.slice(1).split('/')[0]
    }
    const { loops, plane, face } = resolveFaceProfile(oc, scope, table, sketchRef, globalRepo, bodyStore)
    return { loops, plane, sketchId, face }
  }

  const sketchId = sketchRef.replace(/^\$+/, '')
  const pt = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  if (pt === undefined) throw new Error(`sketch not found: ${sketchId}`)
  const topo = (globalRepo.elements.get('_topo_' + sketchId) as Dict | undefined) ?? {}
  const surfaces = (topo.surfaces as Dict[]) ?? []
  registerTopFace(globalRepo, featureId, pt, surfaces, distance)
  return { loops: extractProfileLoops(surfaces), plane: pt, sketchId, face: null }
}

// Re-export Frame3D for consumers building plane inputs.
export type { Frame3D }
