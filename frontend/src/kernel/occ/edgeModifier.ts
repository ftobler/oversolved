// `_apply_edge_modifier`, `ocp_edge_modifier_diff`, and the public
// `apply_fillet_with_lineage` / `apply_chamfer_with_lineage`. This is the OCC adapter the
// fillet/chamfer leaf (features/filletChamfer.ts) calls to round/bevel a set of edges on a
// solid, transfer the pre-op construction names through the operation, and produce the BrepDiff.
//
// The modifier history (IsDeleted/Modified/Generated) drives both the name transfer (see
// extractNames) and the diff classification; the fillet faces generated from modified edges land
// in new_faces (no input-face preimage), so the builder's @created_by rewrite attributes them to
// the modifying feature.

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccEdgeModifierMaker, OccShapeEnumValue } from './occTypes'
import { faceCentroid, edgeToGeom, SubShapeIndexMap } from './primitives'
import { edgeGeometryHash } from '../geomHash'
import { faceGh, edgeGh } from './lineageHash'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { mintFaceUuid, filletFacePath, splitFacePath, orderSplitChildren, type SplitChild } from '../constructionName'
import {
  nameNeighboursAndDeriveEdges,
  faceSplitKey,
  shapeNormalFrame,
  normalizedWorldKey,
  type NormalFrame,
} from './constructionLineage'

type Lineage = Record<string, string[]>
type Names = Record<string, string>

/** The pre-op construction-name maps the modifier carries forward. */
export interface OldNames {
  createdBy: string
  faceNames: Names
  edgeNames: Names
  faceAncestry: Lineage
  edgeAncestry: Lineage
}

/** The rebuilt construction-name maps after a fillet/chamfer. */
export interface NewNames {
  faceNames: Names
  edgeNames: Names
  faceAncestry: Lineage
  edgeAncestry: Lineage
}

export interface EdgeModifierResult {
  shape: OccShape
  success: boolean
  reason: string | null
  names: NewNames | null
  diff: BrepDiff
  /** Indices into the `edges` argument that were not applied (not in the shape,
   *  or `addEdge` threw). Indices, not geom hashes: only the caller knows which
   *  query produced each edge, and a hash cannot be matched back to one. */
  skippedEdgeIndices: number[]
}

function asFace(oc: OccModule, s: OccShape): OccSubShape {
  return oc.TopoDS.Face_1(s) as OccSubShape
}

// Walk a shape's sub-shapes of one kind, downcasting each to its concrete type.
function explore(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  kind: object,
  cast: (s: OccShape) => OccShape,
): OccShape[] {
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, kind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    out.push(scope.track(cast(raw)))
  }
  return out
}

function exploreFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return explore(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, (s) => oc.TopoDS.Face_1(s))
}

function exploreEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return explore(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, (s) => oc.TopoDS.Edge_1(s))
}

/**
 * Rebuilt construction-name maps after a fillet/chamfer (query-naming-by-
 * construction). Inherited faces carry their source UUID across the op by
 * `maker.Modified()` subshape identity (a split orders its children); the fillet
 * faces generated from a modified edge are minted `role=fillet` UUIDs slotted by
 * the filleted edge's UUID. Edge names are derived from the output face
 * adjacency. Geometry never enters an identity, only the split ordering.
 */
