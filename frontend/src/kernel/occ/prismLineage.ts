// `_build_prism_lineage_map`, `extrude_profile_with_lineage`. This is the OCC
// adapter the extrude/revolve/sweep leaves call to turn a built solid plus its
// generating profile face into the per-face / per-edge construction names,
// keyed by the solid's own faces and edges (occ/bodyNames.ts).
//
// The profile-edge -> lateral face association comes from
// BRepPrimAPI_MakePrism.Generated() (the lineage sharp edge), drained via
// Size/First_1/RemoveFirst like every other list in this build (no iterator binding).
//
// The loop -> face construction lives in prismProfile.ts and the profile-edge /
// edge-UUID passes in prismEdgeNaming.ts; this module owns the face and cap
// naming and the brep production.

import { drainList, type DisposeScope } from './disposeScope'
import { extractErrorMessage } from '../errors'
import type {
  OccModule,
  OccShape,
  OccSubShape,
  OccListOfShape,
  OccPrismBuilder,
  OccPipeShellBuilder,
  OccEnumValue,
} from './occTypes'
import type { PlaneLike } from '../features/shared/planes'
import {
  faceArea,
  faceCentroid,
  faceNormal,
  faceSurfaceType,
  healWire,
  makeWire,
  SubShapeDedup,
  SubShapeMultiIndex,
  type Vec3,
} from './primitives'
import { classifyLoops, fuseCollinearRuns, type LoopEdge } from '../profileLoops'
import {
  booleanWithHistory,
  booleanWithHistoryMany,
  cleanWithHistory,
  composeOriginThroughClean,
  countSolids,
  shapeIsValid,
} from './booleans'
import {
  FaceEdgeTable,
  nameFacesFromNeighbours,
  faceSplitKey,
} from './constructionLineage'
import { canonicalFaces, carryFaceNames, emptyShapeNames, type ShapeNames } from './bodyNames'
import { SubShapeMap } from './subshapeIdentity'
import {
  mintFaceUuid,
  sideFacePath,
  capFacePath,
  splitFacePath,
  orderSplitChildren,
  type SplitChild,
} from '../constructionName'
import { sketchLoopsToFace, canonicalizeFaceCircles } from './prismProfile'
import { draftPrismBuilder } from './draftPrism'
import { entityForEdges, derivePrismEdgeNames } from './prismEdgeNaming'
import { swallowUnlessTrap } from '../errors'

// Kept as the public entry points for the profile -> face step and its
// canonicalizing core, which the real-OCC gates import from here.
export { sketchLoopsToFace, canonicalizeFaceCirclesWith } from './prismProfile'

// ─── prism lineage ───

/** The construction names for a built solid, keyed by its own faces and edges. */
export type LineageMaps = ShapeNames

/** A built solid plus its construction-name maps. */
export type LineageResult = LineageMaps & { solid: OccShape }

/** Faces of the builder's FirstShape()/LastShape(), the sweep caps, by IsSame. */
function capGeneratedFaces(
  oc: OccModule,
  scope: DisposeScope,
  builder: { FirstShape?(): OccShape; LastShape?(): OccShape },
): { face: OccSubShape; which: 'start' | 'end' }[] {
  const E = oc.TopAbs_ShapeEnum
  const out: { face: OccSubShape; which: 'start' | 'end' }[] = []
  const collect = (getter: (() => OccShape) | undefined, which: 'start' | 'end'): void => {
    if (!getter) return
    let shape: OccShape
    try {
      shape = getter.call(builder)
    } catch (e) {
      swallowUnlessTrap(e)
      return
    }
    const trackedShape = scope.track(shape)
    if ((trackedShape as unknown as { IsNull(): boolean }).IsNull()) return
    const exp = scope.track(new oc.TopExp_Explorer_2(trackedShape, E.TopAbs_FACE, E.TopAbs_SHAPE))
    for (; exp.More(); exp.Next()) {
      const raw = scope.track(exp.Current())
      out.push({ face: scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape, which })
    }
  }
  collect(builder.FirstShape, 'start')
  collect(builder.LastShape, 'end')
  return out
}

/**
 * Find the two caps of a prism/sweep solid when the builder does not report
 * FirstShape()/LastShape(). A cap is a face congruent to the profile face: a
 * rigid translation of it (planar, normal parallel to the profile normal, equal
 * area, centroid offset along the normal -- the sweep direction). The nearer
 * face is the start cap and the farther is the end cap, matching
 * `capFacePath`'s roles so a cap gets the SAME identity whether the builder
 * reported it or not.
 *
 * `caps` is [] unless exactly two such faces are found (a rotated cap, e.g. an
 * arc sweep, is deliberately not matched -- those builders still report their
 * caps). `capRoles` is the set of EVERY planar face with the profile face's
 * area, named or not: the faces whose only legitimate names come from the cap
 * path. The caller passes it to the neighbour pass as a skip set, so a cap the
 * cap path could not reach (its builder omitted FirstShape/LastShape and the
 * probe found no translation pair) stays exactly as the old wire output left
 * it -- unnamed -- instead of being reclassified as a corner face.
 */
