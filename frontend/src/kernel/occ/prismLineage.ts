// `_build_prism_lineage_map`, `extrude_profile_with_lineage`. This is the OCC
// adapter the extrude/revolve/sweep leaves call to turn a built solid plus its
// generating profile face into the per-face / per-edge lineage keyed by
// copy-stable geometry hash.
//
// Lineage keying mirrors lineage-stable-keying.md: faces/edges are keyed by their geometry
// hash, not the copy-fragile OCC subshape hash, so the tokens survive the shape copies the
// build pipeline does. The profile-edge -> lateral face association comes from
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
import { classifyLoops, type LoopEdge } from '../profileLoops'
import { booleanWithHistory, cleanWithHistory, countSolids } from './booleans'
import { FaceEdgeTable, nameFacesFromNeighbours } from './constructionLineage'
import { mintFaceUuid, sideFacePath, capFacePath } from '../constructionName'
import { sketchLoopsToFace, canonicalizeFaceCircles } from './prismProfile'
import { entityForEdges, derivePrismEdgeNames } from './prismEdgeNaming'

// Kept as the public entry points for the profile -> face step and its
// canonicalizing core, which the real-OCC gates import from here.
export { sketchLoopsToFace, canonicalizeFaceCirclesWith } from './prismProfile'

// ─── prism lineage ───

/** The construction-name maps for a built solid (see LineageResult). */
export interface LineageMaps {
  faceNames: Record<string, string>  // faceGh -> face uuid
  edgeNames: Record<string, string>  // edgeGh -> edge uuid
  faceAncestry: Record<string, string[]>  // face uuid -> ancestral tokens
  edgeAncestry: Record<string, string[]>  // edge uuid -> ancestral tokens
}

function emptyLineageMaps(): LineageMaps {
  return { faceNames: {}, edgeNames: {}, faceAncestry: {}, edgeAncestry: {} }
}

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
    } catch {
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
 * caps). `capRoleGhs` is the face-gh set of EVERY planar face with the profile
 * face's area, named or not: the faces whose only legitimate names come from
 * the cap path. The caller passes it to the neighbour pass as a skip set, so a
 * cap the cap path could not reach (its builder omitted FirstShape/LastShape
 * and the probe found no translation pair) stays exactly as the old wire output
 * left it -- unnamed -- instead of being reclassified as a corner face.
 */