export function extractNames(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccEdgeModifierMaker,
  newShape: OccShape,
  modifiedEdges: OccShape[],
  old: OldNames,
  oldFaces: OccShape[],
  newFaces: OccShape[],
  oldFaceIdx: SubShapeIndexMap,
  oldFaceModified: Map<number, OccShape[]>,
): NewNames {
  const faceNames: Names = {}
  const faceAncestry: Lineage = {}
  // Keys a merge collision already cancelled: the two faces that merged into
  // one dropped their names, so the key is up for grabs. A third face
  // modifying to the same output must not re-claim it -- topology order would
  // pick whichever, and the name was deliberately left to the neighbours.
  const mergedAway = new Set<string>()
  // Generated-face centroids are world coordinates: normalize them by the new
  // solid's span so the split-sibling refusal is relative, not unit-dependent.
  let frame: NormalFrame | null = null

  // Modified()/Generated() hand back faces carrying a FORWARD orientation, but
  // every downstream consumer (deriveEdgeNames, tessellation, registration)
  // explores faces from the built SOLID, where the shell orients each face
  // outward. faceGh is normal-signed, so the two disagree for any face the op
  // reshaped, leaving its edges unnamed. Canonicalize every minted key to the
  // built-solid face reached by IsSame (orientation-independent identity).
  const builtFaces = newFaces
  const builtIdx = new SubShapeIndexMap()
  const builtGhMemo = new Array<string>(builtFaces.length)
  builtFaces.forEach((bf, i) => builtIdx.set(bf as OccSubShape, i))
  const builtGh = (f: OccShape): string => {
    // `same ?? f` fallback: a Modified() image with no built-solid counterpart
    // is still hashed as itself.
    const at = builtIdx.get(f as OccSubShape)
    if (at >= 0) return (builtGhMemo[at] ??= faceGh(oc, scope, asFace(oc, builtFaces[at])))
    return faceGh(oc, scope, asFace(oc, f))
  }

  // Step 1: old named faces -> output faces via Modified() (subshape identity).
  for (const oldF of oldFaces) {
    const oldGh = faceGh(oc, scope, asFace(oc, oldF))
    const uuid = old.faceNames[oldGh]
    if (!uuid) continue
    let deleted = false
    try {
      deleted = maker.IsDeleted(oldF)
    } catch {
      deleted = false
    }
    if (deleted) continue
    const ancestry = old.faceAncestry[uuid] ?? []
    const mods = oldFaceModified.get(oldFaceIdx.get(oldF as OccSubShape)) ?? []
    if (mods.length === 0) {
      // Unchanged face: its geom-hash key persists, so the UUID carries by key.
      faceNames[oldGh] = uuid
      faceAncestry[uuid] = [...ancestry]
    } else if (mods.length === 1) {
      const key = builtGh(mods[0])
      const prior = faceNames[key]
      if (prior !== undefined && prior !== uuid) {
        // Two named faces merged into one. Whichever we kept would be picked by
        // topology order, which is not construction-stable. Drop both and let
        // nameFacesFromNeighbours mint a name from the surviving neighbourhood.
        delete faceNames[key]
        delete faceAncestry[prior]
        mergedAway.add(key)
        continue
      }
      if (mergedAway.has(key)) continue
      faceNames[key] = uuid
      faceAncestry[uuid] = [...ancestry]
    } else {
      const ordered = orderSplitChildren(
        mods.map<SplitChild<OccShape>>((m) => ({ item: m, key: faceSplitKey(oc, scope, oldF, asFace(oc, m)) })),
      )
      if (ordered === null) continue  // ambiguous -> ancestral fallback
      ordered.forEach((m, i) => {
        const childUuid = mintFaceUuid(splitFacePath(uuid, i))
        faceNames[builtGh(m)] = childUuid
        faceAncestry[childUuid] = [...ancestry]
      })
    }
  }

  // Step 2: modified edges -> generated fillet faces, minted role=fillet.
  for (const edge of modifiedEdges) {
    const egh = edgeGh(oc, scope, edge)
    const edgeUuid = egh !== null ? old.edgeNames[egh] : undefined
    if (!edgeUuid) continue
    const edgeAncestry = old.edgeAncestry[edgeUuid] ?? []
    let generated: OccShape[]
    try {
      generated = drainList(scope, maker.Generated(edge))
    } catch {
      continue
    }
    const genFaces: OccShape[] = []
    for (const g of generated) for (const gf of exploreFaces(oc, scope, g)) genFaces.push(gf)
    const base = mintFaceUuid(filletFacePath(old.createdBy, edgeUuid))
    const assign = (face: OccShape, uuid: string): void => {
      const gh = builtGh(face)
      if (gh in faceNames) return
      faceNames[gh] = uuid
      faceAncestry[uuid] = [...edgeAncestry]
    }
    if (genFaces.length === 1) {
      assign(genFaces[0], base)
    } else if (genFaces.length > 1) {
      frame ??= shapeNormalFrame(oc, scope, newShape)
      const f0 = frame
      const ordered = orderSplitChildren(
        genFaces.map<SplitChild<OccShape>>((f) => ({
          item: f,
          key: normalizedWorldKey(f0, faceCentroid(oc, scope, asFace(oc, f))),
        })),
      )
      if (ordered !== null) ordered.forEach((f, i) => assign(f, mintFaceUuid(splitFacePath(base, i))))
    }
  }

  // Step 3: the corner patches steps 1-2 cannot reach (generated from a vertex
  // where blends meet), named off their neighbours so their edges stay pickable.
  const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, newShape, faceNames, faceAncestry)
  return { faceNames, edgeNames, faceAncestry, edgeAncestry }
}