function geometricCapFaces(
  oc: OccModule,
  scope: DisposeScope,
  faces: FaceEdgeTable,
  occFace: OccShape,
): { caps: { face: OccSubShape; which: 'start' | 'end' }[]; capRoles: SubShapeDedup } {
  const capRoles = new SubShapeDedup()
  let pc: Vec3
  let pn: Vec3
  let pa: number
  try {
    pc = faceCentroid(oc, scope, occFace)
    pn = faceNormal(oc, scope, occFace)
    pa = faceArea(oc, scope, occFace)
  } catch (e) {
    swallowUnlessTrap(e)
    return { caps: [], capRoles }
  }
  const candidates: { face: OccSubShape; d: number }[] = []
  for (const row of faces.rows) {
    // A row whose centroid/normal read failed (undefined UV-midpoint normal) is
    // skipped exactly as the old per-face try/catch-continue over `solid` did.
    const cn = faces.centroidNormal(row)
    if (cn === null) continue
    const n = cn.normal
    const c = cn.centroid
    const a = faces.area(row)
    if (a === null) continue  // the area read failed -> same skip as the catch
    if (faces.surfaceType(row) !== 'flatface') continue
    if (Math.abs(a - pa) > 1e-6 * Math.max(1, pa)) continue
    // Parallel (or anti-parallel): the face is a translation, not a rotation.
    const cross = [
      n[1] * pn[2] - n[2] * pn[1],
      n[2] * pn[0] - n[0] * pn[2],
      n[0] * pn[1] - n[1] * pn[0],
    ]
    if (Math.hypot(cross[0], cross[1], cross[2]) > 1e-6) continue
    // Only after passing the parallel test, classify as a cap candidate.
    capRoles.add(row.face)
    // The centroid offset is along the profile normal only (the sweep leaves no
    // in-plane shift), so (c - pc) - d*pn is zero.
    const d = (c[0] - pc[0]) * pn[0] + (c[1] - pc[1]) * pn[1] + (c[2] - pc[2]) * pn[2]
    const inPlane = Math.hypot(
      (c[0] - pc[0]) - d * pn[0],
      (c[1] - pc[1]) - d * pn[1],
      (c[2] - pc[2]) - d * pn[2],
    )
    if (inPlane > 1e-6) continue
    candidates.push({ face: row.face as OccSubShape, d })
  }
  if (candidates.length !== 2) return { caps: [], capRoles }
  // Sort by absolute distance so the cap coincident with the profile plane is
  // always `start`, regardless of which side the sweep extends toward.
  candidates.sort((x, y) => Math.abs(x.d) - Math.abs(y.d))
  return {
    caps: [
      { face: candidates[0].face, which: 'start' },
      { face: candidates[1].face, which: 'end' },
    ],
    capRoles,
  }
}

/**
 * The construction names for an extruded solid, keyed by its own faces and
 * edges (query-naming-by-construction.md). Each face's raw profile entity id
 * seeds its UUID's ancestral tokens (the caller prepends `@sketch_id/`). When
 * `createdBy` is non-empty, each side/cap face is
 * minted a construction UUID (side = the generating profile entity, cap = the
 * FirstShape/LastShape role, or the profile-derived fallback when the builder
 * omits them), a face neither match reached is named off its named neighbours,
 * and each edge derives its UUID from its two adjacent face UUIDs; multiplicity
 * (a face pair sharing >1 edge) is ordered by `orderSplitChildren` and refuses
 * on a near-tie.
 */
