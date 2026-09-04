/**
 * THE one place a shape becomes Body entries.
 *
 * The invariant (knowledgebase.agent.md, "Separated"): one `Body` in the body
 * store is exactly one OCC solid. Disjoint solids are separate parts, and the
 * geometry driver decides -- there is no intentional/accidental distinction.
 *
 * Before this module the rule was hand-copied into five feature leaves, each
 * with its own id scheme, collision handling and 0/1-solid behaviour, and it
 * was missing outright from boolean union/intersect, array add, mirror merge,
 * hole and fillet/chamfer -- so those silently produced one Body holding
 * several solids, i.e. one Parts-list row that was really N parts. Every leaf
 * now routes through `registerSplitBodies` (a shape becomes new bodies) or
 * `resplitBody` (an existing body's shape was replaced and may have split).
 * `exploreSolids` must not be called for body creation anywhere else.
 *
 * Sibling ORDER is geometric on purpose and only here: the split children are
 * sorted by their centroid in the parent's own normalized frame, which is the
 * single use of geometry the identity design allows (the same "confined
 * split-sibling ordering key" `orderSplitChildren` already provides for faces,
 * edges and vertices). It makes `body_x_1` denote the same half across a
 * rebuild instead of whatever order OCC's TopExp walk happened to produce.
 * A near-tie is a LOUD refusal (an exception): naming a flipped half `body_x`
 * and its mirror `body_x_1` would silently swap the persisted id a part's
 * name/colour ride on, so the solve fails instead (user decision 2026-08-12).
 */

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { exploreSolids } from '../occ/booleans'
import { solidCentroid } from '../occ/primitives'
import { faceGh, edgeGh } from '../occ/lineageHash'
import { orderSplitChildren, type SplitChild } from '../constructionName'
import { shapeNormalFrame } from '../occ/constructionLineage'

/** The per-body identity fields a split has to hand down to every sibling. */
export interface BodyTemplate {
  // Base id: the first sibling takes it verbatim, the rest get `_1`, `_2`, ...
  id: string
  createdBy: string
  sketchId?: string
  profileQueries?: string[]
  imported?: boolean
  faceNames?: Record<string, string> | null
  edgeNames?: Record<string, string> | null
  faceAncestry?: Record<string, string[]> | null
  edgeAncestry?: Record<string, string[]> | null
}

/** Construction-name maps narrowed to the faces and edges of one split sibling. */
interface SiblingNames {
  faceNames: Record<string, string>
  edgeNames: Record<string, string>
  faceAncestry: Record<string, string[]>
  edgeAncestry: Record<string, string[]>
}

/**
 * Order split siblings deterministically, or fail the solve on a near-tie.
 *
 * The key is each solid's centre of mass relative to the parent's own bounding
 * centre, divided by the parent's span (via the shared `shapeNormalFrame`), so
 * a uniform resize of the parent cancels and the key stays a pure relative
 * position. A near-tie is a refusal, and here a refusal is a throw: every other
 * UUID-minting caller turns a refusal into "leave unnamed" and the ancestral
 * path recovers, but a body id names a persisted part (name/colour/visibility)
 * so the id must never be assigned in OCC explorer order. A flipped body id is
 * worse than a failed split (user decision 2026-08-12).
 */
function orderSolids(oc: OccModule, scope: DisposeScope, parent: OccShape, solids: OccShape[]): OccShape[] {
  if (solids.length < 2) return solids
  const { centre, span } = shapeNormalFrame(oc, scope, parent)
  const children: SplitChild<OccShape>[] = solids.map((solid) => {
    const c = solidCentroid(oc, scope, solid)
    return { item: solid, key: [(c[0] - centre[0]) / span, (c[1] - centre[1]) / span, (c[2] - centre[2]) / span] }
  })
  // A NaN key component is a geometry-read failure (a centroid the kernel could
  // not compute), not an ambiguity: `orderSplitChildren` would refuse it with
  // the same null return, but a near-tie has a real fix (nudge the split) while
  // a NaN centroid has none. Name the failure. Still pre-side-effect: no
  // sibling has been registered or mutated yet.
  if (children.some((c) => c.key.some((k) => Number.isNaN(k)))) {
    throw new Error(
      'bodySplit: a split sibling centroid read failed (NaN ordering key); refusing to order the siblings ' +
      '(a flipped body id is worse than a failed split)',
    )
  }
  const ordered = orderSplitChildren(children)
  if (ordered === null) {
    throw new Error(
      'bodySplit: split siblings are a near-tie in the parent frame; refusing to order them ' +
        '(a flipped body id is worse than a failed split)',
    )
  }
  return ordered
}

/**
 * The subset of `template`'s name maps that belongs to `solid`.
 *
 * `face_names`/`edge_names` are keyed by the in-build geom-hash of the face or
 * edge, so a sibling keeps exactly the entries its own sub-shapes hash to; the
 * ancestry maps are then narrowed to the UUIDs that survived. Without this a
 * split sibling inherited either everything (including its neighbour's faces)
 * or nothing at all, and picks on it fell back to the ancestral path.
 */