/**
 * Classify the modifier output into a BrepDiff (mirrors `ocp_edge_modifier_diff`).
 * Inputs are partitioned via IsDeleted/Modified; outputs partition new vs
 * inherited by IsSame against the preimage pool.
 */
function edgeModifierDiff(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccEdgeModifierMaker,
  oldFaces: OccShape[],
  oldEdges: OccShape[],
  newFaces: OccShape[],
  newEdges: OccShape[],
  oldFaceIdx: SubShapeIndexMap,
  oldFaceModified: Map<number, OccShape[]>,
): BrepDiff {
  const diff = emptyBrepDiff()

  const classify = (
    inputs: OccShape[],
    modsOf: (s: OccShape) => OccShape[],
  ): { modified: OccShape[]; deleted: OccShape[]; preimages: OccShape[] } => {
    const modified: OccShape[] = []
    const deleted: OccShape[] = []
    const preimages: OccShape[] = []
    for (const s of inputs) {
      let isDel = false
      try {
        isDel = maker.IsDeleted(s)
      } catch {
        isDel = false
      }
      if (isDel) {
        deleted.push(s)
        continue
      }
      const mods = modsOf(s)
      if (mods.length > 0) {
        modified.push(s)
        preimages.push(...mods)
      } else {
        preimages.push(s)
      }
    }
    return { modified, deleted, preimages }
  }

  // Faces read the shared drain from applyEdgeModifier; edges keep their own
  // drain here (the two stay separate maps).
  const faces = classify(oldFaces, (s) => oldFaceModified.get(oldFaceIdx.get(s as OccSubShape)) ?? [])
  const edges = classify(oldEdges, (s) => drainList(scope, maker.Modified(s)))
  diff.modified_input_faces = faces.modified
  diff.deleted_input_faces = faces.deleted
  diff.modified_input_edges = edges.modified
  diff.deleted_input_edges = edges.deleted

  // Orientation-independent geometry keys for an edge (lines hashed both ways,
  // mirroring brepDiffNewEdgeHashes). Used as the geometry fallback below.
  const edgeGeomKeys = (s: OccShape): string[] => {
    try {
      const { ed } = edgeToGeom(oc, scope, s)
      if (ed.kind === 'line') {
        const a = (ed as { start: number[] }).start
        const b = (ed as { end: number[] }).end
        return [
          edgeGeometryHash({ kind: 'line', start: a, end: b }),
          edgeGeometryHash({ kind: 'line', start: b, end: a }),
        ]
      }
      return [edgeGeometryHash(ed as unknown as Record<string, unknown>)]
    } catch {
      return []
    }
  }

  const walk = (
    outputs: OccShape[],
    pool: OccShape[],
    geomPool?: Set<string>,
    keysOf?: (s: OccShape) => string[],
  ): { fresh: OccShape[]; inherited: OccShape[] } => {
    const fresh: OccShape[] = []
    const inherited: OccShape[] = []
    // Geometry fallback (edges only): BRepFilletAPI is an unreliable narrator --
    // it rebuilds the whole solid and reports edges far from the filleted one as
    // IsDeleted/regenerated, so they never reach `pool` and IsSame misses them.
    // An output edge whose geometry already existed in the *old* shape is
    // unchanged and must stay inherited, so the builder does not re-attribute
    // its @created_by to the fillet (which would evict the original ancestry
    // entry and break stored edge picks like a revolve axis). See
    // bugreports/revolve_bug_20260707_151218.md. This only adds inherited
    // classifications, never removes: modified edges (new geometry) still match
    // via IsSame on their Modified() image, and genuinely new fillet edges have
    // geometry absent from the old shape, so both stay correct.
    for (const s of outputs) {
      if (pool.some((p) => (s as OccSubShape).IsSame(p as OccSubShape))) {
        inherited.push(s)
        continue
      }
      if (geomPool && keysOf && keysOf(s).some((k) => geomPool.has(k))) {
        inherited.push(s)
        continue
      }
      fresh.push(s)
    }
    return { fresh, inherited }
  }

  const oldEdgeKeys = new Set(oldEdges.flatMap((e) => edgeGeomKeys(e)))
  const of = walk(newFaces, faces.preimages)
  const oe = walk(newEdges, edges.preimages, oldEdgeKeys, edgeGeomKeys)
  diff.new_faces = of.fresh
  diff.inherited_faces = of.inherited
  diff.new_edges = oe.fresh
  diff.inherited_edges = oe.inherited
  return diff
}

