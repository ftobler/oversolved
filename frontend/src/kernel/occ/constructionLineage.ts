// Edge construction names derived from face adjacency (query-naming-by-
// construction.md). An edge is the intersection of two faces, so its UUID is
// derived from the two adjacent face UUIDs -- op-independent, computed uniformly
// after any producer has minted the face names. Multiplicity (a face pair
// sharing >1 edge) is ordered by `orderSplitChildren` and refuses on a near-tie.

import { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccSubShape } from './occTypes'
import {
  edgeToGeom,
  faceCentroid,
  faceNormal,
  faceArea,
  faceSurfaceType,
  readSolidVertices,
  SubShapeIndexMap,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { edgeGh } from './lineageHash'
import { faceGeometryHash } from '../geomHash'
import { normalToFrame, projectWorldToFrame } from '../types3d'
import {
  deriveEdgeUuid,
  deriveSeamEdgeUuid,
  deriveCornerFaceUuid,
  orderSplitChildren,
  type SplitChild,
} from '../constructionName'

// ─── shared parent-frame normalization (the confined world-geometry) ───

/** The parent AABB centre + max-axis span that world-coordinate keys normalize by. */
export interface NormalFrame {
  centre: [number, number, number]
  span: number
}

/**
 * The characteristic frame of a parent shape: its B-rep vertex AABB centre and
 * max-axis span. This is the length every world-coordinate ordering key divides
 * by, so a uniform resize of the parent cancels and the key is dimensionless
 * (comparable to `faceSplitKey`'s sqrt-area scaling and bodySplit's span
 * scaling). Vertex-based like bodySplit's frame, so a curved-face bulge cannot
 * shift it between two rebuilds of the same shape.
 *
 * A vertex-less shape, or any shape whose span is at or below 1e-9 world units,
 * keeps span 1 so the refusal stays honest instead of dividing by ~0. Note the
 * clamp is an ABSOLUTE 1e-9-unit threshold, not an exact zero-span test: a
 * uniform resize of a sub-1e-9-unit shape crosses it and flips that shape's
 * refusal decisions (the clamped span does not cancel under the resize). The
 * alternative -- dividing by the true ~0 span -- makes every key infinite and
 * refuses everything, which is strictly worse.
 */
export function shapeNormalFrame(oc: OccModule, scope: DisposeScope, shape: OccShape): NormalFrame {
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
    span: span > 1e-9 ? span : 1,
  }
}

/**
 * A world-space point as a relative ordering key inside `frame`:
 * (point - centre) / span. All three components dimensionless, so `SPLIT_EPS`
 * means the same fraction of the parent for edge, vertex and corner keys. A
 * NaN component (a failed geometry read) survives the division and is refused
 * by `orderSplitChildren`.
 */
export function normalizedWorldKey(frame: NormalFrame, point: readonly number[]): number[] {
  const c = frame.centre
  return [
    (point[0] - c[0]) / frame.span,
    (point[1] - c[1]) / frame.span,
    (point[2] - c[2]) / frame.span,
  ]
}

/**
 * The world-space midpoint of an edge (line) or, for a circle/arc/ellipse, the
 * point at the MID-PARAMETER (eccentric angle for an ellipse) of its trimmed
 * angle range -- never the bare centre. Two arcs of one conic would otherwise
 * share the centre and produce byte-identical keys: a permanent tie, always
 * refused and both left unnamed, never a swap. The mid-parameter point moves
 * along the curve with the angle range, so distinct arcs order instead. It
 * still cancels under a uniform resize because `normalizedWorldKey` divides by
 * the parent span, and the point scales with the radii exactly like the span.
 * Returns NaN components on a geometry-read failure so `orderSplitChildren`
 * refuses the whole multiplicity group instead of ordering by a fabricated
 * point (the old `[0, 0, 0]` fallback could falsely tie with a real edge at
 * the origin). A conic missing its angle fields (defensive; `edgeToGeom` always
 * fills them) falls back to the centre.
 */