export function buildPrismLineageMap(
  oc: OccModule,
  scope: DisposeScope,
  occFace: OccShape,
  prismBuilder: {
    Shape(): OccShape
    Generated(s: OccShape): OccListOfShape
    FirstShape?(): OccShape
    LastShape?(): OccShape
  },
  loops: LoopEdge[][],
  plane: PlaneLike,
  createdBy = '',
  sketchId = '',
  groupIndex = 0,
  /**
   * The shape whose edges were handed to the builder, when that is not the
   * face itself. The sweep heals its outer wire before sweeping it, and
   * ShapeFix_Wire may rebuild an edge -- asking Generated() about the face's
   * (pre-heal) edge then answers empty and every side face goes unnamed.
   */
  sweptProfile: OccShape | null = null,
  /**
   * Per-role cap tokens for a multisection sweep, where the start and end caps
   * come from different sections. Absent keeps the single `capTokens` list,
   * which is what the single-profile paths have always used.
   */
  capTokensByRole: { start: string[]; end: string[] } | null = null,
): LineageMaps {
  const E = oc.TopAbs_ShapeEnum
  const solid = scope.track(prismBuilder.Shape())
  // The ONLY walk of `solid`: the cap pass, the main lineage loop and the
  // neighbour pass all read this one table (L4).
  const faces = FaceEdgeTable.read(oc, scope, solid)

  // Profile edges in explorer order, with their entity ids. entityForEdges
  // maps by geometry, not identity, so a healed wire's rebuilt edges still
  // land on their sketch entities.
  const profEdges: OccShape[] = []
  const profSource = sweptProfile ?? occFace
  const fexp = scope.track(new oc.TopExp_Explorer_2(profSource, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; fexp.More(); fexp.Next()) {
    const raw = scope.track(fexp.Current())
    profEdges.push(scope.track(oc.TopoDS.Edge_1(raw)))
  }
  const edgeEntities = entityForEdges(oc, scope, profEdges, loops, plane)

  // Every source id of a fused LoopEdge aliases the same face. Read the list
  // off the edge that actually built this profile edge: the same entity id can
  // occur in two loops with a different alias list, so a global id map would
  // lose one occurrence's aliases.
  const entityId = (entity: LoopEdge): string => String(entity['id'] ?? '')
  const entityAliases = (entity: LoopEdge): string[] => {
    const merged = entity['mergedIds']
    if (Array.isArray(merged)) {
      const ids = (merged as unknown[]).map((id) => String(id)).filter((id) => id !== '')
      if (ids.length > 0) return ids
    }
    const id = entityId(entity)
    return id ? [id] : []
  }

  // profile edge -> generated lateral face(s) via Generated(). Match these to
  // solid faces by subshape identity (IsSame), NOT by geom hash: Generated()
  // can return a face whose orientation -- and therefore normal-sign-dependent
  // geom hash -- differs from the same face as it sits in the solid shell.
  const genFaces: { face: OccSubShape; eid: string; aliases: string[] }[] = []
  // Multi, not single: one generated face can be reached from more than one
  // profile edge, and the main loop's old genFaces.find took the FIRST -- so
  // the index must too, hence get()[0] preserves the first-wins tie-break.
  const genIdx = new SubShapeMultiIndex<{ face: OccSubShape; eid: string; aliases: string[] }>()
  for (let i = 0; i < profEdges.length; i++) {
    const entity = edgeEntities[i]
    if (entity === null) continue
    const eid = entityId(entity)
    if (!eid) continue
    let generated: OccShape[]
    try {
      generated = drainList(scope, prismBuilder.Generated(profEdges[i]))
    } catch (e) {
      swallowUnlessTrap(e)
      continue
    }
    for (const g of generated) {
      const gexp = scope.track(new oc.TopExp_Explorer_2(g, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; gexp.More(); gexp.Next()) {
        const raw = scope.track(gexp.Current())
        const entry = {
          face: scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape,
          eid,
          aliases: entityAliases(entity),
        }
        genFaces.push(entry)
        genIdx.add(entry.face, entry)
      }
    }
  }
  if (profEdges.length > 0 && edgeEntities.some((e) => e !== null) && genFaces.length === 0) {
    throw new Error(
      'sweep/prism lineage: the builder generated no face for any profile edge ' +
      `(${profEdges.length} edges); the swept wire and the queried edges disagree`,
    )
  }

  // Caps named from the builder's FirstShape/LastShape; when the builder omits
  // them (or they throw), the geometric fallback derives the two caps from the
  // profile face itself so a cap's identity never depends on builder reporting.
  const capCandidates = createdBy ? capGeneratedFaces(oc, scope, prismBuilder) : []
  let capRoles: SubShapeDedup | undefined
  if (createdBy && capCandidates.length < 2) {
    const geo = geometricCapFaces(oc, scope, faces, occFace)
    // Seed with the builder's own caps so the geometric fallback neither
    // re-adds one of them nor duplicates itself across the loop.
    const capSeen = new SubShapeDedup()
    for (const c of capCandidates) capSeen.add(c.face)
    for (const g of geo.caps) {
      if (capSeen.add(g.face)) capCandidates.push(g)
    }
    // A cap-role face the cap path could not reach must stay exactly as the old
    // wire output left it (unnamed): the neighbour pass must not reclassify a
    // cap as a corner face, which would change every fixture's ancestry.
    capRoles = geo.capRoles
  }

  // One profile entity can generate several solid faces: a circle split into
  // arcs where it meets another loop gives each arc its own lateral face. Mint
  // one UUID per face, not per entity, or the body carries the same identity on
  // two faces and the face index collapses them. Deterministic split indices
  // reuse `orderSplitChildren`; a near-tie leaves the faces unnamed for the
  // neighbour pass, never one UUID shared by several faces.
  const sideRows = new Map<string, OccSubShape[]>()
  for (const row of faces.rows) {
    const match = genIdx.get(row.face)[0]
    if (match === undefined) continue
    const slot = sketchId ? `${sketchId}/${match.eid}` : match.eid
    const group = sideRows.get(slot)
    if (group) group.push(row.face)
    else sideRows.set(slot, [row.face])
  }
  const sideUuids = new SubShapeMap<string>()
  for (const [slot, group] of sideRows) {
    const base = mintFaceUuid(sideFacePath(createdBy, slot))
    if (group.length === 1) {
      sideUuids.set(group[0], base)
      continue
    }
    // The split key is relative to the PROFILE face these walls grew from, not
    // the whole solid, so the refusal threshold means the same fraction of the
    // parent surface and a body-wide resize cannot flip the order.
    const ordered = orderSplitChildren(
      group.map<SplitChild<OccSubShape>>((face) => ({
        item: face,
        key: faceSplitKey(oc, scope, occFace, face),
      })),
    )
    if (ordered === null) continue
    ordered.forEach((face, i) => sideUuids.set(face, mintFaceUuid(splitFacePath(base, i))))
  }

  // A cap's identification net is the profile entities that bounded it. The cap
  // is produced by THIS profile, so it says so itself instead of leaving an
  // empty list: an empty list makes every consumer fall back to the body-wide
  // `profile_queries`, and a cap that a later add fuses into another body then
  // inherits THAT body's creator's entities (join-cap-lineage). Sorted and
  // deduped to match what a sketch surface's ancestry ids look like, so a cap
  // and the stand-alone body's own profile query name the same set.
  //
  // It goes in `capAncestry`, not `faceAncestry`: edge lineage unions the
  // adjacent faces' ancestry, and a cap's whole-loop list on a rim edge would
  // swamp the one profile entity that edge actually lies on.
  const capTokens = [...new Set(edgeEntities.flatMap((entity) =>
    entity === null ? [] : entityAliases(entity),
  ))].sort()
  const capTokensFor = (which: 'start' | 'end'): string[] =>
    capTokensByRole === null ? capTokens : capTokensByRole[which]

  // solid face -> construction uuid, its tokens the generating profile entity.
  const faceNames = new SubShapeMap<string>()
  const faceAncestry: Record<string, string[]> = {}
  const capAncestry: Record<string, string[]> = {}
  for (const row of faces.rows) {
    const sf = row.face
    const match = genIdx.get(sf)[0]
    if (createdBy) {
      let uuid: string | null = null
      let capRole: 'start' | 'end' = 'start'
      if (match !== undefined) {
        uuid = sideUuids.get(sf) ?? null
      } else {
        // capCandidates is at most two faces; a linear IsSame find over it is
        // cheaper than an index build, so it stays a find.
        const cap = capCandidates.find((c) => (sf as OccSubShape).IsSame(c.face))
        if (cap) {
          uuid = mintFaceUuid(capFacePath(createdBy, cap.which, groupIndex))
          capRole = cap.which
        }
      }
      if (uuid !== null) {
        faceNames.set(sf, uuid)
        if (match !== undefined) faceAncestry[uuid] = match.aliases
        else {
          faceAncestry[uuid] = []
          capAncestry[uuid] = capTokensFor(capRole)
        }
      }
    }
  }

  // A face the generated/cap match missed (e.g. a merged-profile side face the
  // profile union trimmed off its source entity) is named off its named
  // neighbours, so its edges do not all fall back to the body-wide ancestral
  // query. Must run BEFORE the edge derivation, which needs both faces of an
  // edge named. Cap-role faces are skipped: their only legitimate name comes
  // from the cap path, and a cap the path could not reach stays unnamed so the
  // output stays byte-identical to the pre-neighbour-pass wire.
  nameFacesFromNeighbours(oc, scope, faces, faceNames, faceAncestry, capRoles)

  // solid edge -> construction uuid, derived from its two adjacent face uuids.
  const { edgeNames, edgeAncestry } = createdBy
    ? derivePrismEdgeNames(oc, scope, faces, faceNames, faceAncestry, createdBy)
    : { edgeNames: new SubShapeMap<string>(), edgeAncestry: {} }

  scope.release(solid)
  return { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry }
}

/** Prefix bare (non-@) tokens in every value list of a token map, in place. */
function prefixTokens(lineage: Record<string, string[]>, prefix: string): void {
  for (const key of Object.keys(lineage)) {
    lineage[key] = lineage[key].map((t) => (t.startsWith('@') ? t : prefix + t))
  }
}

/** Prefix every ancestry map of a LineageMaps in place. */
export function prefixLineageMaps(maps: LineageMaps, prefix: string): void {
  prefixTokens(maps.faceAncestry, prefix)
  prefixTokens(maps.edgeAncestry, prefix)
  prefixTokens(maps.capAncestry, prefix)
}

// ─── pre-prism profile union (multi-group extrude) ───

/**
 * Pre-prism profile union via a legacy-solid round-trip.  Build the multi-group
 * extrude the legacy way (per-group prisms fused + UnifySameDomain-cleaned),
 * which yields a sound body whose every wall is already one face -- but whose
 * emergent hole cylinder carries the merged-arc (non-canonical) seam (the
 * "8-face defect" when this body is later the target of an add).  The cleaned
 * solid's ENTRANCE cap face nonetheless has a canonical closed-circle hole
 * edge (UnifySameDomain canonicalizes the cap edge as a side effect of merging
 * the two cocylindrical half-cylinder faces), so we extract that cap and
 * re-prism it ONCE.  The re-prism's hole cylinder inherits that canonical
 * seam (and the outer walls keep their arc-endpoint-pinned seams, identical to
 * the legacy build), so a downstream add-fuse that prisms this body's swept
 * top face merges cleanly -- the original defect repaired at the body's source.
 * Returns the canonical profile face; `disjoint` when the groups' straight
 * prisms do not tile one connected region, and `failed` when the round trip
 * cannot produce a face safely. The caller treats a taper on `failed`
 * differently from disjoint groups: a disconnected multi-body profile may draft
 * each group, but an adjacent profile the merge could not rebuild must not fall
 * back to per-group frustums (their inner walls lean apart and only touch at the
 * base).
 */
type MergedProfileResult =
  | { kind: 'merged'; face: OccShape }
  | { kind: 'disjoint' }
  | { kind: 'failed' }

function tryCanonicalMergedProfile(
  oc: OccModule,
  scope: DisposeScope,
  groups: [LoopEdge[], LoopEdge[][]][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
): MergedProfileResult {
  try {
    const faces = groups.map(([outer, holes]) =>
      scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane)),
    )
    const vec = scope.track(
      new oc.gp_Vec_4(
        directionVec[0] * distance,
        directionVec[1] * distance,
        directionVec[2] * distance,
      ),
    )
    // Every solid here is an intermediate (the function returns a face off
    // the final one). Each group face is released once its prism has copied
    // it. The running `solid` is consumed by the next fuse/clean, so release
    // the prior running solid the moment a replacement is tracked -- leaving
    // the old one scope-owned strands one dead solid per group-boundary per
    // edit until the whole scope drains.
    const prismOf = (face: OccShape): OccShape => {
      const b = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true)) as OccPrismBuilder
      if (!b.IsDone()) throw new Error('prism builder did not complete')
      return b.Shape()
    }
    let solid: OccShape = scope.track(prismOf(faces[0]))
    scope.release(faces[0])
    for (let i = 1; i < faces.length; i++) {
      const part = scope.track(prismOf(faces[i]))
      const fused: OccShape = booleanWithHistory(oc, scope, solid, part, 'fuse').shape
      scope.track(fused)
      scope.release(solid)  // the previous running solid is consumed by the fuse
      solid = fused
      scope.release(part)
      scope.release(faces[i])
    }
    // The pre-prism-union path only makes sense when the groups tile ONE
    // connected region (their prism-fuse collapses to a single solid). For
    // disjoint groups (e.g. two non-adjacent rects) the fuse stays a
    // compound of N solids -- the legacy path must keep them as the
    // multi-body output the caller splits apart; bailing here preserves it.
    if (countSolids(oc, scope, solid) !== 1) { scope.release(solid); return { kind: 'disjoint' } }
    try {
      const cleaned = cleanWithHistory(oc, scope, solid).shape
      scope.track(cleaned)
      scope.release(solid)  // the previous running solid is consumed by the clean
      solid = cleaned
    } catch (e) {
      swallowUnlessTrap(e)
      // The prism-fuse-clean is the legacy path -- the only throw the
      // diagnostics pinned was the periodic-cylinder face merge (now avoided
      // here because this solid is the build target, never the add tool). Any
      // other throw means we cannot get a canonical cap cleanly -> bail.
      return { kind: 'failed' }
    }
    // Find the ENTRANCE cap: a planar face whose normal is anti-parallel to
    // `directionVec` and whose centroid lies on the resolved profile plane
    // through `plane.origin`.  That is the sketch-side cap; priming it back
    // along `directionVec` rebuilds the same span (so symmetric/reverse keep
    // their resolved effective plane).
    const E = oc.TopAbs_ShapeEnum
    const fexp = scope.track(new oc.TopExp_Explorer_2(solid, E.TopAbs_FACE, E.TopAbs_SHAPE))
    // Project the centroid onto the resolved profile-plane normal (not the
    // prism direction) so the entrance cap is identified regardless of the
    // resolved direction's relation to the sketch normal (symmetric/reverse
    // here today; a future skew extrude would still find the cap correctly).
    const op =
      plane.origin[0] * plane.normal[0] +
      plane.origin[1] * plane.normal[1] +
      plane.origin[2] * plane.normal[2]
    let entrance: OccShape | null = null
    for (; fexp.More(); fexp.Next()) {
      const raw = scope.track(fexp.Current())
      const f = scope.track(oc.TopoDS.Face_1(raw))
      if (faceSurfaceType(oc, scope, f) !== 'flatface') continue
      const n = faceNormal(oc, scope, f)
      const dot = n[0] * directionVec[0] + n[1] * directionVec[1] + n[2] * directionVec[2]
      if (dot > -0.9) continue  // not anti-parallel -- not the entrance cap
      const c = faceCentroid(oc, scope, f)
      const cp =
        c[0] * plane.normal[0] +
        c[1] * plane.normal[1] +
        c[2] * plane.normal[2]
      if (Math.abs(cp - op) > 1e-3) continue  // not on the resolved profile plane
      entrance = f
      break
    }
    if (entrance === null) { scope.release(solid); return { kind: 'failed' } }
    // The rebuilt body was only the source of the entrance cap face; its
    // shapes are no longer referenced, so drop it instead of letting a dead
    // solid ride the scope to the end of the build.
    const out = canonicalizeFaceCircles(oc, scope, entrance)
    scope.release(entrance)  // the returned face is the caller's copy; the original can go
    scope.release(solid)
    return { kind: 'merged', face: out }
  } catch (e) {
    swallowUnlessTrap(e)
    return { kind: 'failed' }
  }
}