/** Whole-shape validity, geometric checks included. A throwing analyzer is
 *  not a vote of confidence, so it reads as invalid. */
function isValidShape(oc: OccModule, scope: DisposeScope, shape: OccShape): boolean {
  try {
    const analyzer = new oc.BRepCheck_Analyzer(shape, true)
    try {
      return analyzer.IsValid_2()
    } finally {
      scope.release(analyzer)
    }
  } catch {
    return false
  }
}

/**
 * Repair an invalid modifier result, or null when it cannot be trusted.
 *
 * ShapeFix is a projector, not a rebuilder: the defect it is meant to clear
 * here is a missing pcurve on an edge the blend shares with a corner patch.
 * The guards mirror `canonicalSurfaces`: the healed shape must actually come
 * out valid, keep the same solid/face/edge counts, and hold the same volume.
 * A heal that changes the topology count has invented or dropped a face rather
 * than projected a curve, which is the corrupt case wearing a repair, so it is
 * refused. The returned shape is DETACHED, matching `maker.Shape()`: the
 * caller owns it exactly as it owns an unhealed result.
 */
function healShape(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape | null {
  const before = topoCounts(oc, scope, shape)
  let healed: OccShape
  try {
    const fixer = scope.track(new oc.ShapeFix_Shape_2(shape))
    fixer.Perform(scope.track(new oc.Handle_Message_ProgressIndicator_1()))
    healed = scope.track(fixer.Shape())
  } catch {
    return null
  }
  const reject = (): null => {
    scope.release(healed)
    return null
  }
  if (!isValidShape(oc, scope, healed)) return reject()
  const after = topoCounts(oc, scope, healed)
  if (after.solids !== before.solids || after.faces !== before.faces || after.edges !== before.edges) {
    return reject()
  }
  const v0 = shapeVolume(oc, scope, shape)
  const v1 = shapeVolume(oc, scope, healed)
  if (!(Math.abs(v1 - v0) <= Math.max(1e-9, 1e-6 * Math.abs(v0)))) return reject()
  return scope.detach(healed)
}

/** Solid/face/edge occurrence counts, the structural fingerprint the heal guard compares. */
function topoCounts(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): { solids: number; faces: number; edges: number } {
  const E = oc.TopAbs_ShapeEnum
  const count = (type: OccShapeEnumValue): number => {
    const exp = scope.track(new oc.TopExp_Explorer_2(shape, type, E.TopAbs_SHAPE))
    let n = 0
    for (; exp.More(); exp.Next()) n++
    scope.release(exp)
    return n
  }
  return { solids: count(E.TopAbs_SOLID), faces: count(E.TopAbs_FACE), edges: count(E.TopAbs_EDGE) }
}

/** Volume via BRepGProp; the heal guard's "same material" test. */
function shapeVolume(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
  const mass = props.Mass()
  scope.release(props)
  return mass
}

/** What `addEdge` needs beyond the edge itself. The angle-distance chamfer has
 *  to name a reference face, and the input shape's faces are already walked by
 *  the time the add loop runs, so they are handed over rather than re-explored. */
interface AddEdgeContext {
  scope: DisposeScope
  faces: OccShape[]
}

interface ModifierSpec {
  makeMaker(shape: OccShape): OccEdgeModifierMaker
  addEdge(maker: OccEdgeModifierMaker, edge: OccShape, ctx: AddEdgeContext): void
}

function applyEdgeModifier(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  edges: OccShape[],
  spec: ModifierSpec,
  trackLineage: boolean,
  oldNames: OldNames | null = null,
): EdgeModifierResult {
  const fail = (reason: string): EdgeModifierResult => ({
    shape,
    success: false,
    reason,
    names: null,
    diff: emptyBrepDiff(),
    skippedEdgeIndices: [],
  })

  if ((shape as unknown as { IsNull(): boolean }).IsNull()) return fail('null_shape')

  // Old-shape face/edge walks hoisted here for extractNames, edgeModifierDiff
  // and the membership check below -- together they explored the same shape up
  // to five times per solve, minting fresh proxies each pass (L15).
  const oldFaces = exploreFaces(oc, scope, shape)
  const oldEdges = exploreEdges(oc, scope, shape)
  let maker: OccEdgeModifierMaker
  try {
    maker = scope.track(spec.makeMaker(shape))
  } catch {
    return fail('maker_failed')
  }

  const appliedEdges: OccShape[] = []
  const skippedIdx: number[] = []
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]
    if (!oldEdges.some((se) => (se as OccSubShape).IsSame(edge as OccSubShape))) {
      // Edge not found in the built shape -- caller should report as unresolved.
      skippedIdx.push(i)
      continue
    }
    try {
      spec.addEdge(maker, edge, { scope, faces: oldFaces })
      appliedEdges.push(edge)
    } catch {
      // failed edge -- mirror Python's failed_count (no throw)
      skippedIdx.push(i)
    }
  }

  if (appliedEdges.length === 0) return fail('no_edges_applied')

  let built: OccShape
  try {
    maker.Build()
    if (!maker.IsDone()) return fail('build_not_done')
    built = maker.Shape()
  } catch {
    return fail('build_failed')
  }

  // IsDone() is not a validity claim. On a pick whose blend runs into a
  // neighbouring face, BRepFilletAPI still reports done and hands back a
  // corrupt shell: faces that overlap, an edge left lying across a face it
  // never split, a vertex dropped onto an edge without dividing it. Nothing
  // downstream looks, so that shape becomes the body and only the render shows
  // it -- edges poking through a face, a face with no border, a hole.
  //
  // Invalid does not mean corrupt, though. The common case is a blend meeting
  // at a corner whose shared edges simply lack pcurves on the new surfaces;
  // ShapeFix projects those and the shape is sound. Healing separates the two:
  // what heals was benign and its repair is adopted at the return below, what
  // does not heal is the corruption above and the operation is refused. The
  // caller reports the refusal like any other modifier failure, leaving the
  // body untouched.
  //
  // Only the DECISION happens here. The repair is substituted at the return,
  // after the name and diff extraction below have read the maker's own output.
  let healed: OccShape | null = null
  if (!isValidShape(oc, scope, built)) {
    healed = healShape(oc, scope, built)
    if (healed === null) {
      scope.release(built)
      // This string reaches the user as the feature's failure message
      // (utils/core/featureFailure.ts), so it names a way out rather than a
      // kernel code: the reported document recovers at radius 0.1 where it
      // corrupts at 0.15.
      return fail('the operation produced invalid geometry; try a smaller radius/distance or fewer edges at once')
    }
  }

  // On success, `built` is untracked (caller owns it via the returned shape).
  // On failure, the old shape is returned unchanged and the caller must not
  // release it (it is still scope-owned).
  let names: NewNames | null = null
  let diff: BrepDiff
  try {
    // Drain the maker's Modified() history ONCE per old face, shared by
    // extractNames and the diff classify -- both drained the same query per
    // face today (L15). BRepFilletAPI is an unreliable narrator (see the
    // geometry fallback in edgeModifierDiff), so this edit is last and alone:
    // if the history is order- or call-count-sensitive, the shared drain
    // shows up as a diff-count change in edgeModifierReal.test.ts with one
    // candidate cause. The edge drain stays separate, in classify.
    const oldFaceIdx = new SubShapeIndexMap()
    oldFaces.forEach((f, i) => oldFaceIdx.set(f as OccSubShape, i))
    const oldFaceModified = new Map<number, OccShape[]>()
    for (const f of oldFaces) {
      oldFaceModified.set(oldFaceIdx.get(f as OccSubShape), drainList(scope, maker.Modified(f)))
    }
    const newFaces = exploreFaces(oc, scope, built)
    const newEdges = exploreEdges(oc, scope, built)
    if (trackLineage && oldNames !== null) {
      names = extractNames(oc, scope, maker, built, appliedEdges, oldNames, oldFaces, newFaces, oldFaceIdx, oldFaceModified)
    }
    try {
      diff = edgeModifierDiff(oc, scope, maker, oldFaces, oldEdges, newFaces, newEdges, oldFaceIdx, oldFaceModified)
    } catch {
      diff = emptyBrepDiff()
    }
  } catch (e) {
    // Release both candidate shapes so a throw does not leak either.
    scope.release(built)
    if (healed !== null) scope.release(healed)
    throw e
  }

  // Substitute the repair only now, as the returned geometry. `names` and
  // `diff` above correlate the maker's Modified() history to its output by
  // sub-shape identity, and ShapeFix re-makes every face rather than editing it
  // in place (measured: zero IsSame survivors on a repaired blend). Reading them
  // off the healed shape instead left every inherited face looking fresh -- 11
  // of 12 on the corner corpus against 6 truly new -- so the builder
  // re-attributed the whole body's ancestry to this feature and evicted the
  // picks stored against it, the same eviction the edge geometry fallback in
  // edgeModifierDiff exists to prevent. The hand-off to the healed shape is by
  // geometry hash, which the heal guard's unchanged counts and volume keep valid.
  if (healed !== null) {
    scope.release(built)
    return { shape: healed, success: true, reason: null, names, diff, skippedEdgeIndices: skippedIdx }
  }

  return { shape: built, success: true, reason: null, names, diff, skippedEdgeIndices: skippedIdx }
}