export function edgeMidpoint(oc: OccModule, scope: DisposeScope, edge: OccShape): number[] {
  try {
    const { ed } = edgeToGeom(oc, scope, edge)
    const s = (ed as { start?: number[] }).start
    const e = (ed as { end?: number[] }).end
    const c = (ed as { center?: number[] }).center
    if (Array.isArray(s) && Array.isArray(e)) {
      return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2, (s[2] + e[2]) / 2]
    }
    if (Array.isArray(c)) {
      const radius = (ed as { radius?: number }).radius
      const a = (ed as { a?: number }).a
      const b = (ed as { b?: number }).b
      const axis = (ed as { axis?: number[] }).axis
      const u = (ed as { x_axis?: number[] }).x_axis
      const a0 = (ed as { angle_start?: number }).angle_start
      const a1 = (ed as { angle_end?: number }).angle_end
      if (
        Array.isArray(axis) && Array.isArray(u) &&
        typeof a0 === 'number' && typeof a1 === 'number'
      ) {
        // A circle keys off its radius; an elliptical arc off its semi-major a
        // along x_axis and semi-minor b along v. Without the a/b arm both
        // halves of a split ellipse fell back to the shared centre: byte-equal
        // keys, a permanent tie, and both edges went unnamed.
        const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
        const kCircle = finite(radius) ? radius : null
        const kEllipse = finite(a) && finite(b) ? ([a, b] as const) : null
        if (kCircle === null && kEllipse === null) return [...c]
        // v = axis x u makes a right-handed in-plane basis (bodyGeometry.ts
        // uses the same convention); p(t) = center + kU*cos t*u + kV*sin t*v.
        const [kU, kV] = kEllipse ?? [kCircle as number, kCircle as number]
        const t = (a0 + a1) / 2
        const v = [
          axis[1] * u[2] - axis[2] * u[1],
          axis[2] * u[0] - axis[0] * u[2],
          axis[0] * u[1] - axis[1] * u[0],
        ]
        const ct = Math.cos(t)
        const st = Math.sin(t)
        return [
          c[0] + kU * ct * u[0] + kV * st * v[0],
          c[1] + kU * ct * u[1] + kV * st * v[1],
          c[2] + kU * ct * u[2] + kV * st * v[2],
        ]
      }
      return [...c]
    }
  } catch {
    // fall through
  }
  return [NaN, NaN, NaN]
}

/**
 * A child face centroid expressed in its split parent's normalized in-plane
 * frame: the relative, resize-invariant ordering key for split siblings. The
 * frame comes from the parent's own centroid + normal, scaled by the parent's
 * characteristic length (sqrt area), so a uniform resize of the parent cancels.
 */
export function faceSplitKey(oc: OccModule, scope: DisposeScope, parent: OccShape, child: OccShape): number[] {
  const pc = faceCentroid(oc, scope, parent)
  const pn = faceNormal(oc, scope, parent) as [number, number, number]
  const pa = faceArea(oc, scope, parent)
  const { x_axis, y_axis } = normalToFrame(pn)
  const cc = faceCentroid(oc, scope, child)
  const frame = { origin: pc as [number, number, number], x_axis, y_axis, normal: pn }
  const [u, v] = projectWorldToFrame(cc as [number, number, number], frame)
  const s = Math.sqrt(Math.max(pa, 1e-9))
  return [u / s, v / s]
}

/**
 * One row of `FaceEdgeTable`: a face plus every per-face value the naming
 * passes re-derive. Rows are in TopExp_Explorer order, which is what makes
 * first-wins tie-breaks (deriveEdgeNames' `edgeShapes[egh] ??= edge`,
 * nameFacesFromNeighbours' `seen` dedupe) reproduce byte-for-byte.
 */
export interface FaceRow {
  // Tracked TopoDS_Face on the CALLER's scope; outlives the table.
  face: OccSubShape
  // faceGh, or null when the geometry read threw (undefined normal).
  gh: string | null
  // The error faceGh threw, for consumers that must still fail loud.
  ghError: unknown
  centroid: Vec3 | null
  normal: Vec3 | null
  /** This face's edges in explorer order; edges whose edgeGh failed are dropped,
   *  exactly as every consumer drops them today. */
  edges: { egh: string; edge: OccShape }[]
}

/**
 * One traversal of a shape's faces and their edges, with the geometry-hash keys
 * every construction-naming pass re-derives. Rows are in TopExp_Explorer order,
 * which is what makes first-wins tie-breaks (deriveEdgeNames' `edgeShapes[egh]
 * ??= edge`, nameFacesFromNeighbours' `seen` dedupe) reproduce byte-for-byte.
 *
 * `area` and `surfaceType` are computed lazily per row, because only the prism
 * cap pass wants them and charging every caller a second adaptor + a second
 * GProp integration would make this table a cost REGRESSION for the five
 * callers that need only `gh`.
 *
 * A row whose `faceGh` threw (an undefined UV-midpoint normal) carries
 * `gh: null` + the error: consumers that tolerate it (the cap pass) skip the
 * row, consumers that must fail loud rethrow `ghError`.
 *
 * LIFETIME: a memo keyed on shape identity must not outlive the shapes. One
 * table per pass over one shape, never a module-level singleton, never carried
 * across a feature boundary. The `face`/`edge` proxies belong to the scope
 * passed to `read`, not to the table.
 */
