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
import type { OccModule, OccShape, OccSubShape, OccEdgeModifierMaker, OccModifierHistory, OccShapeEnumValue, OccShapeFixShape } from './occTypes'
import { faceCentroid, SubShapeIndexMap } from './primitives'
import { volumeOf } from './booleans'
import { SubShapeDedup, SubShapeMap } from './subshapeIdentity'
import { canonicalEdges, canonicalVertices, type ShapeNames } from './bodyNames'
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
type Names = SubShapeMap<string>

/** The pre-op construction names the modifier carries forward, keyed by the input solid. */
export interface OldNames extends ShapeNames {
  createdBy: string
}

/** The rebuilt construction names after a fillet/chamfer, keyed by the output solid. */
export type NewNames = ShapeNames

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

export function exploreFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return explore(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, (s) => oc.TopoDS.Face_1(s))
}

export function exploreEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  return explore(oc, scope, shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, (s) => oc.TopoDS.Edge_1(s))
}

/**
 * The built-solid face a Modified()/Generated() image is, by IsSame. The
 * images carry the builder's FORWARD orientation while the solid's shell
 * orients each face outward; IsSame ignores orientation, so the image and its
 * solid face are one key, and keying by the solid's own face keeps every name
 * on a sub-shape the body will hold. An image with no built-solid counterpart
 * stays itself (and is never written to the body).
 */
function builtFaceOf(builtFaces: OccShape[]): (f: OccShape) => OccSubShape {
  const builtIdx = new SubShapeIndexMap()
  builtFaces.forEach((bf, i) => builtIdx.set(bf as OccSubShape, i))
  return (f) => {
    const at = builtIdx.get(f as OccSubShape)
    return (at >= 0 ? builtFaces[at] : f) as OccSubShape
  }
}

export { builtFaceOf }

/** The name maps under construction plus the shared machinery the steps read. */
interface NameBuildContext {
  oc: OccModule
  scope: DisposeScope
  maker: OccModifierHistory
  old: OldNames
  builtFace: (f: OccShape) => OccSubShape
  faceNames: Names
  faceAncestry: Lineage
  capAncestry: Lineage
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
  maker: OccModifierHistory,
  newShape: OccShape,
  modifiedEdges: OccShape[],
  old: OldNames,
  oldFaces: OccShape[],
  newFaces: OccShape[],
  oldFaceIdx: SubShapeIndexMap,
  oldFaceModified: Map<number, OccShape[]>,
): NewNames {
  const faceNames: Names = new SubShapeMap()
  const faceAncestry: Lineage = {}
  const capAncestry: Lineage = {}
  const ctx: NameBuildContext = {
    oc, scope, maker, old,
    builtFace: builtFaceOf(newFaces),
    faceNames,
    faceAncestry,
    capAncestry,
  }

  // Step 1: old named faces -> output faces via Modified() (subshape identity).
  inheritOldFaceNames(
    oc, scope, maker, old, ctx.builtFace, faceNames, faceAncestry, oldFaces, oldFaceIdx, oldFaceModified, capAncestry,
  )

  // Step 2: modified edges -> generated fillet faces, minted role=fillet.
  mintGeneratedFilletFaces(ctx, newShape, modifiedEdges)

  // Step 3: the corner patches steps 1-2 cannot reach (generated from a vertex
  // where blends meet), named off their neighbours so their edges stay pickable.
  const { edgeNames, edgeAncestry } = nameNeighboursAndDeriveEdges(oc, scope, newShape, faceNames, faceAncestry)
  return { faceNames, edgeNames, faceAncestry, edgeAncestry, capAncestry }
}

/** Carry every named old face to its output image, keyed by the built solid's face.
 *
 * Exported and typed on the minimal [[OccModifierHistory]] so a non-fillet
 * modifier (the shell's thick-solid maker) reuses the identical carry-forward
 * rather than copying it: a face the maker reports neither deleted nor modified
 * keeps its UUID verbatim, a face that split into an ordered set of children
 * mints `split` UUIDs, and a merge collision drops both names for the neighbour
 * pass to recover. `builtFace` maps any image to the built solid's own face. */