/**
 * Prism a single profile face, then attach the per-profile-edge lineage keyed
 * by sub-shape identity. `lineageLoops` is the set of profile loops whose entity ids
 * the merged face's edges will be matched against (flat across groups for the
 * pre-prism-union path, the per-group loops for the single-group path).
 */
function prismFaceWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  profileFace: OccShape,
  lineageLoops: LoopEdge[][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  tokenPrefix: string,
  createdBy: string,
  sketchId: string,
  taperRad = 0,
): LineageResult {
  const builder = taperRad === 0
    ? scope.track(
        new oc.BRepPrimAPI_MakePrism_1(
          profileFace,
          scope.track(
            new oc.gp_Vec_4(
              directionVec[0] * distance,
              directionVec[1] * distance,
              directionVec[2] * distance,
            ),
          ),
          true,
          true,
        ),
      ) as OccPrismBuilder
    : draftPrismBuilder(oc, scope, profileFace, directionVec, distance, taperRad)
  if (!builder.IsDone()) throw new Error('prism builder did not complete')
  const solid = builder.Shape()
  // The profile face is read one last time here; afterwards the solid keeps
  // the shared TShapes alive, so the proxy itself can go.
  const face = scope.track(profileFace)
  const lineage = buildPrismLineageMap(oc, scope, face, builder, lineageLoops, plane, createdBy, sketchId)
  prefixLineageMaps(lineage, tokenPrefix)
  scope.release(face)
  return { solid, ...lineage }
}

