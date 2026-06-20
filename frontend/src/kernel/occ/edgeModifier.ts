// `_apply_edge_modifier`, `_extract_edge_modifier_lineage`, `ocp_edge_modifier_diff`, and the
// public `apply_fillet_with_lineage` / `apply_chamfer_with_lineage`. This is the OCC adapter
// the fillet/chamfer leaf (features/filletChamfer.ts) calls to round/bevel a set of edges on a
// solid, transfer the pre-op lineage through the operation, and produce the BrepDiff.
//
// Lineage is keyed by copy-stable geometry hash (gface_/gedge_), per lineage-stable-keying.md.
// The modifier history (IsDeleted/Modified/Generated) drives both the lineage transfer and the
// diff classification; the fillet faces generated from modified edges land in new_faces (no
// input-face preimage), so the builder's @created_by rewrite attributes them to the modifying
// feature.

import { drainList, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape, OccEdgeModifierMaker } from './occTypes'
import { faceCentroid, faceNormal, faceArea, edgeToGeom } from './primitives'
import { faceGeometryHash, edgeGeometryHash } from '../geomHash'
import type { BrepDiff } from '../types3d'

type Lineage = Record<string, string[]>

export interface EdgeModifierResult {
  shape: OccShape
  success: boolean
  reason: string | null
  faceLineage: Lineage | null
  edgeLineage: Lineage | null
  diff: BrepDiff
}

function emptyDiff(): BrepDiff {
  return {
    new_faces: [],
    inherited_faces: [],
    new_edges: [],
    inherited_edges: [],
    modified_input_faces: [],
    deleted_input_faces: [],
    modified_input_edges: [],
    deleted_input_edges: [],
  }
}

function faceGh(oc: OccModule, scope: DisposeScope, face: OccShape): string {
  return faceGeometryHash(faceCentroid(oc, scope, face), faceNormal(oc, scope, face))
}

function edgeGh(oc: OccModule, scope: DisposeScope, edge: OccShape): string | null {
  try {
    const { ed } = edgeToGeom(oc, scope, edge)
    return edgeGeometryHash(ed as unknown as Record<string, unknown>)
  } catch {
    return null
  }
}

function asFace(oc: OccModule, s: OccShape): OccSubShape {
  return oc.TopoDS.Face_1(s) as OccSubShape
}

function exploreFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Face_1(exp.Current())))
  return out
}

function exploreEdges(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Edge_1(exp.Current())))
  return out
}

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6

/**
 * (face_lineage, edge_lineage) for the modified shape (mirrors
 * `_extract_edge_modifier_lineage`). Old face tokens follow Modified()/geometry
 * match; modified-edge tokens flow to the Generated() fillet faces; edge lineage
 * is rebuilt from face adjacency.
 */