export class FaceEdgeTable {
  static read(oc: OccModule, scope: DisposeScope, shape: OccShape): FaceEdgeTable {
    const E = oc.TopAbs_ShapeEnum
    const rows: FaceRow[] = []
    const rowIndex = new SubShapeIndexMap()
    const faceExp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
    for (; faceExp.More(); faceExp.Next()) {
      const face = scope.track(oc.TopoDS.Face_1(faceExp.Current())) as OccSubShape
      let gh: string | null = null
      let ghError: unknown = null
      let centroid: Vec3 | null = null
      let normal: Vec3 | null = null
      try {
        // One centroid + one normal per face, and the geometry hash derived from
        // them (lineageHash.faceGh is exactly this composition): the cap pass
        // needs the raw values, the naming passes the hash, and neither should
        // pay for the other's read twice.
        centroid = faceCentroid(oc, scope, face)
        normal = faceNormal(oc, scope, face)
        gh = faceGeometryHash(centroid, normal)
      } catch (e) {
        ghError = e
      }
      const edges: { egh: string; edge: OccShape }[] = []
      const eExp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      for (; eExp.More(); eExp.Next()) {
        const edge = scope.track(oc.TopoDS.Edge_1(eExp.Current()))
        const egh = edgeGh(oc, scope, edge)
        if (egh === null) continue
        edges.push({ egh, edge })
      }
      const row: FaceRow = { face, gh, ghError, centroid, normal, edges }
      rowIndex.set(face as OccSubShape, rows.push(row) - 1)
    }
    return new FaceEdgeTable(oc, rows, shape, rowIndex)
  }

  private readonly oc: OccModule
  // Lazy per-row caches: `undefined` means not yet computed, so a row whose read
  // threw is memoized as null and not recomputed on every access.
  private readonly lazyArea = new Map<FaceRow, number | null>()
  private readonly lazySurfaceType = new Map<FaceRow, SurfaceType | null>()
  readonly rows: readonly FaceRow[]
  // The shape the table was read from; the naming passes normalize their split
  // ordering keys in ITS frame (shapeNormalFrame).
  readonly shape: OccShape
  private readonly rowIndex: SubShapeIndexMap

  private constructor(
    oc: OccModule,
    rows: readonly FaceRow[],
    shape: OccShape,
    rowIndex: SubShapeIndexMap,
  ) {
    this.oc = oc
    this.rows = rows
    this.shape = shape
    this.rowIndex = rowIndex
  }

  // Row for a face by topological identity (SubShapeIndexMap), or null.
  rowOf(face: OccSubShape): FaceRow | null {
    const at = this.rowIndex.get(face)
    return at >= 0 ? this.rows[at] : null
  }

  // Face area, computed on first use and memoized per row.
  area(row: FaceRow): number | null {
    const cached = this.lazyArea.get(row)
    if (cached !== undefined) return cached
    const s = new DisposeScope()
    let out: number | null
    try {
      out = faceArea(this.oc, s, row.face)
    } catch {
      out = null
    } finally {
      s.dispose()
    }
    this.lazyArea.set(row, out)
    return out
  }

  // Surface type, computed on first use and memoized per row.
  surfaceType(row: FaceRow): SurfaceType | null {
    const cached = this.lazySurfaceType.get(row)
    if (cached !== undefined) return cached
    const s = new DisposeScope()
    let out: SurfaceType | null
    try {
      out = faceSurfaceType(this.oc, s, row.face)
    } catch {
      out = null
    } finally {
      s.dispose()
    }
    this.lazySurfaceType.set(row, out)
    return out
  }
}

/**
 * Name the faces no source reached off their named neighbours, then derive the
 * edge names from the resulting face adjacency -- the pair every naming pass
 * runs back to back, over ONE traversal instead of two. The order matters and
 * is fixed here: neighbour naming must complete before edge derivation, which
 * needs both faces of an edge named (prismLineage.ts:724-727).
 */
export function nameNeighboursAndDeriveEdges(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceNames: Record<string, string>,
  faceAncestry: Record<string, string[]>,
  skipGhs?: ReadonlySet<string>,
): { edgeNames: Record<string, string>; edgeAncestry: Record<string, string[]> } {
  const t = FaceEdgeTable.read(oc, scope, shape)
  nameFacesFromNeighbours(oc, scope, t, faceNames, faceAncestry, skipGhs)
  return deriveEdgeNames(oc, scope, t, faceNames, faceAncestry)
}