/**
 * Fuse named parts into one solid, one part at a time, carrying the face names
 * through each fuse's history and through a final clean (`carryFaceNames`).
 * Ancestry maps are merged; edges are derived once, on the finished solid,
 * from its face adjacency. Every intermediate solid is released as soon as the
 * next one replaces it; `finish` hands the survivor over untracked.
 */
function namedFuse(oc: OccModule, scope: DisposeScope) {
  let solid: OccShape | null = null
  const names = emptyShapeNames()
  return {
    // `part` must be tracked in `scope`; it is consumed by the next fuse.
    add(part: OccShape, lineage: LineageMaps): void {
      Object.assign(names.faceAncestry, lineage.faceAncestry)
      Object.assign(names.edgeAncestry, lineage.edgeAncestry)
      if (solid === null) {
        solid = part
        names.faceNames = new SubShapeMap(lineage.faceNames)
        return
      }
      const res = booleanWithHistory(oc, scope, solid, part, 'fuse')
      const fused = scope.track(res.shape)
      names.faceNames = carryFaceNames(res.faceOrigin, names.faceNames, lineage.faceNames)
      scope.release(solid)  // the previous running solid is consumed by the fuse
      solid = fused
    },
    // `clean` folds coplanar caps and cocylindrical walls; a clean that rejects
    // the shape (a disjoint multi-solid compound, occasionally) keeps it raw.
    finish(clean: boolean, emptyMessage: string): LineageResult {
      if (solid === null) throw new Error(emptyMessage)
      let out: OccShape = solid
      if (clean) {
        try {
          const r = cleanWithHistory(oc, scope, out)
          const cleaned = scope.track(r.shape)
          const passThrough = canonicalFaces(oc, scope, out).map((f) => ({ output: f, source: f, fromTool: false }))
          names.faceNames = carryFaceNames(
            composeOriginThroughClean(oc, scope, passThrough, r.history, cleaned), names.faceNames, null,
          )
          scope.release(out)  // the previous running solid is consumed by the clean
          out = cleaned
        } catch (e) {
          swallowUnlessTrap(e)
          // kept raw solid -- segmentation faces survive but the volume is intact.
        }
      }
      // The prism pass, so an edge's ancestry tokens keep the order every
      // single-group prism gives them.
      const table = FaceEdgeTable.read(oc, scope, out)
      const { edgeNames, edgeAncestry } = derivePrismEdgeNames(oc, scope, table, names.faceNames, names.faceAncestry, '', false)
      names.edgeNames = edgeNames
      Object.assign(names.edgeAncestry, edgeAncestry)
      return { solid: scope.detach(out), ...names }
    },
  }
}

/**
 * Legacy per-group prism + fuse path (the fallback for a multi-group extrude
 * whose planar profile union cannot be safely reconstructed). Each group's
 * loops become one prism, prisms are fused, and the fused solid is cleaned
 * when more than one group survived -- producing a sound body whose every wall
 * nonetheless carries the internal seam at the source-region boundaries
 * (the documented 8-face defect on the peanut-with-hole add case).
 */
function perGroupPrismWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  groups: [LoopEdge[], LoopEdge[][]][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  tokenPrefix: string,
  createdBy: string,
  sketchId: string,
  taperRad = 0,
): LineageResult {
  const fuse = namedFuse(oc, scope)

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const [outer, holes] = groups[groupIdx]
    const face = scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane))
    const builder = taperRad === 0
      ? scope.track(
          new oc.BRepPrimAPI_MakePrism_1(
            face,
            scope.track(
              new oc.gp_Vec_4(
                directionVec[0] * distance,
                directionVec[1] * distance,
                directionVec[2] * distance,
              ),
            ),
            true,
            true,
          ),
        ) as OccPrismBuilder
      : draftPrismBuilder(oc, scope, face, directionVec, distance, taperRad)
    if (!builder.IsDone()) throw new Error('prism builder did not complete')
    const part = builder.Shape()
    // Each group's prism and each fuse output is consumed by the next fuse
    // except the survivor returned at the end; scope-own them all here and
    // detach only that survivor, which the caller takes over.
    scope.track(part)
    const lineage = buildPrismLineageMap(oc, scope, face, builder, [outer, ...holes], plane, createdBy, sketchId, groupIdx)
    prefixLineageMaps(lineage, tokenPrefix)
    // The profile face is dead once the lineage has been read off it.
    scope.release(face)
    fuse.add(part, lineage)
  }

  // The clean collapses the per-region coplanar caps into one each and the
  // cocylindrical walls into one. On a disjoint multi-solid compound (the
  // fallback path here) UnifySameDomain can occasionally reject the compound;
  // the un-merged raw solid is kept in that rare case rather than crash the
  // feature -- the caller side splits multi-solids.
  return fuse.finish(groups.length > 1, 'no loops to extrude')
}

