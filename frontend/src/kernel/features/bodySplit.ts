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
 * A near-tie is a refusal, and a refusal falls back to explore order rather
 * than failing the solve: an ambiguous order is no worse than today's.
 */

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { exploreSolids } from '../occ/booleans'
import { readSolidVertices, solidCentroid } from '../occ/primitives'
import { faceGh, edgeGh } from '../occ/lineageHash'
import { orderSplitChildren, type SplitChild } from '../constructionName'

/** The per-body identity fields a split has to hand down to every sibling. */
export interface BodyTemplate {
  /** Base id: the first sibling takes it verbatim, the rest get `_1`, `_2`, ... */
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
 * Axis-aligned bounds of a shape from its B-rep vertices, as (centre, span).
 * Vertex-based like `hole`'s span probe rather than Bnd_Box, so a curved face
 * bulge cannot shift the frame between two rebuilds of the same shape.
 */
function shapeFrame(oc: OccModule, scope: DisposeScope, shape: OccShape): { centre: number[]; span: number }  {
  const verts = readSolidVertices(oc, scope, shape)
  if (verts.length === 0) return { centre: [0, 0, 0], span: 1 }
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < lo[i]) lo[i] = v[i]
      if (v[i] > hi[i]) hi[i] = v[i]
    }
  }
  const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  return {
    centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
    // A degenerate span would divide the ordering key by ~0 and turn every
    // sibling into a near-tie; 1 keeps the key finite and the refusal honest.
    span: span > 1e-9 ? span : 1,
  }
}

/**
 * Order split siblings deterministically, or fall back to explore order.
 *
 * The key is each solid's centre of mass relative to the parent's own bounding
 * centre, divided by the parent's span, so a uniform resize of the parent
 * cancels and the key stays a pure relative position.
 */
function orderSolids(oc: OccModule, scope: DisposeScope, parent: OccShape, solids: OccShape[]): OccShape[] {
  if (solids.length < 2) return solids
  const { centre, span } = shapeFrame(oc, scope, parent)
  const children: SplitChild<OccShape>[] = solids.map((solid) => {
    const c = solidCentroid(oc, scope, solid)
    return { item: solid, key: [(c[0] - centre[0]) / span, (c[1] - centre[1]) / span, (c[2] - centre[2]) / span] }
  })
  return orderSplitChildren(children) ?? solids
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
    const gh = faceGh(oc, scope, scope.track(oc.TopoDS.Face_1(faceExp.Current())))
    const uuid = srcFaceNames[gh]
    if (uuid === undefined) continue
    out.faceNames[gh] = uuid
    if (srcFaceAnc[uuid] !== undefined) out.faceAncestry[uuid] = [...srcFaceAnc[uuid]]
  }
  const edgeExp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; edgeExp.More(); edgeExp.Next()) {
    const gh = edgeGh(oc, scope, scope.track(oc.TopoDS.Edge_1(edgeExp.Current())))
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
 * occupies, `body.id` first.
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
    body.shape = table.register(scope.detach(solids.length === 1 ? solids[0] : newShape), body.created_by)
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
  body.shape = table.register(scope.detach(solids[0]), body.created_by)
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
      shape: table.register(scope.detach(solids[i]), body.created_by),
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