export function inheritOldFaceNames(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccModifierHistory,
  old: OldNames,
  builtFace: (f: OccShape) => OccSubShape,
  faceNames: Names,
  faceAncestry: Lineage,
  oldFaces: OccShape[],
  oldFaceIdx: SubShapeIndexMap,
  oldFaceModified: Map<number, OccShape[]>,
  // A cap's identification net follows its UUID like the ancestry does (see
  // ShapeNames); a fillet that reshapes the body must not drop it.
  capAncestry: Lineage = {},
): void {
  // Faces a merge collision already cancelled: the two faces that merged into
  // one dropped their names, so the face is up for grabs. A third face
  // modifying to the same output must not re-claim it -- topology order would
  // pick whichever, and the name was deliberately left to the neighbours.
  const mergedAway = new SubShapeMap<true>()

  for (const oldF of oldFaces) {
    const uuid = old.faceNames.get(oldF as OccSubShape)
    if (!uuid) continue
    let deleted = false
    try {
      deleted = maker.IsDeleted(oldF)
    } catch {
      deleted = false
    }
    if (deleted) continue
    const ancestry = old.faceAncestry[uuid] ?? []
    const capNet = old.capAncestry[uuid] ?? null
    const mods = oldFaceModified.get(oldFaceIdx.get(oldF as OccSubShape)) ?? []
    if (mods.length === 0) {
      // Unchanged face: the output holds the same face, so the UUID carries over.
      faceNames.set(builtFace(oldF), uuid)
      faceAncestry[uuid] = [...ancestry]
      if (capNet) capAncestry[uuid] = [...capNet]
    } else if (mods.length === 1) {
      const key = builtFace(mods[0])
      const prior = faceNames.get(key)
      if (prior !== undefined && prior !== uuid) {
        // Two named faces merged into one. Whichever we kept would be picked by
        // topology order, which is not construction-stable. Drop both and let
        // nameFacesFromNeighbours mint a name from the surviving neighbourhood.
        faceNames.delete(key)
        delete faceAncestry[prior]
        mergedAway.set(key, true)
        continue
      }
      if (mergedAway.has(key)) continue
      faceNames.set(key, uuid)
      faceAncestry[uuid] = [...ancestry]
      if (capNet) capAncestry[uuid] = [...capNet]
    } else {
      const ordered = orderSplitChildren(
        mods.map<SplitChild<OccShape>>((m) => ({ item: m, key: faceSplitKey(oc, scope, oldF, asFace(oc, m)) })),
      )
      if (ordered === null) continue  // ambiguous -> ancestral fallback
      ordered.forEach((m, i) => {
        const childUuid = mintFaceUuid(splitFacePath(uuid, i))
        faceNames.set(builtFace(m), childUuid)
        faceAncestry[childUuid] = [...ancestry]
        if (capNet) capAncestry[childUuid] = [...capNet]
      })
    }
  }
}