/**
 * Extrude profile loops to a solid and return (solid + construction-name maps)
 * (mirrors `extrude_profile_with_lineage`). Disjoint loop groups are extruded
 * and fused; nested loops become holes. Lineage tokens are `@sketch_id/entity`.
 * OWNERSHIP: the returned `solid` is UNTRACKED. The caller must `scope.track()`
 * it or hand it to a registrar (`applyBodyOperation`, `registerSplitBodies`),
 * and is responsible for releasing it. This is the same contract every
 * `occ/primitives.ts` producer keeps; see the module header there.
 *
 * Multi-group extrudes take the "pre-prism profile union" path: the groups'
 * loops are extruded the legacy way (per-group prisms fused + cleaned), which
 * already yields ONE body whose every wall is a single face, but whose emergent
 * hole cylinder carries a non-canonical seam (the documented "8-face defect"
 * when this body is later the target of an add).  We then extract that body's
 * ENTRANCE cap face (which carries a canonical closed-circle hole edge -- a
 * side effect of the clean fusion of the cocylindrical half-cylinder walls),
 * canonicalize any remaining split-hole boundary, and re-prism the resulting
 * single face ONCE.  This rebuilds the same body with a canonical hole seam so a
 * downstream add-fuse that prisms this body's top face merges cleanly.  The
 * legacy per-prism fuse path survives as a fallback for the rare case that the
 * round-trip cannot recover a single canonical face.
 */
export function extrudeProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
  sketchId = '',
  createdBy = '',
  taperDeg = 0,
): LineageResult {
  // Classification reads the traced pieces (a tangent hole is recognised by the
  // arcs it shares with its neighbours), so fuse only after the groups exist.
  const groups = classifyLoops(loops).map(
    ([outer, holes]): [LoopEdge[], LoopEdge[][]] => [fuseCollinearRuns(outer), holes.map(fuseCollinearRuns)],
  )
  if (groups.length === 0) throw new Error('no loops to extrude')
  const tokenPrefix = sketchId ? `@${sketchId}/` : '@'
  const taperRad = (taperDeg * Math.PI) / 180

  if (groups.length === 1) {
    const [outer, holes] = groups[0]
    const face = sketchLoopsToFace(oc, scope, [outer, ...holes], plane)
    return prismFaceWithLineage(
      oc, scope, face, [outer, ...holes], plane, directionVec, distance, tokenPrefix, createdBy, sketchId, taperRad,
    )
  }

  // The canonical merged-profile round trip returns the union face itself; a
  // draft changes only the prism built from it, so the tapered path can use the
  // same merged face and then one draft prism rather than per-group frustums
  // (adjacent groups' inner walls lean apart and would not fuse).
  const merged = tryCanonicalMergedProfile(oc, scope, groups, plane, directionVec, distance)
  if (merged.kind === 'merged') {
    const lineageLoops = groups.flatMap(([outer, holes]) => [outer, ...holes])
    return prismFaceWithLineage(
      oc, scope, merged.face, lineageLoops, plane, directionVec, distance, tokenPrefix, createdBy, sketchId, taperRad,
    )
  }
  if (taperRad !== 0 && merged.kind !== 'disjoint') {
    throw new Error(
      'extrude: a taper on a multi-group profile needs one connected region; ' +
        'join the groups into one profile or remove the taper',
    )
  }

  return perGroupPrismWithLineage(
    oc, scope, groups, plane, directionVec, distance, tokenPrefix, createdBy, sketchId, taperRad,
  )
}

// ─── revolve (the revolve leaf's brep producer) ───

function makeAxis(oc: OccModule, scope: DisposeScope, origin: Vec3, direction: Vec3): OccShape {
  return scope.track(
    new oc.gp_Ax1_2(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_4(direction[0], direction[1], direction[2])),
    ),
  ) as unknown as OccShape
}

/**
 * Revolve a single face around an axis (mirrors `revolve_face` / `ocp_revolve`).
 * Returns the raw solid living in `scope`; the caller owns its lifetime.
 */
export function revolveFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  angleDeg: number,
): OccShape {
  if (angleDeg === 0) throw new Error('revolve angle must be non-zero')
  const ax = makeAxis(oc, scope, axisOrigin, axisDirection)
  const builder = scope.track(
    new oc.BRepPrimAPI_MakeRevol_1(face, ax as unknown as OccShape, (angleDeg * Math.PI) / 180, true),
  )
  if (!builder.IsDone()) throw new Error('revolve builder did not complete')
  return builder.Shape()
}

/**
 * Revolve profile loops around an axis and return (solid + construction-name
 * maps) (mirrors `revolve_profile_with_lineage`). Disjoint loop groups are
 * revolved and fused; nested loops become holes -- the same fan-out extrude has,
 * so two separate profile areas become a compound the caller side splits into
 * separate bodies (one Body == one OCC solid). A single group keeps the raw
 * one-face revolve. Lineage tokens are `@sketch_id/entity`; a multi-group
 * revolve keeps each group's tokens, merged onto the fused solid.
 * OWNERSHIP: the returned `solid` is UNTRACKED. The caller must `scope.track()`
 * it or hand it to a registrar (`applyBodyOperation`, `registerSplitBodies`),
 * and is responsible for releasing it. This is the same contract every
 * `occ/primitives.ts` producer keeps; see the module header there.
 */
export function revolveProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  angleDeg: number,
  sketchId = '',
  createdBy = '',
): LineageResult {
  const groups = classifyLoops(loops).map(
    ([outer, holes]): [LoopEdge[], LoopEdge[][]] => [fuseCollinearRuns(outer), holes.map(fuseCollinearRuns)],
  )
  if (groups.length === 0) throw new Error('no loops to revolve')
  const tokenPrefix = sketchId ? `@${sketchId}/` : '@'
  const angleRad = (angleDeg * Math.PI) / 180

  if (groups.length === 1) {
    const [outer, holes] = groups[0]
    const face = scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane))
    const ax = makeAxis(oc, scope, axisOrigin, axisDirection)
    const builder = scope.track(new oc.BRepPrimAPI_MakeRevol_1(face, ax as unknown as OccShape, angleRad, true))
    if (!builder.IsDone()) throw new Error('revolve builder did not complete')
    const solid = builder.Shape()
    const lineage = buildPrismLineageMap(oc, scope, face, builder, [outer, ...holes], plane, createdBy, sketchId)
    prefixLineageMaps(lineage, tokenPrefix)
    // The profile face is dead once the lineage has been read off it.
    scope.release(face)
    return { solid, ...lineage }
  }

  // Multi-group fan-out (mirrors perGroupPrismWithLineage): each group is one
  // revolve, the solids are fused. Disjoint groups stay a compound of solids --
  // the caller splits them into separate bodies. Adjacent groups (an area an
  // edit cut in two) fuse into one solid; the clean folds their coplanar seam
  // faces, and a clean that rejects the compound keeps the raw fused solid.
  const fuse = namedFuse(oc, scope)
  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const [outer, holes] = groups[groupIdx]
    const face = scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane))
    const ax = makeAxis(oc, scope, axisOrigin, axisDirection)
    const builder = scope.track(new oc.BRepPrimAPI_MakeRevol_1(face, ax as unknown as OccShape, angleRad, true))
    if (!builder.IsDone()) throw new Error('revolve builder did not complete')
    const part = builder.Shape()
    // Each group's solid and each fuse output is consumed by the next fuse
    // except the survivor returned at the end; scope-own them all here and
    // detach only that survivor, which the caller takes over.
    scope.track(part)
    const lineage = buildPrismLineageMap(oc, scope, face, builder, [outer, ...holes], plane, createdBy, sketchId, groupIdx)
    prefixLineageMaps(lineage, tokenPrefix)
    // The profile face is dead once the lineage has been read off it.
    scope.release(face)
    fuse.add(part, lineage)
  }
  return fuse.finish(true, 'no loops to revolve')
}