function namesForSolid(oc: OccModule, scope: DisposeScope, solid: OccShape, template: BodyTemplate): SiblingNames {
  const srcFaceNames = template.faceNames ?? {}
  const srcEdgeNames = template.edgeNames ?? {}
  const srcFaceAnc = template.faceAncestry ?? {}
  const srcEdgeAnc = template.edgeAncestry ?? {}
  const out: SiblingNames = { faceNames: {}, edgeNames: {}, faceAncestry: {}, edgeAncestry: {} }

  const E = oc.TopAbs_ShapeEnum
  const faceExp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; faceExp.More(); faceExp.Next()) {
    const rawFace = scope.track(faceExp.Current())
    const gh = faceGh(oc, scope, scope.track(oc.TopoDS.Face_1(rawFace)))
    const uuid = srcFaceNames[gh]
    if (uuid === undefined) continue
    out.faceNames[gh] = uuid
    if (srcFaceAnc[uuid] !== undefined) out.faceAncestry[uuid] = [...srcFaceAnc[uuid]]
  }
  const edgeExp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; edgeExp.More(); edgeExp.Next()) {
    const rawEdge = scope.track(edgeExp.Current())
    const gh = edgeGh(oc, scope, scope.track(oc.TopoDS.Edge_1(rawEdge)))
    if (gh === null) continue
    const uuid = srcEdgeNames[gh]
    if (uuid === undefined) continue
    out.edgeNames[gh] = uuid
    if (srcEdgeAnc[uuid] !== undefined) out.edgeAncestry[uuid] = [...srcEdgeAnc[uuid]]
  }
  return out
}

/**
 * `base`, `base_1`, `base_2`, ... skipping ids the store already holds.
 *
 * The collision walk covers index 0 as well, which is what lets a caller invoke
 * `registerSplitBodies` repeatedly with the SAME base id and get one flat,
 * gap-free sibling run: the array leaf registers one instance after another,
 * and an instance that itself splits must not silently overwrite the next
 * instance's id. Split ids derived from an existing body id (a cut re-splitting
 * `body_x_1`) can collide for the same reason.
 */
function mintSiblingId(base: string, index: number, bodyStore: Record<string, Body>): string {
  if (index === 0 && !(base in bodyStore)) return base
  let suffix = Math.max(index, 1)
  while (`${base}_${suffix}` in bodyStore) suffix++
  return `${base}_${suffix}`
}

/** The solids `shape` decomposes into, in stable sibling order. Empty for a shell-only shape. */
export function splitSolids(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return orderSolids(oc, scope, shape, exploreSolids(oc, scope, shape))
}

// The handle-table owner tag of a body shape is its PRODUCING feature -- the
// feature whose solve minted this exact solid -- never `created_by`. The two
// roles diverge the moment a modifier (fillet/cut/hole/...) replaces another
// feature's shape: `releaseCheckpoint` drops the owner tag of the evicted
// feature, so a replacement tagged with its still-clean creator would strand
// one full solid per edit of the modifier. Tagging by producer groups every
// shape a feature generated (new bodies AND replacements, including split
// siblings) under the one tag that dies exactly when its checkpoint does.
// `created_by` keeps its separate job: identity and ancestry attribution.

/**
 * Register `shape` as one Body per solid and return the new ids (first id
 * first). The caller must not have detached `shape` yet: this takes ownership
 * of the parts it registers.
 *
 * A shape with no solid at all (surfaces or shells only, e.g. a STEP file
 * holding just geometry) becomes a single body carrying the whole shape --
 * there is nothing to split, and dropping it would leave the feature with no
 * body id at all.
 */
export function registerSplitBodies(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  shape: OccShape,
  template: BodyTemplate,
): string[] {
  const solids = splitSolids(oc, scope, shape)
  const parts = solids.length > 0 ? solids : [shape]
  const ids: string[] = []
  parts.forEach((part, i) => {
    const id = mintSiblingId(template.id, i, bodyStore)
    // A lone part keeps the caller's maps whole: narrowing them would be a
    // no-op walk over the same sub-shapes, and a shell-only shape has no
    // solid to walk at all.
    const names = parts.length > 1
      ? namesForSolid(oc, scope, part, template)
      : {
        faceNames: { ...(template.faceNames ?? {}) },
        edgeNames: { ...(template.edgeNames ?? {}) },
        faceAncestry: { ...(template.faceAncestry ?? {}) },
        edgeAncestry: { ...(template.edgeAncestry ?? {}) },
      }
    bodyStore[id] = {
      id,
      created_by: template.createdBy,
      modified_by: [],
      shape: table.register(scope.detach(part), template.createdBy),
      sketch_id: template.sketchId ?? '',
      brep_diff: null,
      profile_queries: [...(template.profileQueries ?? [])],
      face_names: names.faceNames,
      edge_names: names.edgeNames,
      face_ancestry: names.faceAncestry,
      edge_ancestry: names.edgeAncestry,
      ...(template.imported ? { imported: true } : {}),
    }
    ids.push(id)
  })
  return ids
}

