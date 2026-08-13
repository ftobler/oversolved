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
import type { OccModule, OccShape, OccSubShape, OccEdgeModifierMaker } from './occTypes'
import { faceCentroid, edgeToGeom } from './primitives'
import { edgeGeometryHash } from '../geomHash'
import { faceGh, edgeGh } from './lineageHash'
import { emptyBrepDiff, type BrepDiff } from '../types3d'
import { mintFaceUuid, filletFacePath, splitFacePath, orderSplitChildren, type SplitChild } from '../constructionName'
import {
  deriveEdgeNames,
  faceSplitKey,
  nameFacesFromNeighbours,
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
  for (; exp.More(); exp.Next()) out.push(scope.track(cast(exp.Current())))
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
function extractNames(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccEdgeModifierMaker,
  oldShape: OccShape,
  newShape: OccShape,
  modifiedEdges: OccShape[],
  old: OldNames,
): NewNames {
  const faceNames: Names = {}
  const faceAncestry: Lineage = {}
  // Generated-face centroids are world coordinates: normalize them by the new
  // solid's span so the split-sibling refusal is relative, not unit-dependent.
  let frame: NormalFrame | null = null

  // Modified()/Generated() hand back faces carrying a FORWARD orientation, but
  // every downstream consumer (deriveEdgeNames, tessellation, registration)
  // explores faces from the built SOLID, where the shell orients each face
  // outward. faceGh is normal-signed, so the two disagree for any face the op
  // reshaped, leaving its edges unnamed. Canonicalize every minted key to the
  // built-solid face reached by IsSame (orientation-independent identity).
  const builtFaces = exploreFaces(oc, scope, newShape)
  const builtGh = (f: OccShape): string => {
    const same = builtFaces.find((bf) => (bf as OccSubShape).IsSame(f as OccSubShape))
    return faceGh(oc, scope, asFace(oc, same ?? f))
  }

  // Step 1: old named faces -> output faces via Modified() (subshape identity).
  for (const oldF of exploreFaces(oc, scope, oldShape)) {
    const uuid = old.faceNames[faceGh(oc, scope, asFace(oc, oldF))]
    if (!uuid) continue
    let deleted = false
    try {
      deleted = maker.IsDeleted(oldF)
    } catch {
      deleted = false
    }
    if (deleted) continue
    const ancestry = old.faceAncestry[uuid] ?? []
    const mods = drainList(scope, maker.Modified(oldF))
    if (mods.length === 0) {
      // Unchanged face: its geom-hash key persists, so the UUID carries by key.
      faceNames[faceGh(oc, scope, asFace(oc, oldF))] = uuid
      faceAncestry[uuid] = [...ancestry]
    } else if (mods.length === 1) {
      faceNames[builtGh(mods[0])] = uuid
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
  nameFacesFromNeighbours(oc, scope, newShape, faceNames, faceAncestry)

  const { edgeNames, edgeAncestry } = deriveEdgeNames(oc, scope, newShape, faceNames, faceAncestry)
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
  oldShape: OccShape,
  newShape: OccShape,
): BrepDiff {
  const diff = emptyBrepDiff()

  const classify = (
    inputs: OccShape[],
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
      const mods = drainList(scope, maker.Modified(s))
      if (mods.length > 0) {
        modified.push(s)
        preimages.push(...mods)
      } else {
        preimages.push(s)
      }
    }
    return { modified, deleted, preimages }
  }

  const faces = classify(exploreFaces(oc, scope, oldShape))
  const edges = classify(exploreEdges(oc, scope, oldShape))
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

  const oldEdgeKeys = new Set(exploreEdges(oc, scope, oldShape).flatMap((e) => edgeGeomKeys(e)))
  const of = walk(exploreFaces(oc, scope, newShape), faces.preimages)
  const oe = walk(exploreEdges(oc, scope, newShape), edges.preimages, oldEdgeKeys, edgeGeomKeys)
  diff.new_faces = of.fresh
  diff.inherited_faces = of.inherited
  diff.new_edges = oe.fresh
  diff.inherited_edges = oe.inherited
  return diff
}

interface ModifierSpec {
  makeMaker(shape: OccShape): OccEdgeModifierMaker
  addEdge(maker: OccEdgeModifierMaker, edge: OccShape): void
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
  })

  if ((shape as unknown as { IsNull(): boolean }).IsNull()) return fail('null_shape')

  const shapeEdges = exploreEdges(oc, scope, shape)
  let maker: OccEdgeModifierMaker
  try {
    maker = scope.track(spec.makeMaker(shape))
  } catch {
    return fail('maker_failed')
  }

  const appliedEdges: OccShape[] = []
  for (const edge of edges) {
    if (!shapeEdges.some((se) => (se as OccSubShape).IsSame(edge as OccSubShape))) continue  // skipped
    try {
      spec.addEdge(maker, edge)
      appliedEdges.push(edge)
    } catch {
      // failed edge -- mirror Python's failed_count (no throw)
    }
  }

  if (appliedEdges.length === 0) return fail('no_edges_applied')

  let built: OccShape
  try {
    maker.Build()
    built = maker.Shape()
  } catch {
    return fail('build_failed')
  }

  let names: NewNames | null = null
  if (trackLineage && oldNames !== null) {
    names = extractNames(oc, scope, maker, shape, built, appliedEdges, oldNames)
  }

  let diff: BrepDiff
  try {
    diff = edgeModifierDiff(oc, scope, maker, shape, built)
  } catch {
    diff = emptyBrepDiff()
  }

  return { shape: built, success: true, reason: null, names, diff }
}

function filletSpec(oc: OccModule, radius: number): ModifierSpec {
  return {
    makeMaker: (shape) =>
      new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational),
    addEdge: (maker, edge) => maker.Add_2(radius, edge),
  }
}

function chamferSpec(oc: OccModule, distance: number, kind: string, angle: number): ModifierSpec {
  return {
    makeMaker: (shape) => new oc.BRepFilletAPI_MakeChamfer(shape),
    addEdge: (maker, edge) =>
      kind === 'angle_distance' ? maker.AddDA(distance, angle, edge) : maker.Add_2(distance, edge),
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