// ─── sweep (the sweep leaf's brep producer) ───

/**
 * Try each transition mode's pipe shell in order and return the first one
 * that builds a solid cleanly. Pure loop, no face/profile dependency, so it
 * unit-tests with a stub `oc.BRepOffsetAPI_MakePipeShell` (no WASM needed).
 *
 * `wires` is one wire for a single-profile sweep and one per section for a
 * multisection sweep; `Add_1` is called once per wire, in the given order, so
 * the single-wire call sequence is unchanged.
 *
 * `lastError` is reset at the top of every attempt: a mode that throws sets
 * it, but the NEXT attempt clears it again before trying, so a mode that
 * fails silently (no exception, just `IsDone()`/`MakeSolid()` false) never
 * reports a stale exception message from an earlier, different mode.
 *
 * OWNERSHIP: the returned `solid` stays TRACKED by `scope` even on the success
 * return, so a caller that throws in its own gates or lineage pass does not
 * strand it. The caller detaches it on ITS successful return, which is where
 * the untracked-shape contract every producer keeps begins.
 *
 * `mode` is the transition mode that built the solid. The sweep reuses it for
 * every hole loop: one spine plus one trihedron law is what keeps a hole wall
 * parallel to the outer one, and a hole that fell back to a different mode
 * would not be.
 */
export function attemptPipeShellSweep(
  oc: OccModule,
  scope: DisposeScope,
  spineWire: OccShape,
  wires: OccShape[],
  modes: OccEnumValue[],
  // When set, orient the trihedron to this fixed direction (binormal mode)
  // instead of the default CorrectedFrenet frame. A helix path uses the helix
  // axis so a radial profile keeps its relation to the axis (a thread).
  binormal: Vec3 | null = null,
): {
  result: { solid: OccShape; pipeBuilder: OccPipeShellBuilder; mode: OccEnumValue } | null
  lastError: unknown
} {
  let lastError: unknown = null
  for (const mode of modes) {
    lastError = null
    const builder = scope.track(new oc.BRepOffsetAPI_MakePipeShell(spineWire))
    try {
      builder.SetTransitionMode(mode)
      if (binormal !== null) {
        const dir = scope.track(new oc.gp_Dir_4(binormal[0], binormal[1], binormal[2]))
        builder.SetMode_3(dir)
      }
      for (const wire of wires) builder.Add_1(wire, false, false)
      builder.Build()
      if (builder.IsDone() && builder.MakeSolid()) {
        // Track it at creation: the callers' plausibility gates and lineage
        // pass can still throw, and this shape would be stranded there.
        const solid = scope.track(builder.Shape())
        return { result: { solid, pipeBuilder: builder, mode }, lastError: null }
      }
    } catch (e) {
      swallowUnlessTrap(e)
      lastError = e
    }
  }
  return { result: null, lastError }
}

/**
 * The profile face's hole wires, tracked by `scope`, in explorer order. The
 * outer wire is the one `BRepTools.OuterWire` names; every other wire bounds a
 * hole and is swept into the pipe shell that cuts it out.
 */
function innerFaceWires(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  outerWire: OccShape,
): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const wire = scope.track(oc.TopoDS.Wire_1(raw))
    if (!(wire as OccSubShape).IsSame(outerWire as OccSubShape)) out.push(wire)
  }
  return out
}

/** The sketch entity ids whose profile edges built `wire`, for a refusal that
 *  names the hole the user drew instead of a loop ordinal. */
function wireEntityIds(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  loops: LoopEdge[][],
  plane: PlaneLike,
): string[] {
  const E = oc.TopAbs_ShapeEnum
  const edges: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    edges.push(scope.track(oc.TopoDS.Edge_1(scope.track(exp.Current()))))
  }
  const ids = entityForEdges(oc, scope, edges, loops, plane)
    .flatMap((entity) => {
      if (entity === null) return []
      const id = String(entity['id'] ?? '')
      return id === '' ? [] : [id]
    })
  return [...new Set(ids)].sort()
}

/** The one refusal a hole loop that cannot be carried gets: named, never a
 *  silently solid body. */
function holeSweepFailure(ids: string[]): Error {
  return new Error(
    `sweep: the hole loop ${ids.length > 0 ? ids.join(', ') : '(unnamed)'} ` +
    'could not be swept along the path',
  )
}

/**
 * Sweep profile loops along a spine wire and return (solid + construction-name
 * maps) (mirrors `sweep_profile_with_lineage`). The profile's holes are carried
 * too: each inner wire is swept with the same spine, transition mode and
 * trihedron law as the outer one, and the inner solids are cut out of the outer
 * one in a single boolean. Lineage comes from MakePipeShell.Generated() over
 * each wire's profile edges, composed through the cut history so the bore wall
 * keeps its sketch entity's name. The spine edges are pre-built world-space OCC
 * edges. RightCorner transition gives a clean mitre at sharp (C0) spine joints.
 * A hole whose shell does not build, or whose cut leaves an invalid solid,
 * fails the feature by name instead of building the hole as material.
 * OWNERSHIP: the returned `solid` is UNTRACKED. The caller must `scope.track()`
 * it or hand it to a registrar (`applyBodyOperation`, `registerSplitBodies`),
 * and is responsible for releasing it. This is the same contract every
 * `occ/primitives.ts` producer keeps; see the module header there.
 */