function filletSpec(oc: OccModule, radius: number): ModifierSpec {
  return {
    makeMaker: (shape) =>
      new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational),
    addEdge: (maker, edge) => maker.Add_2(radius, edge),
  }
}

/** First face of `ctx.faces` that the edge belongs to, or null. The face edges
 *  are wrappers of their own, so the match is `IsSame`, not identity; the walk
 *  is cached because every chamfered edge asks the same question of the same
 *  face set. */
function adjacentFaceLookup(oc: OccModule): (edge: OccShape, ctx: AddEdgeContext) => OccShape | null {
  let walked: { face: OccShape; edges: OccShape[] }[] | null = null
  return (edge, ctx) => {
    walked ??= ctx.faces.map((face) => ({ face, edges: exploreEdges(oc, ctx.scope, face) }))
    for (const { face, edges } of walked) {
      if (edges.some((fe) => (fe as OccSubShape).IsSame(edge as OccSubShape))) return face
    }
    return null
  }
}

function chamferSpec(oc: OccModule, distance: number, kind: string, angle: number): ModifierSpec {
  const findFace = adjacentFaceLookup(oc)
  return {
    makeMaker: (shape) => new oc.BRepFilletAPI_MakeChamfer(shape),
    addEdge: (maker, edge, ctx) => {
      if (kind !== 'angle_distance') return maker.Add_2(distance, edge)
      // AddDA measures the distance on a reference face and takes the angle
      // from it, so the face is part of the call. Either adjacent face gives a
      // valid chamfer (they differ only in which leg is `distance`), so the
      // first one found is a real answer rather than an arbitrary one.
      const face = findFace(edge, ctx)
      if (!face) throw new Error('chamfer: the target edge belongs to no face of the shape')
      maker.AddDA(distance, angle, edge, face)
    },
  }
}

/** Apply a fillet to `edges` and track lineage (mirrors `apply_fillet_with_lineage`). */
export function applyFilletWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  radius: number,
  edges: OccShape[],
  oldNames: OldNames | null = null,
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, filletSpec(oc, radius), true, oldNames)
}

/** Apply a fillet to `edges`, diff only (mirrors `apply_fillet_with_diff`). */
export function applyFilletWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  radius: number,
  edges: OccShape[],
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, filletSpec(oc, radius), false)
}

/** Apply a chamfer to `edges` and track lineage (mirrors `apply_chamfer_with_lineage`). */
export function applyChamferWithLineage(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  distance: number,
  edges: OccShape[],
  kind: string,
  angle: number,
  oldNames: OldNames | null = null,
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, chamferSpec(oc, distance, kind, angle), true, oldNames)
}

/** Apply a chamfer to `edges`, diff only (mirrors `apply_chamfer_with_diff`). */
export function applyChamferWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  distance: number,
  edges: OccShape[],
  kind: string,
  angle: number,
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, chamferSpec(oc, distance, kind, angle), false)
}