/** Mint the fillet faces a modified edge generated, slotted by that edge's UUID. */
function mintGeneratedFilletFaces(
  ctx: NameBuildContext,
  newShape: OccShape,
  modifiedEdges: OccShape[],
): void {
  const { oc, scope, maker, old, builtFace, faceNames, faceAncestry } = ctx
  // Generated-face centroids are world coordinates: normalize them by the new
  // solid's span so the split-sibling refusal is relative, not unit-dependent.
  let frame: NormalFrame | null = null

  for (const edge of modifiedEdges) {
    const edgeUuid = old.edgeNames.get(edge as OccSubShape)
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
      const key = builtFace(face)
      if (faceNames.has(key)) return
      faceNames.set(key, uuid)
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
}

/** The faces the maker Generated() from any input edge or vertex. Every input edge,
 *  not just the applied ones: a fillet runs along the whole tangent chain of an
 *  applied edge, so blend faces also grow from edges nobody picked. */
function generatedFaces(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccModifierHistory,
  oldEdges: OccShape[],
): SubShapeDedup {
  const sources: OccShape[] = [...oldEdges]
  const seenVertex = new SubShapeDedup()
  for (const e of oldEdges) {
    for (const v of canonicalVertices(oc, scope, e)) {
      if (seenVertex.has(v)) continue
      seenVertex.add(v)
      sources.push(v as unknown as OccShape)
    }
  }
  const made = new SubShapeDedup()
  for (const s of sources) {
    let generated: OccShape[]
    try {
      generated = drainList(scope, maker.Generated(s))
    } catch {
      continue  // a source the maker cannot narrate made nothing we can claim
    }
    for (const g of generated) for (const f of exploreFaces(oc, scope, g)) made.add(f as OccSubShape)
  }
  return made
}

/**
 * Classify the modifier output into a BrepDiff (mirrors `ocp_edge_modifier_diff`).
 * Inputs are partitioned via IsDeleted/Modified; outputs partition new vs
 * inherited by IsSame against the preimage pool.
 *
 * Typed on the minimal [[OccModifierHistory]] so a non-edge modifier
 * (delete-face's BRepAlgoAPI_Defeaturing) reuses the identical classification;
 * the far-edge rule below is what makes "no new faces" fall out correctly for a
 * heal-only operation.
 */
export function edgeModifierDiff(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccModifierHistory,
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

  const walk = (
    outputs: OccShape[],
    pool: OccShape[],
    inheritedAnyway?: (s: OccShape) => boolean,
  ): { fresh: OccShape[]; inherited: OccShape[] } => {
    const fresh: OccShape[] = []
    const inherited: OccShape[] = []
    for (const s of outputs) {
      if (pool.some((p) => (s as OccSubShape).IsSame(p as OccSubShape))) {
        inherited.push(s)
        continue
      }
      if (inheritedAnyway?.(s)) {
        inherited.push(s)
        continue
      }
      fresh.push(s)
    }
    return { fresh, inherited }
  }

  // A face outside the preimage pool is new only if the modifier made it: a blend
  // or chamfer face Generated() from an edge, or a corner patch Generated() from a
  // vertex. The edge history below is known to misreport far edges; holding faces
  // to what the maker generated keeps one misreported far face from being credited
  // to the modifier and dragging all its edges along.
  const made = generatedFaces(oc, scope, maker, oldEdges)
  const of = walk(newFaces, faces.preimages, (s) => !made.has(s as OccSubShape))
  // Far-edge rule: BRepFilletAPI is an unreliable narrator -- it rebuilds the
  // whole solid and reports edges far from the filleted one as
  // IsDeleted/regenerated, so they never reach the pool and IsSame misses them.
  // Such an edge must stay inherited, so the builder does not re-attribute its
  // @created_by to the fillet (which would evict the original ancestry entry
  // and break stored edge picks like a revolve axis). See
  // bugreports/revolve_bug_20260707_151218.md. Every edge the modifier really
  // made bounds a face it made (a blend or chamfer face), so an unmatched edge
  // touching no new face is an old edge rebuilt: face history decides, no
  // geometry is compared.
  const freshFaceEdges = new SubShapeDedup()
  for (const f of of.fresh) {
    for (const e of canonicalEdges(oc, scope, f)) freshFaceEdges.add(e)
  }
  const oe = walk(newEdges, edges.preimages, (s) => !freshFaceEdges.has(s as OccSubShape))
  diff.new_faces = of.fresh
  diff.inherited_faces = of.inherited
  diff.new_edges = oe.fresh
  diff.inherited_edges = oe.inherited
  return diff
}

/** Whole-shape validity, geometric checks included. A throwing analyzer is
 *  not a vote of confidence, so it reads as invalid. */
export function isValidShape(oc: OccModule, scope: DisposeScope, shape: OccShape): boolean {
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
 * out valid, keep the same solid/face/edge counts, and hold the same positive
 * volume.
 * A heal that changes the topology count has invented or dropped a face rather
 * than projected a curve, which is the corrupt case wearing a repair, so it is
 * refused. The returned shape is DETACHED, matching `maker.Shape()`: the
 * caller owns it exactly as it owns an unhealed result.
 *
 * ShapeFix re-makes every face rather than editing it in place, so `rebase`
 * maps a sub-shape of the input to its counterpart in the healed shape through
 * the fixer's own substitution context (its history): the hand-off of names
 * keyed by the input's faces and edges.
 */
export function healShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): { shape: OccShape; rebase: (s: OccSubShape) => OccSubShape } | null {
  const before = topoCounts(oc, scope, shape)
  let healed: OccShape
  let fixer: OccShapeFixShape
  try {
    fixer = scope.track(new oc.ShapeFix_Shape_2(shape))
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
  const v0 = volumeOf(oc, scope, shape)
  const v1 = volumeOf(oc, scope, healed)
  // A build with no material (a shell whose walls meet) is collapsed, not
  // missing a pcurve, and keeping its ~0 volume would pass the check below.
  if (!(v0 > 1e-9)) return reject()
  if (!(Math.abs(v1 - v0) <= Math.max(1e-9, 1e-6 * Math.abs(v0)))) return reject()
  const context = scope.track(fixer.Context()).get()
  const E = oc.TopAbs_ShapeEnum
  return {
    shape: scope.detach(healed),
    rebase: (s) => (context ? scope.track(context.Apply(s, E.TopAbs_SHAPE)) as OccSubShape : s),
  }
}

/** `names` re-keyed onto another shape's sub-shapes through `rebase`. */
export function rebaseNames(names: NewNames, rebase: (s: OccSubShape) => OccSubShape): NewNames {
  const move = (from: Names): Names => {
    const out: Names = new SubShapeMap()
    for (const [s, uuid] of from.entries()) out.set(rebase(s), uuid)
    return out
  }
  return { ...names, faceNames: move(names.faceNames), edgeNames: move(names.edgeNames) }
}

/**
 * `diff` with its output-side lists moved onto the healed shape through
 * `rebase`, so attribution finds the new faces and edges by identity there.
 * The input-side lists name sub-shapes of the old body and stay as they are.
 */
export function rebaseDiff(diff: BrepDiff, rebase: (s: OccSubShape) => OccSubShape): BrepDiff {
  const move = (items: unknown[]): unknown[] => items.map((s) => rebase(s as OccSubShape))
  return {
    ...diff,
    new_faces: move(diff.new_faces),
    inherited_faces: move(diff.inherited_faces),
    new_edges: move(diff.new_edges),
    inherited_edges: move(diff.inherited_edges),
  }
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
  const appliedIdx: number[] = []
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
      appliedIdx.push(i)
    } catch {
      // failed edge -- mirror Python's failed_count (no throw)
      skippedIdx.push(i)
    }
  }

  if (appliedEdges.length === 0) return fail('no_edges_applied')

  // Build one fresh maker over `list`; used by the failure diagnosis below.
  const buildFresh = (
    list: OccShape[],
  ): { ok: true; maker: OccEdgeModifierMaker; shape: OccShape } | { ok: false; reason: string } => {
    let fresh: OccEdgeModifierMaker
    try {
      fresh = scope.track(spec.makeMaker(shape))
    } catch {
      return { ok: false, reason: 'maker_failed' }
    }
    try {
      for (const e of list) spec.addEdge(fresh, e, { scope, faces: oldFaces })
      fresh.Build()
      if (!fresh.IsDone()) return { ok: false, reason: 'build_not_done' }
      return { ok: true, maker: fresh, shape: scope.track(fresh.Shape()) }
    } catch {
      return { ok: false, reason: 'build_failed' }
    }
  }

  let built: OccShape | null = null
  let buildReason = 'build_not_done'
  try {
    maker.Build()
    if (maker.IsDone()) built = maker.Shape()
  } catch {
    buildReason = 'build_failed'
  }
  if (built === null) {
    // One or more picked edges can make the whole fillet/chamfer chain refuse,
    // even though the rest of the set applies cleanly (the cast-bearing repro:
    // ten edges fail as one build, eight of them build as one and two refuse
    // alone). Find the refusals by bisecting the failing set, never by
    // reordering or guessing: a subset that builds is entirely good, so only
    // failing subsets are walked down. Then retry the good edges as ONE
    // operation, keeping a single history for naming and the diff.
    const broken = new Set<number>()
    const diagnose = (positions: number[]): void => {
      if (positions.length === 0) return
      const probe = buildFresh(positions.map((p) => appliedEdges[p]))
      if (probe.ok) {
        scope.release(probe.shape)
        return
      }
      if (positions.length === 1) {
        broken.add(appliedIdx[positions[0]])
        return
      }
      const mid = Math.ceil(positions.length / 2)
      diagnose(positions.slice(0, mid))
      diagnose(positions.slice(mid))
    }
    if (appliedEdges.length === 1) {
      broken.add(appliedIdx[0])
    } else {
      const all = appliedEdges.map((_, i) => i)
      const mid = Math.ceil(all.length / 2)
      diagnose(all.slice(0, mid))
      diagnose(all.slice(mid))
    }
    const good = appliedEdges.filter((_, k) => !broken.has(appliedIdx[k]))
    if (broken.size === 0 || good.length === 0) return fail(buildReason)
    const retry = buildFresh(good)
    if (!retry.ok) return fail(retry.reason)
    maker = retry.maker
    built = retry.shape
    skippedIdx.push(...[...broken].sort((a, b) => a - b))
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
  let heal: ReturnType<typeof healShape> = null
  if (!isValidShape(oc, scope, built)) {
    heal = healShape(oc, scope, built)
    if (heal === null) {
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
    // far-edge rule in edgeModifierDiff), so this edit is last and alone:
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
    if (heal !== null) scope.release(heal.shape)
    throw e
  }

  // Substitute the repair only now, as the returned geometry. `names` and
  // `diff` above correlate the maker's Modified() history to its output by
  // sub-shape identity, and ShapeFix re-makes every face rather than editing it
  // in place (measured: zero IsSame survivors on a repaired blend). Reading them
  // off the healed shape instead left every inherited face looking fresh -- 11
  // of 12 on the corner corpus against 6 truly new -- so the builder
  // re-attributed the whole body's ancestry to this feature and evicted the
  // picks stored against it, the same eviction the far-edge rule in
  // edgeModifierDiff exists to prevent. The names are handed to the healed
  // shape through the fixer's own history (`rebase`), and so is the diff.
  if (heal !== null) {
    const rebased = names === null ? null : rebaseNames(names, heal.rebase)
    const healedDiff = rebaseDiff(diff, heal.rebase)
    scope.release(built)
    return { shape: heal.shape, success: true, reason: null, names: rebased, diff: healedDiff, skippedEdgeIndices: skippedIdx }
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

function chamferSpec(oc: OccModule, distance: number, kind: string, angleDeg: number): ModifierSpec {
  // The unit boundary. The document authors the angle in degrees (the editor
  // labels it so, and the schema defaults it to 45), but ChFi3d takes it
  // through C `tan()`, which is radians. This is the only call site that
  // reaches `AddDA`, so the conversion belongs here.
  const angleRad = angleDeg * (Math.PI / 180)
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
      maker.AddDA(distance, angleRad, edge, face)
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
  angleDeg: number,
  oldNames: OldNames | null = null,
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, chamferSpec(oc, distance, kind, angleDeg), true, oldNames)
}

/** Apply a chamfer to `edges`, diff only (mirrors `apply_chamfer_with_diff`). */
export function applyChamferWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  distance: number,
  edges: OccShape[],
  kind: string,
  angleDeg: number,
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, chamferSpec(oc, distance, kind, angleDeg), false)
}