export function sweepProfileWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  loops: LoopEdge[][],
  plane: PlaneLike,
  spineEdges: OccShape[],
  sketchId = '',
  createdBy = '',
  binormal: Vec3 | null = null,
  roundCorners = false,
): LineageResult {
  if (loops.length === 0) throw new Error('sweep: no profile loops')
  if (spineEdges.length === 0) throw new Error('sweep: empty path')

  const fusedLoops = loops.map(fuseCollinearRuns)
  const face = scope.track(sketchLoopsToFace(oc, scope, fusedLoops, plane))
  // The raw wire inputs are consumed by their heal pass; the healed wires are
  // consumed by the pipe shell. All of them would otherwise outlive the build.
  const rawSpineWire = scope.track(makeWire(oc, scope, spineEdges))
  const spineWire = scope.track(healWire(oc, scope, rawSpineWire))
  const rawOuterWire = scope.track(oc.BRepTools.OuterWire(face))
  const outerWire = scope.track(healWire(oc, scope, rawOuterWire))
  // Hole wires come off the face reversed (clockwise). MakePipeShell measures
  // the swept solid from the wire's geometry, so the hole shell comes out
  // positive either way (spiked as-is and reversed: the same tube), and healing
  // it is the same pass the outer wire gets so its edges land on their sketch
  // entities again.
  const rawHoleWires = innerFaceWires(oc, scope, face, rawOuterWire)
  const holeWires = rawHoleWires.map((raw) => {
    const healed = scope.track(healWire(oc, scope, raw))
    scope.release(raw)
    return healed
  })
  scope.release(rawSpineWire)
  scope.release(rawOuterWire)

  // A round corner falls back to the mitre like the mitre falls back to
  // Transformed, so a refused arc never turns a buildable sweep into an error.
  const modes = [
    ...(roundCorners ? [oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner] : []),
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
  ]
  const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, [outerWire], modes, binormal)
  if (lastError !== null) {
    const msg = extractErrorMessage(lastError)
    throw new Error(`sweep: BRepOffsetAPI_MakePipeShell failed: ${msg}`)
  }
  if (result === null) throw new Error('sweep: could not build a solid from the swept shell')
  const { solid, pipeBuilder, mode } = result

  const lineage = buildPrismLineageMap(
    oc, scope, face, pipeBuilder, fusedLoops, plane, createdBy, sketchId, 0, outerWire,
  )
  if (holeWires.length === 0) {
    // The shell builder holds its own handle to the spine wire.
    scope.release(spineWire)
    // The shell builder held its own handle to the outer wire; it must outlive
    // the lineage call above, which explores its edges for the profile mapping.
    scope.release(outerWire)
    prefixLineageMaps(lineage, sketchId ? `@${sketchId}/` : '@')
    scope.release(face)
    // The solid rode the scope so a throw above could not strand it; ownership
    // passes to the caller here, per the contract above.
    return { solid: scope.detach(solid), ...lineage }
  }

  // The outer shell succeeded with `mode`, so try that mode first on every hole
  // loop: the same spine plus the same trihedron law is what keeps the inner
  // wall parallel to the outer one, and only then may a hole fall back.
  const innerWireIds = (wire: OccShape): string[] =>
    wireEntityIds(oc, scope, wire, fusedLoops, plane)
  const holeModes = [mode, ...modes.filter((candidate) => candidate.value !== mode.value)]
  const holeSolids: OccShape[] = []
  const holeLineages: LineageMaps[] = []
  for (const holeWire of holeWires) {
    const attempt = attemptPipeShellSweep(oc, scope, spineWire, [holeWire], holeModes, binormal)
    if (attempt.result === null) throw holeSweepFailure(innerWireIds(holeWire))
    const inner = attempt.result
    holeSolids.push(inner.solid)
    // The group index keeps a hole's cap UUID out of the outer caps' name
    // space. The hole caps are cut away, so their names are never carried.
    holeLineages.push(buildPrismLineageMap(
      oc, scope, face, inner.pipeBuilder, fusedLoops, plane, createdBy, sketchId,
      holeSolids.length, holeWire,
    ))
  }
  scope.release(spineWire)

  const cut = booleanWithHistoryMany(oc, scope, solid, holeSolids, 'cut')
  const cutSolid = scope.track(cut.shape)
  for (const holeSolid of holeSolids) scope.release(holeSolid)
  scope.release(solid)
  // A cut that leaves an invalid solid is a hole the kernel could not carry: a
  // self-intersecting inner wall can pass the tool's own BRepCheck and still
  // poison the result. Never ship the outer body as if the hole were not there.
  const holeIds = [...new Set(holeWires.flatMap((wire) => innerWireIds(wire)))].sort()
  if (!shapeIsValid(oc, scope, cutSolid) || countSolids(oc, scope, cutSolid) !== 1) {
    throw holeSweepFailure(holeIds)
  }

  // The outer and inner names both travel through the cut: a source face maps
  // to the output face(s) the boolean says it became, so the caps become the
  // annular caps and the bore keeps the hole entity's UUID. The inner names go
  // in as `tool` names; carryFaceNames prefers the target's source otherwise.
  const toolNames = new SubShapeMap<string>()
  for (const inner of holeLineages) toolNames.assign(inner.faceNames)
  const faceNames = carryFaceNames(cut.faceOrigin, lineage.faceNames, toolNames)
  const faceAncestry = { ...lineage.faceAncestry }
  // The hole shells' own caps are cut away, so only the OUTER shell's cap
  // tokens describe the annular caps the cut leaves; merging the inner cap
  // ancestry would put UUIDs on the body that no face carries.
  const capAncestry = { ...lineage.capAncestry }
  for (const inner of holeLineages) Object.assign(faceAncestry, inner.faceAncestry)
  const table = FaceEdgeTable.read(oc, scope, cutSolid)
  // A face the cut split or left out of the origin table is named off its
  // named neighbours, exactly as the uncut prism path does.
  nameFacesFromNeighbours(oc, scope, table, faceNames, faceAncestry)
  // Edges are derived once, on the cut result: the per-shell edge names are
  // keyed to the uncut shells and no longer describe this solid.
  const { edgeNames, edgeAncestry } = createdBy
    ? derivePrismEdgeNames(oc, scope, table, faceNames, faceAncestry, createdBy)
    : { edgeNames: new SubShapeMap<string>(), edgeAncestry: {} }

  scope.release(outerWire)
  for (const holeWire of holeWires) scope.release(holeWire)
  scope.release(face)
  const out: LineageMaps = { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry }
  prefixLineageMaps(out, sketchId ? `@${sketchId}/` : '@')
  return { solid: scope.detach(cutSolid), ...out }
}