/**
 * Re-seat an existing body on `newShape`, splitting it into extra sibling
 * bodies when the operation disconnected it. Returns every id the body now
 * occupies, `body.id` first. `newShape` must be tracked by `scope`; ownership
 * transfers to the HandleTable.
 *
 * `body` keeps its identity (id, created_by, modified_by, sketch_id,
 * brep_diff, profile_queries, imported) and takes the first solid; siblings are
 * fresh bodies that inherit those fields, minus the diff -- the diff describes
 * the whole pre-split shape and no sibling owns all of it. The caller is
 * expected to have already updated `body`'s name maps for the WHOLE new shape
 * -- this narrows them per sibling. The old handle is released here.
 *
 * `featureId` is the feature doing the splitting. A sibling MUST carry the same
 * `modified_by` history as the body it broke off, or it reads as untouched
 * since its `created_by`: `reuseCleanImportedBodyMeshes` (builder.ts) would
 * then hand a sibling of an imported body last solve's mesh even though the
 * splitting feature is dirty and just rebuilt it with different geometry.
 * Passing the id explicitly rather than trusting the caller to have pushed it
 * first is deliberate -- the leaves disagree on whether they push before or
 * after this call.
 *
 * An EMPTY result (the new shape holds no solid) deletes the body from the
 * store and returns `[]`, so a caller that re-resolves the old id later fails
 * with "body not found" instead of reading a `shape: null`. `body_ids: []`
 * deliberately means "nothing survives", the opposite of the auto-delete
 * convention in bodyOps.ts (which keeps the consumed id in `body_ids`); do not
 * reconcile the two. The deletion is complete here (store entry gone, handle
 * released); the build loop's eviction pass (builder.ts) clears the body's
 * repo registrations, the same path a consumed boolean tool takes.
 */
export function resplitBody(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  body: Body,
  newShape: OccShape,
  featureId: string,
): string[] {
  const solids = splitSolids(oc, scope, newShape)
  const oldHandle = body.shape
  const ids = [body.id]

  if (solids.length <= 1) {
    // Nothing disconnected: register the solid itself when there is one, so a
    // compound wrapper never survives as a body shape and `countSolids === 1`
    // stays literally true.
    if (solids.length === 0) {
      // The operation consumed the whole body. Release the handle AND drop the
      // body: leaving it behind with shape:null keeps it resolvable as a later
      // feature's target and puts a shapeless row in the parts list.
      if (oldHandle !== null) table.release(oldHandle)
      delete bodyStore[body.id]
      return []
    }
    body.shape = table.register(scope.detach(solids[0]), featureId)
    if (oldHandle !== null) table.release(oldHandle)
    return ids
  }

  const template: BodyTemplate = {
    id: body.id,
    createdBy: body.created_by,
    sketchId: body.sketch_id,
    profileQueries: body.profile_queries,
    imported: body.imported,
    faceNames: body.face_names,
    edgeNames: body.edge_names,
    faceAncestry: body.face_ancestry,
    edgeAncestry: body.edge_ancestry,
  }

  // The caller may push `featureId` onto the parent before OR after this call;
  // either way every sibling ends up with the same history the parent has.
  const last = body.modified_by[body.modified_by.length - 1]
  const history = last === featureId ? [...body.modified_by] : [...body.modified_by, featureId]

  const names0 = namesForSolid(oc, scope, solids[0], template)
  body.shape = table.register(scope.detach(solids[0]), featureId)
  body.face_names = names0.faceNames
  body.edge_names = names0.edgeNames
  body.face_ancestry = names0.faceAncestry
  body.edge_ancestry = names0.edgeAncestry
  if (oldHandle !== null) table.release(oldHandle)

  for (let i = 1; i < solids.length; i++) {
    const id = mintSiblingId(body.id, i, bodyStore)
    const names = namesForSolid(oc, scope, solids[i], template)
    bodyStore[id] = {
      id,
      created_by: body.created_by,
      modified_by: [...history],
      shape: table.register(scope.detach(solids[i]), featureId),
      sketch_id: body.sketch_id,
      brep_diff: null,
      profile_queries: [...body.profile_queries],
      face_names: names.faceNames,
      edge_names: names.edgeNames,
      face_ancestry: names.faceAncestry,
      edge_ancestry: names.edgeAncestry,
      ...(body.imported ? { imported: true } : {}),
    }
    ids.push(id)
  }
  return ids
}

/**
 * Throw if any body in the store holds more than one solid. The build-level
 * gate for the invariant: a leaf that forgets to route through this module
 * fails here instead of silently shipping one Parts row that is really N parts.
 */
export function assertOneSolidPerBody(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
): void {
  const bad: string[] = []
  for (const [id, body] of Object.entries(bodyStore)) {
    if (body.shape === null) continue
    const n = exploreSolids(oc, scope, table.get<OccShape>(body.shape)).length
    if (n > 1) bad.push(`${id} (${n} solids)`)
  }
  if (bad.length > 0) {
    throw new Error(
      `one Body == one solid violated: ${bad.join(', ')}. ` +
      'The producing leaf must route through registerSplitBodies/resplitBody (features/bodySplit.ts).',
    )
  }
}