function geometricCapFaces(
  oc: OccModule,
  scope: DisposeScope,
  faces: FaceEdgeTable,
  occFace: OccShape,
): { caps: { face: OccSubShape; which: 'start' | 'end' }[]; capRoleGhs: ReadonlySet<string> } {
  let pc: Vec3
  let pn: Vec3
  let pa: number
  try {
    pc = faceCentroid(oc, scope, occFace)
    pn = faceNormal(oc, scope, occFace)
    pa = faceArea(oc, scope, occFace)
  } catch {
    return { caps: [], capRoleGhs: new Set() }
  }
  const candidates: { face: OccSubShape; d: number }[] = []
  const capRoleGhs = new Set<string>()
  for (const row of faces.rows) {
    // A row whose centroid/normal read failed (undefined UV-midpoint normal) is
    // skipped exactly as the old per-face try/catch-continue over `solid` did.
    if (row.gh === null) continue
    const n = row.normal
    const c = row.centroid
    if (n === null || c === null) continue
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
    capRoleGhs.add(row.gh)
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
  if (candidates.length !== 2) return { caps: [], capRoleGhs }
  // Sort by absolute distance so the cap coincident with the profile plane is
  // always `start`, regardless of which side the sweep extends toward.
  candidates.sort((x, y) => Math.abs(x.d) - Math.abs(y.d))
  return {
    caps: [
      { face: candidates[0].face, which: 'start' },
      { face: candidates[1].face, which: 'end' },
    ],
    capRoleGhs,
  }
}

/**
 * The construction-name maps for an extruded solid
 * (query-naming-by-construction.md). Internally builds a geom-hash-keyed
 * face/edge lineage (mirrors `_build_prism_lineage_map`) from the raw profile
 * entity ids, used only to seed each UUID's ancestral tokens (the caller
 * prepends `@sketch_id/`). When `createdBy` is non-empty, each side/cap face is
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
  const edgeEids = entityForEdges(oc, scope, profEdges, loops, plane)

  // profile edge -> generated lateral face(s) via Generated(). Match these to
  // solid faces by subshape identity (IsSame), NOT by geom hash: Generated()
  // can return a face whose orientation -- and therefore normal-sign-dependent
  // geom hash -- differs from the same face as it sits in the solid shell.
  const genFaces: { face: OccSubShape; eid: string }[] = []
  // Multi, not single: one generated face can be reached from more than one
  // profile edge, and the main loop's old genFaces.find took the FIRST -- so
  // the index must too, hence get()[0] preserves the first-wins tie-break.
  const genIdx = new SubShapeMultiIndex<{ face: OccSubShape; eid: string }>()
  for (let i = 0; i < profEdges.length; i++) {
    const eid = edgeEids[i]
    if (!eid) continue
    let generated: OccShape[]
    try {
      generated = drainList(scope, prismBuilder.Generated(profEdges[i]))
    } catch {
      continue
    }
    for (const g of generated) {
      const gexp = scope.track(new oc.TopExp_Explorer_2(g, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; gexp.More(); gexp.Next()) {
        const raw = scope.track(gexp.Current())
        const entry = { face: scope.track(oc.TopoDS.Face_1(raw)) as OccSubShape, eid }
        genFaces.push(entry)
        genIdx.add(entry.face, entry)
      }
    }
  }
  if (profEdges.length > 0 && edgeEids.some((e) => e) && genFaces.length === 0) {
    throw new Error(
      'sweep/prism lineage: the builder generated no face for any profile edge ' +
      `(${profEdges.length} edges); the swept wire and the queried edges disagree`,
    )
  }

  // Caps named from the builder's FirstShape/LastShape; when the builder omits
  // them (or they throw), the geometric fallback derives the two caps from the
  // profile face itself so a cap's identity never depends on builder reporting.
  const capCandidates = createdBy ? capGeneratedFaces(oc, scope, prismBuilder) : []
  let capRoleGhs: ReadonlySet<string> | undefined
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
    capRoleGhs = geo.capRoleGhs
  }

  // solid face -> tokens + construction uuid, keyed by geometry hash. Also track
  // each face's uuid and, per edge, its geom hash + the adjacent face ghs.
  const faceLineage: Record<string, string[]> = {}
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  const adjacency: Record<string, Set<string>> = {}  // edge gh -> set of adjacent face gh
  const edgeShapes: Record<string, OccShape> = {}  // edge gh -> a representative edge
  for (const row of faces.rows) {
    // Same fail-loud rule as the naming passes: the direct faceGh call sat at
    // the top of every face iteration, and rows are explorer order, so the
    // throw lands on the same face at the same point as before.
    if (row.gh === null) throw row.ghError
    const gh = row.gh
    const sf = row.face
    const match = genIdx.get(sf)[0]
    faceLineage[gh] = match !== undefined ? [match.eid] : []
    if (createdBy) {
      let uuid: string | null = null
      if (match !== undefined) {
        const slot = sketchId ? `${sketchId}/${match.eid}` : match.eid
        uuid = mintFaceUuid(sideFacePath(createdBy, slot))
      } else {
        // capCandidates is at most two faces; a linear IsSame find over it is
        // cheaper than an index build, so it stays a find.
        const cap = capCandidates.find((c) => (sf as OccSubShape).IsSame(c.face))
        if (cap) uuid = mintFaceUuid(capFacePath(createdBy, cap.which, groupIndex))
      }
      if (uuid !== null) {
        faceNames[gh] = uuid
        faceAncestry[uuid] = [...faceLineage[gh]]
      }
    }
    for (const { egh, edge } of row.edges) {
      ;(adjacency[egh] ??= new Set()).add(gh)
      edgeShapes[egh] ??= edge
    }
  }

  // A face the generated/cap match missed (e.g. a merged-profile side face the
  // profile union trimmed off its source entity) is named off its named
  // neighbours, so its edges do not all fall back to the body-wide ancestral
  // query. Must run BEFORE the edge derivation, which needs both faces of an
  // edge named. Cap-role faces are skipped: their only legitimate name comes
  // from the cap path, and a cap the path could not reach stays unnamed so the
  // output stays byte-identical to the pre-neighbour-pass wire.
  nameFacesFromNeighbours(oc, scope, faces, faceNames, faceAncestry, capRoleGhs)

  // solid edge -> construction uuid, derived from its two adjacent face uuids.
  const { edgeNames, edgeAncestry } = createdBy
    ? derivePrismEdgeNames(oc, scope, solid, adjacency, faceNames, faceAncestry, edgeShapes, createdBy)
    : { edgeNames: {}, edgeAncestry: {} }

  scope.release(solid)
  return { faceNames, edgeNames, faceAncestry, edgeAncestry }
}

/** Prefix bare (non-@) tokens in every value list of a token map, in place. */
function prefixTokens(lineage: Record<string, string[]>, prefix: string): void {
  for (const key of Object.keys(lineage)) {
    lineage[key] = lineage[key].map((t) => (t.startsWith('@') ? t : prefix + t))
  }
}

/** Prefix the two ancestry maps of a LineageMaps in place. */
function prefixLineageMaps(maps: LineageMaps, prefix: string): void {
  prefixTokens(maps.faceAncestry, prefix)
  prefixTokens(maps.edgeAncestry, prefix)
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
 * Returns the canonical profile face, or null when the round-trip cannot
 * produce one safely (the caller then keeps the legacy multi-face body).
 */
function tryCanonicalMergedProfile(
  oc: OccModule,
  scope: DisposeScope,
  groups: [LoopEdge[], LoopEdge[][]][],
  plane: PlaneLike,
  directionVec: Vec3,
  distance: number,
): OccShape | null {
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
    if (countSolids(oc, scope, solid) !== 1) { scope.release(solid); return null }
    try {
      const cleaned = cleanWithHistory(oc, scope, solid).shape
      scope.track(cleaned)
      scope.release(solid)  // the previous running solid is consumed by the clean
      solid = cleaned
    } catch {
      // The prism-fuse-clean is the legacy path -- the only throw the
      // diagnostics pinned was the periodic-cylinder face merge (now avoided
      // here because this solid is the build target, never the add tool). Any
      // other throw means we cannot get a canonical cap cleanly -> bail.
      return null
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
    if (entrance === null) { scope.release(solid); return null }
    // The rebuilt body was only the source of the entrance cap face; its
    // shapes are no longer referenced, so drop it instead of letting a dead
    // solid ride the scope to the end of the build.
    const out = canonicalizeFaceCircles(oc, scope, entrance)
    scope.release(entrance)  // the returned face is the caller's copy; the original can go
    scope.release(solid)
    return out
  } catch {
    return null
  }
}

/**
 * Prism a single profile face, then attach the per-profile-edge lineage keyed
 * by geometry hash. `lineageLoops` is the set of profile loops whose entity ids
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
): LineageResult {
  const builder = scope.track(
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
): LineageResult {
  let solid: OccShape | null = null
  const merged = emptyLineageMaps()

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const [outer, holes] = groups[groupIdx]
    const face = scope.track(sketchLoopsToFace(oc, scope, [outer, ...holes], plane))
    const builder = scope.track(
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
    Object.assign(merged.faceNames, lineage.faceNames)
    Object.assign(merged.edgeNames, lineage.edgeNames)
    Object.assign(merged.faceAncestry, lineage.faceAncestry)
    Object.assign(merged.edgeAncestry, lineage.edgeAncestry)

    if (solid === null) {
      solid = part
    } else {
      const fused: OccShape = booleanWithHistory(oc, scope, solid, part, 'fuse').shape
      scope.track(fused)
      scope.release(solid)  // the previous running solid is consumed by the fuse
      solid = fused
    }
  }

  if (solid === null) throw new Error('no loops to extrude')
  if (groups.length > 1) {
    // cleanWithHistory collapses the per-region coplanar caps into one each
    // and the cocylindrical walls into one.  On a disjoint multi-solid
    // compound (the fallback path here) UnifySameDomain can occasionally
    // reject the compound; keep the un-merged raw_solid in that rare case
    // rather than crash the feature -- the caller side splits multi-solids.
    try {
      const cleaned = cleanWithHistory(oc, scope, solid).shape
      scope.track(cleaned)
      scope.release(solid)  // the previous running solid is consumed by the clean
      solid = cleaned
    } catch {
      // kept raw solid -- segmentation faces survive but the volume is intact.
    }
  }
  return { solid: scope.detach(solid), ...merged }
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
): LineageResult {
  const groups = classifyLoops(loops)
  if (groups.length === 0) throw new Error('no loops to extrude')
  const tokenPrefix = sketchId ? `@${sketchId}/` : '@'

  if (groups.length === 1) {
    const [outer, holes] = groups[0]
    const face = sketchLoopsToFace(oc, scope, [outer, ...holes], plane)
    return prismFaceWithLineage(oc, scope, face, [outer, ...holes], plane, directionVec, distance, tokenPrefix, createdBy, sketchId)
  }

  const merged = tryCanonicalMergedProfile(oc, scope, groups, plane, directionVec, distance)
  if (merged !== null) {
    const lineageLoops = groups.flatMap(([outer, holes]) => [outer, ...holes])
    return prismFaceWithLineage(oc, scope, merged, lineageLoops, plane, directionVec, distance, tokenPrefix, createdBy, sketchId)
  }

  return perGroupPrismWithLineage(oc, scope, groups, plane, directionVec, distance, tokenPrefix, createdBy, sketchId)
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
  const groups = classifyLoops(loops)
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
  let solid: OccShape | null = null
  const merged = emptyLineageMaps()
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
    Object.assign(merged.faceNames, lineage.faceNames)
    Object.assign(merged.edgeNames, lineage.edgeNames)
    Object.assign(merged.faceAncestry, lineage.faceAncestry)
    Object.assign(merged.edgeAncestry, lineage.edgeAncestry)

    if (solid === null) {
      solid = part
    } else {
      const fused: OccShape = booleanWithHistory(oc, scope, solid, part, 'fuse').shape
      scope.track(fused)
      scope.release(solid)  // the previous running solid is consumed by the fuse
      solid = fused
    }
  }
  if (solid === null) throw new Error('no loops to revolve')
  try {
    const cleaned = cleanWithHistory(oc, scope, solid).shape
    scope.track(cleaned)
    scope.release(solid)  // the previous running solid is consumed by the clean
    solid = cleaned
  } catch {
    // kept raw fused solid -- segmentation faces survive but the volume is intact.
  }
  return { solid: scope.detach(solid), ...merged }
}

// ─── sweep (the sweep leaf's brep producer) ───

/**
 * Try each transition mode's pipe shell in order and return the first one
 * that builds a solid cleanly. Pure loop, no face/profile dependency, so it
 * unit-tests with a stub `oc.BRepOffsetAPI_MakePipeShell` (no WASM needed).
 *
 * `lastError` is reset at the top of every attempt: a mode that throws sets
 * it, but the NEXT attempt clears it again before trying, so a mode that
 * fails silently (no exception, just `IsDone()`/`MakeSolid()` false) never
 * reports a stale exception message from an earlier, different mode.
 */
export function attemptPipeShellSweep(
  oc: OccModule,
  scope: DisposeScope,
  spineWire: OccShape,
  outerWire: OccShape,
  modes: OccEnumValue[],
): { result: { solid: OccShape; pipeBuilder: OccPipeShellBuilder } | null; lastError: unknown } {
  let lastError: unknown = null
  for (const mode of modes) {
    lastError = null
    const builder = scope.track(new oc.BRepOffsetAPI_MakePipeShell(spineWire))
    try {
      builder.SetTransitionMode(mode)
      builder.Add_1(outerWire, false, false)
      builder.Build()
      if (builder.IsDone() && builder.MakeSolid()) {
        return { result: { solid: builder.Shape(), pipeBuilder: builder }, lastError: null }
      }
    } catch (e) {
      lastError = e
    }
  }
  return { result: null, lastError }
}

/**
 * Sweep profile loops along a spine wire and return (solid + construction-name
 * maps) (mirrors `sweep_profile_with_lineage`). Only the profile's OUTER
 * boundary is swept (holes are not carried through the pipe shell, matching
 * Python); lineage still comes from MakePipeShell.Generated() over the face's
 * profile edges. The spine edges are pre-built world-space OCC edges. RightCorner
 * transition gives a clean mitre at sharp (C0) spine joints.
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
): LineageResult {
  if (loops.length === 0) throw new Error('sweep: no profile loops')
  if (spineEdges.length === 0) throw new Error('sweep: empty path')

  const face = scope.track(sketchLoopsToFace(oc, scope, loops, plane))
  // The raw wire inputs are consumed by their heal pass; the healed wires are
  // consumed by the pipe shell. All four would otherwise outlive the build.
  const rawSpineWire = scope.track(makeWire(oc, scope, spineEdges))
  const spineWire = scope.track(healWire(oc, scope, rawSpineWire))
  const rawOuterWire = scope.track(oc.BRepTools.OuterWire(face))
  const outerWire = scope.track(healWire(oc, scope, rawOuterWire))
  scope.release(rawSpineWire)
  scope.release(rawOuterWire)

  const modes = [
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner,
    oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_Transformed,
  ]
  const { result, lastError } = attemptPipeShellSweep(oc, scope, spineWire, outerWire, modes)
  if (lastError !== null) {
    const msg = extractErrorMessage(lastError)
    throw new Error(`sweep: BRepOffsetAPI_MakePipeShell failed: ${msg}`)
  }
  if (result === null) throw new Error('sweep: could not build a solid from the swept shell')
  const { solid, pipeBuilder } = result
  // The shell builder holds its own handle to the spine wire.
  scope.release(spineWire)

  const lineage = buildPrismLineageMap(
    oc, scope, face, pipeBuilder, loops, plane, createdBy, sketchId, 0, outerWire,
  )
  // The shell builder held its own handle to the outer wire; it must outlive
  // the lineage call above, which explores its edges for the profile mapping.
  scope.release(outerWire)
  prefixLineageMaps(lineage, sketchId ? `@${sketchId}/` : '@')
  scope.release(face)
  return { solid, ...lineage }
}