/**
 * Name the faces the producer left unnamed, from the set of their NAMED
 * neighbours (`deriveCornerFaceUuid`) -- the face analogue of the vertex rule in
 * `vertexUuidsFromFaces`. Must run BEFORE `deriveEdgeNames`, whose derivation
 * needs both of an edge's faces named.
 *
 * The case that forced it: where several fillet blends meet, OCC grows a corner
 * patch that is `Generated()` from a VERTEX, not from any filleted edge, so the
 * modifier's edge-driven naming cannot reach it. The patch stayed unnamed, and
 * with it every edge around it -- and an unnamed edge falls back to the body's
 * `createdBy + bodyId + profile_queries` ancestral string, which is IDENTICAL
 * for every unnamed edge on the body. Picks on those edges resolved to whichever
 * sibling classifiers happened to separate, or ambiguously to all of them. See
 * `bugreports/edge_resolves_not_unique_20260728_213049.md`.
 *
 * Mutates `faceNames`/`faceAncestry` in place, only adding faces that had no
 * name -- a producer-minted UUID is never rewritten. Neighbours are read from
 * the pre-pass name set, so no residual name is derived from another residual
 * name and the result is independent of face iteration order.
 *
 * `skipGhs` names faces the caller has assigned a ROLE the pass must not
 * override: a prism cap whose builder omitted FirstShape/LastShape is such a
 * face (its name, if any, comes from the cap path, and the old wire output
 * left it unnamed). Skipped faces keep whatever the producer decided -- named
 * stays named, unnamed stays unnamed -- so the pass can never reclassify them.
 */