function extractLineage(
  oc: OccModule,
  scope: DisposeScope,
  maker: OccEdgeModifierMaker,
  oldShape: OccShape,
  newShape: OccShape,
  modifiedEdges: OccShape[],
  oldFaceLineage: Lineage,
  oldEdgeLineage: Lineage,
): { faceLineage: Lineage; edgeLineage: Lineage } {
  const newFaceLineage: Lineage = {}

  // New-shape faces with geometry for matching unchanged faces.
  const newFacesGeom = exploreFaces(oc, scope, newShape).map((f) => ({
    f,
    c: faceCentroid(oc, scope, f),
    a: faceArea(oc, scope, f),
    n: faceNormal(oc, scope, f),
  }))

  const geomKey = (c: number[], a: number, n: number[]): string =>
    [r6(c[0]), r6(c[1]), r6(c[2]), r6(a), r6(n[0]), r6(n[1]), r6(n[2])].join(',')

  const findOutputFace = (c: number[], a: number, n: number[]): OccShape | null => {
    const key = geomKey(c, a, n)
    for (const g of newFacesGeom) if (geomKey(g.c, g.a, g.n) === key) return g.f
    let best: OccShape | null = null
    let bestScore = Infinity
    for (const g of newFacesGeom) {
      const dc = Math.hypot(c[0] - g.c[0], c[1] - g.c[1], c[2] - g.c[2])
      const ar = Math.abs(a - g.a) / Math.max(a, g.a, 1e-12)
      const dn = 1.0 - Math.abs(n[0] * g.n[0] + n[1] * g.n[1] + n[2] * g.n[2])
      const score = dc + 0.01 * ar + 0.001 * dn
      if (score < bestScore) {
        bestScore = score
        best = g.f
      }
    }
    return best !== null && bestScore < 1.0 ? best : null
  }

  // Step 1: old faces -> output via Modified()/geometry.
  for (const oldF of exploreFaces(oc, scope, oldShape)) {
    const c = faceCentroid(oc, scope, oldF)
    const n = faceNormal(oc, scope, oldF)
    const a = faceArea(oc, scope, oldF)
    const tokens = oldFaceLineage[faceGeometryHash(c, n)]
    if (!tokens || tokens.length === 0) continue
    let deleted = false
    try {
      deleted = maker.IsDeleted(oldF)
    } catch {
      deleted = false
    }
    if (deleted) continue
    const modFaces = drainList(scope, maker.Modified(oldF))
    if (modFaces.length > 0) {
      for (const outF of modFaces) newFaceLineage[faceGh(oc, scope, asFace(oc, outF))] = [...tokens]
    } else {
      const outF = findOutputFace(c, a, n)
      if (outF !== null) newFaceLineage[faceGh(oc, scope, outF)] = [...tokens]
    }
  }

  // Step 2: modified edges -> generated faces.
  for (const edge of modifiedEdges) {
    const egh = edgeGh(oc, scope, edge)
    const edgeTokens = egh !== null ? oldEdgeLineage[egh] : undefined
    if (!edgeTokens || edgeTokens.length === 0) continue
    let generated: OccShape[]
    try {
      generated = drainList(scope, maker.Generated(edge))
    } catch {
      continue
    }
    for (const g of generated) {
      for (const gf of exploreFaces(oc, scope, g)) {
        const k = faceGh(oc, scope, asFace(oc, gf))
        if (!(k in newFaceLineage)) newFaceLineage[k] = edgeTokens
      }
    }
  }

  // Step 3: edge lineage from face adjacency (manual e2f, no indexed map).
  const adjacency: Record<string, Set<string>> = {}
  for (const f of exploreFaces(oc, scope, newShape)) {
    const fgh = faceGh(oc, scope, asFace(oc, f))
    for (const e of exploreEdges(oc, scope, f)) {
      const egh = edgeGh(oc, scope, e)
      if (egh === null) continue
      ;(adjacency[egh] ??= new Set()).add(fgh)
    }
  }
  const newEdgeLineage: Lineage = {}
  for (const [egh, fghs] of Object.entries(adjacency)) {
    const eids: string[] = []
    for (const fgh of fghs) for (const eid of newFaceLineage[fgh] ?? []) if (!eids.includes(eid)) eids.push(eid)
    if (eids.length > 0) newEdgeLineage[egh] = eids
  }

  return { faceLineage: newFaceLineage, edgeLineage: newEdgeLineage }
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
  const diff = emptyDiff()

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

  const walk = (outputs: OccShape[], pool: OccShape[]): { fresh: OccShape[]; inherited: OccShape[] } => {
    const fresh: OccShape[] = []
    const inherited: OccShape[] = []
    for (const s of outputs) {
      if (pool.some((p) => (s as OccSubShape).IsSame(p as OccSubShape))) inherited.push(s)
      else fresh.push(s)
    }
    return { fresh, inherited }
  }

  const of = walk(exploreFaces(oc, scope, newShape), faces.preimages)
  const oe = walk(exploreEdges(oc, scope, newShape), edges.preimages)
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
  oldFaceLineage: Lineage,
  oldEdgeLineage: Lineage,
): EdgeModifierResult {
  const fail = (reason: string): EdgeModifierResult => ({
    shape,
    success: false,
    reason,
    faceLineage: null,
    edgeLineage: null,
    diff: emptyDiff(),
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

  let faceLineage: Lineage | null = null
  let edgeLineage: Lineage | null = null
  if (trackLineage) {
    const l = extractLineage(oc, scope, maker, shape, built, appliedEdges, oldFaceLineage, oldEdgeLineage)
    faceLineage = l.faceLineage
    edgeLineage = l.edgeLineage
  }

  let diff: BrepDiff
  try {
    diff = edgeModifierDiff(oc, scope, maker, shape, built)
  } catch {
    diff = emptyDiff()
  }

  return { shape: built, success: true, reason: null, faceLineage, edgeLineage, diff }
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
  faceLineage: Lineage,
  edgeLineage: Lineage,
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, filletSpec(oc, radius), true, faceLineage, edgeLineage)
}

/** Apply a fillet to `edges`, diff only (mirrors `apply_fillet_with_diff`). */
export function applyFilletWithDiff(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  radius: number,
  edges: OccShape[],
): EdgeModifierResult {
  return applyEdgeModifier(oc, scope, shape, edges, filletSpec(oc, radius), false, {}, {})
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
  faceLineage: Lineage,
  edgeLineage: Lineage,
): EdgeModifierResult {
  return applyEdgeModifier(
    oc,
    scope,
    shape,
    edges,
    chamferSpec(oc, distance, kind, angle),
    true,
    faceLineage,
    edgeLineage,
  )
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
  return applyEdgeModifier(oc, scope, shape, edges, chamferSpec(oc, distance, kind, angle), false, {}, {})
}