export function nameFacesFromNeighbours(
  oc: OccModule,
  scope: DisposeScope,
  source: OccShape | FaceEdgeTable,
  faceNames: Record<string, string>,
  faceAncestry: Record<string, string[]>,
  skipGhs?: ReadonlySet<string>,
): void {
  const t = source instanceof FaceEdgeTable ? source : FaceEdgeTable.read(oc, scope, source)
  const faces: { gh: string; face: OccShape; edges: string[] }[] = []
  const facesOnEdge: Record<string, Set<string>> = {}  // edge gh -> face ghs touching it
  const seen = new Set<string>()
  for (const row of t.rows) {
    // A row whose faceGh read failed must still fail loud, exactly where the
    // direct read did: rows are explorer order, so the throw lands on the same
    // face at the same point of this pass. Only the cap pass tolerates such a
    // row (it skips gh: null); every naming pass rethrows.
    if (row.gh === null) throw row.ghError
    const gh = row.gh
    if (seen.has(gh)) continue
    seen.add(gh)
    if (skipGhs?.has(gh)) continue
    const edges: string[] = []
    for (const { egh } of row.edges) {
      edges.push(egh)
      ;(facesOnEdge[egh] ??= new Set()).add(gh)
    }
    faces.push({ gh, face: row.face, edges })
  }

  type Residual = { gh: string; face: OccShape }
  const bySet: Record<string, Residual[]> = {}  // "uuidA|uuidB|..." -> residual faces
  for (const f of faces) {
    if (f.gh in faceNames) continue
    const neighbours = new Set<string>()
    for (const egh of f.edges) {
      for (const other of facesOnEdge[egh] ?? []) {
        if (other === f.gh) continue
        const uuid = faceNames[other]
        if (uuid) neighbours.add(uuid)
      }
    }
    if (neighbours.size === 0) continue  // nothing symbolic to name it by
    ;(bySet[[...neighbours].sort().join('|')] ??= []).push({ gh: f.gh, face: f.face })
  }

  let frame: NormalFrame | null = null
  for (const [setKey, group] of Object.entries(bySet)) {
    const neighbours = setKey.split('|')
    let ordered: Residual[] | null = group
    if (group.length > 1) {
      // The centroid key must be in the shape's OWN normalized frame, not raw
      // world coordinates: a uniform resize otherwise scales the absolute
      // distance under SPLIT_EPS and makes the refusal unit-dependent.
      frame ??= shapeNormalFrame(oc, scope, t.shape)
      const f = frame
      ordered = orderSplitChildren(
        group.map<SplitChild<Residual>>((r) => ({
          item: r,
          key: normalizedWorldKey(f, faceCentroid(oc, scope, r.face)),
        })),
      )  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((r, i) => {
      const uuid = deriveCornerFaceUuid(neighbours, group.length > 1 ? i : 0)
      faceNames[r.gh] = uuid
      const tokens: string[] = []
      for (const nu of neighbours) for (const t of faceAncestry[nu] ?? []) if (!tokens.includes(t)) tokens.push(t)
      faceAncestry[uuid] = tokens
    })
  }
}

/**
 * (edge_names, edge_ancestry) for a shape, derived from a face-name map
 * (faceGh -> uuid) and face-ancestry map (uuid -> tokens). Each edge whose two
 * adjacent faces are both named gets a UUID from that face pair; the ancestry is
 * the union of the two faces' ancestry tokens.
 */
export function deriveEdgeNames(
  oc: OccModule,
  scope: DisposeScope,
  source: OccShape | FaceEdgeTable,
  faceNames: Record<string, string>,
  faceAncestry: Record<string, string[]>,
): { edgeNames: Record<string, string>; edgeAncestry: Record<string, string[]> } {
  const t = source instanceof FaceEdgeTable ? source : FaceEdgeTable.read(oc, scope, source)
  const adjacency: Record<string, Set<string>> = {}  // edge gh -> set of adjacent face uuid
  const edgeShapes: Record<string, OccShape> = {}  // edge gh -> a representative edge
  for (const row of t.rows) {
    // Same fail-loud rule as nameFacesFromNeighbours: the direct faceGh call
    // sat at the top of every face iteration and threw on an undefined normal.
    if (row.gh === null) throw row.ghError
    const uuid = faceNames[row.gh]
    if (!uuid) continue
    for (const { egh, edge } of row.edges) {
      ;(adjacency[egh] ??= new Set()).add(uuid)
      edgeShapes[egh] ??= edge
    }
  }

  const edgeNames: Record<string, string> = {}
  const edgeAncestry: Record<string, string[]> = {}
  const byPair: Record<string, string[]> = {}  // "uuidA|uuidB" -> [edge gh...]
  const bySingle: Record<string, string[]> = {}  // "uuidA" -> [seam edge gh...]
  for (const [egh, uuidSet] of Object.entries(adjacency)) {
    const distinct = [...uuidSet]
    // Two named faces -> a normal edge; one named face -> a seam edge (e.g. a
    // cylinder's lateral seam). Both must get a UUID so no pickable edge is left
    // with only the ambiguous createdBy+classifiers fallback query.
    if (distinct.length === 2) {
      (byPair[[...distinct].sort().join('|')] ??= []).push(egh)
    } else if (distinct.length === 1) {
      (bySingle[distinct[0]] ??= []).push(egh)
    }
  }
  let frame: NormalFrame | null = null
  for (const [pairKey, eghs] of Object.entries(byPair)) {
    const [a, b] = pairKey.split('|')
    let ordered: string[] | null = eghs
    if (eghs.length > 1) {
      // Edge midpoints are world coordinates: normalize them by the parent
      // shape's span so a uniform resize cancels and the refusal is relative.
      frame ??= shapeNormalFrame(oc, scope, t.shape)
      const f = frame
      const children: SplitChild<string>[] = eghs.map((egh) => ({
        item: egh,
        key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edgeShapes[egh])),
      }))
      ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((egh, i) => {
      const uuid = deriveEdgeUuid(a, b, eghs.length > 1 ? i : 0)
      edgeNames[egh] = uuid
      const tokens: string[] = []
      for (const fu of [a, b]) for (const t of faceAncestry[fu] ?? []) if (!tokens.includes(t)) tokens.push(t)
      edgeAncestry[uuid] = tokens
    })
  }
  for (const [faceUuid, eghs] of Object.entries(bySingle)) {
    let ordered: string[] | null = eghs
    if (eghs.length > 1) {
      frame ??= shapeNormalFrame(oc, scope, t.shape)
      const f = frame
      const children: SplitChild<string>[] = eghs.map((egh) => ({
        item: egh,
        key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edgeShapes[egh])),
      }))
      ordered = orderSplitChildren(children)  // null on a near-tie -> leave unnamed
    }
    if (ordered === null) continue
    ordered.forEach((egh, i) => {
      const uuid = deriveSeamEdgeUuid(faceUuid, eghs.length > 1 ? i : 0)
      edgeNames[egh] = uuid
      edgeAncestry[uuid] = [...(faceAncestry[faceUuid] ?? [])]
    })
  }
  return { edgeNames, edgeAncestry }
}
