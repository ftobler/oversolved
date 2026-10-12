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
  SubShapeDedup,
  SubShapeIndexMap,
  type SurfaceType,
  type Vec3,
} from './primitives'
import { SubShapeMap } from './subshapeIdentity'
import { normalToFrame, projectWorldToFrame } from '../types3d'
import {
  deriveEdgeUuid,
  deriveSeamEdgeUuid,
  deriveEndsEdgeUuid,
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
 * The world-space midpoint of an edge (line) or, for a circle/arc/ellipse or a
 * spline, the point at the MID-PARAMETER (eccentric angle for an ellipse) of its
 * trimmed range -- never the bare centre. Two arcs of one conic would otherwise
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
    const samples = (ed as { points?: number[][] }).points
    if (Array.isArray(s) && Array.isArray(e)) {
      return [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2, (s[2] + e[2]) / 2]
    }
    // A spline has no endpoints or centre, only its samples, taken uniformly in
    // the parameter with both ends included, so the middle one (an odd count) is
    // the mid-parameter point, the same point the conic arm keys off. Without
    // this arm the key was NaN, and one spline refused its whole sibling group.
    if (Array.isArray(samples) && samples.length % 2 === 1) {
      return [...samples[(samples.length - 1) / 2]]
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

/** One row of `FaceEdgeTable`: a face and its edges. */
export interface FaceRow {
  // Tracked TopoDS_Face on the CALLER's scope; outlives the table.
  face: OccSubShape
  /** This face's distinct edges in explorer order (a seam edge, met twice
   *  inside its face, is listed once). */
  edges: OccSubShape[]
}

/**
 * One traversal of a shape's faces and their edges, the topology every
 * construction-naming pass reads. Rows are the shape's canonical face order
 * (occ/bodyNames.ts), so a pass that walks them visits faces and edges in an
 * order fixed by the shape alone.
 *
 * `centroidNormal`, `area` and `surfaceType` are computed lazily per row,
 * because only the prism cap pass wants them and charging every naming pass
 * the geometry reads would make this table a cost regression for the rest.
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
      if (rowIndex.get(face) >= 0) continue  // a face shared by two solids of a shell-only shape
      const edges: OccSubShape[] = []
      const seen = new SubShapeDedup()
      const eExp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
      for (; eExp.More(); eExp.Next()) {
        const edge = scope.track(oc.TopoDS.Edge_1(eExp.Current())) as OccSubShape
        if (seen.add(edge)) edges.push(edge)
      }
      rowIndex.set(face, rows.push({ face, edges }) - 1)
    }
    return new FaceEdgeTable(oc, scope, rows, shape, rowIndex)
  }

  private readonly oc: OccModule
  // The scope `read` was given: the vertex proxies `facesAtEnds` reads live on it
  // like the face and edge proxies do.
  private readonly scope: DisposeScope
  // Vertex -> the faces around it, built on the first `facesAtEnds`; only a
  // refused edge ordering asks, so the other passes never pay for the walk.
  private lazyVertexFaces: SubShapeMap<OccSubShape[]> | null = null
  // Lazy per-row caches: `undefined` means not yet computed, so a row whose read
  // threw is memoized as null and not recomputed on every access.
  private readonly lazyCentroidNormal = new Map<FaceRow, { centroid: Vec3; normal: Vec3 } | null>()
  private readonly lazyArea = new Map<FaceRow, number | null>()
  private readonly lazySurfaceType = new Map<FaceRow, SurfaceType | null>()
  readonly rows: readonly FaceRow[]
  // The shape the table was read from; the naming passes normalize their split
  // ordering keys in ITS frame (shapeNormalFrame).
  readonly shape: OccShape
  private readonly rowIndex: SubShapeIndexMap

  private constructor(
    oc: OccModule,
    scope: DisposeScope,
    rows: readonly FaceRow[],
    shape: OccShape,
    rowIndex: SubShapeIndexMap,
  ) {
    this.oc = oc
    this.scope = scope
    this.rows = rows
    this.shape = shape
    this.rowIndex = rowIndex
  }

  // Row for a face by topological identity (SubShapeIndexMap), or null.
  rowOf(face: OccSubShape): FaceRow | null {
    const at = this.rowIndex.get(face)
    return at >= 0 ? this.rows[at] : null
  }

  // Face centroid and normal, computed on first use; null when the read threw
  // (an undefined UV-midpoint normal).
  centroidNormal(row: FaceRow): { centroid: Vec3; normal: Vec3 } | null {
    const cached = this.lazyCentroidNormal.get(row)
    if (cached !== undefined) return cached
    const s = new DisposeScope()
    let out: { centroid: Vec3; normal: Vec3 } | null
    try {
      out = { centroid: faceCentroid(this.oc, s, row.face), normal: faceNormal(this.oc, s, row.face) }
    } catch {
      out = null
    } finally {
      s.dispose()
    }
    this.lazyCentroidNormal.set(row, out)
    return out
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

  // The faces around each distinct end vertex of `edge` (one list for a closed
  // edge), in canonical face order.
  facesAtEnds(edge: OccSubShape): OccSubShape[][] {
    const vertexFaces = (this.lazyVertexFaces ??= this.readVertexFaces())
    return this.verticesOf(edge).map((v) => vertexFaces.get(v) ?? [])
  }

  private verticesOf(edge: OccSubShape): OccSubShape[] {
    const E = this.oc.TopAbs_ShapeEnum
    const seen = new SubShapeDedup()
    const out: OccSubShape[] = []
    const exp = this.scope.track(new this.oc.TopExp_Explorer_2(edge, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
    for (; exp.More(); exp.Next()) {
      const v = this.scope.track(this.oc.TopoDS.Vertex_1(exp.Current())) as OccSubShape
      if (seen.add(v)) out.push(v)
    }
    return out
  }

  private readVertexFaces(): SubShapeMap<OccSubShape[]> {
    const map = new SubShapeMap<OccSubShape[]>()
    for (const row of this.rows) {
      const seen = new SubShapeDedup()  // a vertex meets this face through two of its edges
      for (const edge of row.edges) {
        for (const v of this.verticesOf(edge)) if (seen.add(v)) pushTo(map, v, row.face)
      }
    }
    return map
  }
}

/**
 * Name the faces no source reached off their named neighbours, then derive the
 * edge names from the resulting face adjacency -- the pair every naming pass
 * runs back to back, over ONE traversal instead of two. The order matters and
 * is fixed here: neighbour naming must complete before edge derivation, which
 * needs both faces of an edge named.
 */
export function nameNeighboursAndDeriveEdges(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceNames: SubShapeMap<string>,
  faceAncestry: Record<string, string[]>,
  skip?: FaceSet,
): { edgeNames: SubShapeMap<string>; edgeAncestry: Record<string, string[]> } {
  const t = FaceEdgeTable.read(oc, scope, shape)
  nameFacesFromNeighbours(oc, scope, t, faceNames, faceAncestry, skip)
  return deriveEdgeNames(oc, scope, t, faceNames, faceAncestry)
}

/** A set of faces by identity, as the neighbour pass reads its skip list. */
export interface FaceSet {
  has(face: OccSubShape): boolean
}

/** Push `item` onto the list `map` holds for `key`, creating it on first use. */
function pushTo<T>(map: SubShapeMap<T[]>, key: OccSubShape, item: T): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [item])
  else list.push(item)
}

/** Push `item` onto the list `groups` holds for the string `key`, in first-seen key order. */
function pushGroup<T>(groups: Map<string, T[]>, key: string, item: T): void {
  const list = groups.get(key)
  if (list === undefined) groups.set(key, [item])
  else list.push(item)
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
 * name -- a producer-minted UUID is never rewritten. It runs in rounds until
 * one names nothing, so a face reachable only through other new faces (the
 * floor of a pocket cut by an unnamed tool, behind its walls) is named too.
 * Each round reads only the names fixed by the rounds before it, so the result
 * is independent of face iteration order. The first round is the old single
 * pass, so a face it names keeps the uuid it always had.
 *
 * `skip` names faces the caller has assigned a ROLE the pass must not
 * override: a prism cap whose builder omitted FirstShape/LastShape is such a
 * face (its name, if any, comes from the cap path, and the old wire output
 * left it unnamed). Skipped faces keep whatever the producer decided -- named
 * stays named, unnamed stays unnamed -- so the pass can never reclassify them.
 */
export function nameFacesFromNeighbours(
  oc: OccModule,
  scope: DisposeScope,
  source: OccShape | FaceEdgeTable,
  faceNames: SubShapeMap<string>,
  faceAncestry: Record<string, string[]>,
  skip?: FaceSet,
): void {
  const t = source instanceof FaceEdgeTable ? source : FaceEdgeTable.read(oc, scope, source)
  const rows = t.rows.filter((row) => !skip?.has(row.face))
  const facesOnEdge = new SubShapeMap<OccSubShape[]>()  // edge -> the faces touching it
  for (const row of rows) for (const edge of row.edges) pushTo(facesOnEdge, edge, row.face)
  // Every uuid already on a face. A corner uuid is a hash of the neighbour set, so
  // an earlier pass over the same body can already hold the very uuid this pass
  // derives for a different face: two unnamed through-cuts made one after another
  // between the same two caps both hash to {top, bottom}. Holes hit this until
  // they named their faces from the drill site (features/hole.ts); the skip stays
  // as the safety net for any producer that still leaves its tool unnamed.
  const taken = new Set<string>()
  for (const row of t.rows) {
    const uuid = faceNames.get(row.face)
    if (uuid) taken.add(uuid)
  }

  let frame: NormalFrame | null = null
  // Rounds, until a round names nothing. A face whose every neighbour is itself
  // new (a pocket floor inside unnamed walls) has nothing to be named
  // by until that neighbour is, so a single round left it unnamed. Each round
  // reads only the names fixed before it began, never one minted in the same
  // round, so the result is still independent of face iteration order.
  for (;;) {
    const bySet = new Map<string, OccSubShape[]>()  // "uuidA|uuidB|..." -> residual faces
    for (const row of rows) {
      if (faceNames.has(row.face)) continue
      const neighbours = new Set<string>()
      for (const edge of row.edges) {
        for (const other of facesOnEdge.get(edge) ?? []) {
          if (other.IsSame(row.face)) continue
          const uuid = faceNames.get(other)
          if (uuid) neighbours.add(uuid)
        }
      }
      if (neighbours.size === 0) continue  // nothing symbolic to name it by (yet)
      pushGroup(bySet, [...neighbours].sort().join('|'), row.face)
    }

    const named: Array<{ face: OccSubShape; uuid: string; neighbours: string[] }> = []
    for (const [setKey, group] of bySet) {
      const neighbours = setKey.split('|')
      let ordered: OccSubShape[] | null = group
      if (group.length > 1) {
        // The centroid key must be in the shape's OWN normalized frame, not raw
        // world coordinates: a uniform resize otherwise scales the absolute
        // distance under SPLIT_EPS and makes the refusal unit-dependent.
        frame ??= shapeNormalFrame(oc, scope, t.shape)
        const f = frame
        ordered = orderSplitChildren(
          group.map<SplitChild<OccSubShape>>((face) => ({
            item: face,
            key: normalizedWorldKey(f, faceCentroid(oc, scope, face)),
          })),
        )  // null on a near-tie -> leave unnamed
      }
      if (ordered === null) continue
      // The multiplicity skips a uuid some face already holds; without a clash it
      // is 0 for a lone face and the sibling rank for a group, as it always was.
      let multiplicity = 0
      for (const face of ordered) {
        while (taken.has(deriveCornerFaceUuid(neighbours, multiplicity))) multiplicity++
        const uuid = deriveCornerFaceUuid(neighbours, multiplicity++)
        taken.add(uuid)
        named.push({ face, uuid, neighbours })
      }
    }
    if (named.length === 0) return

    // Committed after the whole round is grouped, so no face of this round sees
    // another's fresh name as a neighbour.
    for (const { face, uuid, neighbours } of named) {
      faceNames.set(face, uuid)
      const tokens: string[] = []
      for (const nu of neighbours) for (const t of faceAncestry[nu] ?? []) if (!tokens.includes(t)) tokens.push(t)
      faceAncestry[uuid] = tokens
    }
  }
}

/**
 * (edge names, edge ancestry) for a shape, derived from its face names and the
 * face-ancestry map (uuid -> tokens). Each edge whose two adjacent faces are
 * both named gets a UUID from that face pair; the ancestry is the union of the
 * two faces' ancestry tokens.
 */
export function deriveEdgeNames(
  oc: OccModule,
  scope: DisposeScope,
  source: OccShape | FaceEdgeTable,
  faceNames: SubShapeMap<string>,
  faceAncestry: Record<string, string[]>,
): { edgeNames: SubShapeMap<string>; edgeAncestry: Record<string, string[]> } {
  const t = source instanceof FaceEdgeTable ? source : FaceEdgeTable.read(oc, scope, source)
  const adjacency = new SubShapeMap<Set<string>>()  // edge -> its adjacent named face uuids
  const edgeOrder: OccSubShape[] = []  // every such edge once, first-seen order
  for (const row of t.rows) {
    const uuid = faceNames.get(row.face)
    if (!uuid) continue
    for (const edge of row.edges) {
      let set = adjacency.get(edge)
      if (set === undefined) {
        adjacency.set(edge, (set = new Set()))
        edgeOrder.push(edge)
      }
      set.add(uuid)
    }
  }

  const byPair = new Map<string, OccSubShape[]>()  // "uuidA|uuidB" -> its edges
  const bySingle = new Map<string, OccSubShape[]>()  // "uuidA" -> its seam edges
  for (const edge of edgeOrder) {
    const distinct = [...adjacency.get(edge)!]
    // Two named faces -> a normal edge; one named face -> a seam edge (e.g. a
    // cylinder's lateral seam). Both must get a UUID so no pickable edge is left
    // with only the ambiguous createdBy+classifiers fallback query.
    if (distinct.length === 2) pushGroup(byPair, [...distinct].sort().join('|'), edge)
    else if (distinct.length === 1) pushGroup(bySingle, distinct[0], edge)
  }
  return nameEdgeGroups(oc, scope, t, faceNames, byPair, bySingle, (uuids) => {
    const tokens: string[] = []
    for (const fu of uuids) for (const tk of faceAncestry[fu] ?? []) if (!tokens.includes(tk)) tokens.push(tk)
    return tokens
  })
}

/**
 * Name grouped edges: an edge between two named faces from the face pair, a
 * seam edge from its one face. A group of more than one edge (a face pair
 * sharing several edges) is ordered by the edge midpoints in the table shape's
 * own normalized frame. When that ordering refuses on a near-tie, each edge
 * whose ends tell it apart from its siblings by name is named by them instead
 * (`endsKey`), and only an edge still indistinguishable stays unnamed.
 * `ancestryOf` gives an edge's tokens from the face uuids it was named by.
 */
export function nameEdgeGroups(
  oc: OccModule,
  scope: DisposeScope,
  table: FaceEdgeTable,
  faceNames: SubShapeMap<string>,
  byPair: ReadonlyMap<string, OccSubShape[]>,
  bySingle: ReadonlyMap<string, OccSubShape[]>,
  ancestryOf: (faceUuids: string[], edge: OccSubShape) => string[],
): { edgeNames: SubShapeMap<string>; edgeAncestry: Record<string, string[]> } {
  const edgeNames = new SubShapeMap<string>()
  const edgeAncestry: Record<string, string[]> = {}
  let frame: NormalFrame | null = null
  const order = (edges: OccSubShape[]): OccSubShape[] | null => {
    if (edges.length < 2) return edges
    // Edge midpoints are world coordinates: normalize them by the parent
    // shape's span so a uniform resize cancels and the refusal is relative.
    frame ??= shapeNormalFrame(oc, scope, table.shape)
    const f = frame
    return orderSplitChildren(
      edges.map<SplitChild<OccSubShape>>((edge) => ({ item: edge, key: normalizedWorldKey(f, edgeMidpoint(oc, scope, edge)) })),
    )  // null on a near-tie -> try the ends below
  }
  const name = (edge: OccSubShape, uuid: string, namedBy: string[]): void => {
    edgeNames.set(edge, uuid)
    edgeAncestry[uuid] = ancestryOf(namedBy, edge)
  }
  const nameByEnds = (edges: OccSubShape[], namedBy: string[]): void => {
    const keys = edges.map((edge) => endsKey(table, faceNames, edge, namedBy))
    edges.forEach((edge, i) => {
      if (keys.indexOf(keys[i]) === keys.lastIndexOf(keys[i])) name(edge, deriveEndsEdgeUuid(namedBy, keys[i]), namedBy)
    })
  }
  for (const [pairKey, edges] of byPair) {
    const [a, b] = pairKey.split('|')
    const ordered = order(edges)
    if (ordered === null) nameByEnds(edges, [a, b])
    else ordered.forEach((edge, i) => name(edge, deriveEdgeUuid(a, b, edges.length > 1 ? i : 0), [a, b]))
  }
  for (const [faceUuid, edges] of bySingle) {
    const ordered = order(edges)
    if (ordered === null) nameByEnds(edges, [faceUuid])
    else ordered.forEach((edge, i) => name(edge, deriveSeamEdgeUuid(faceUuid, edges.length > 1 ? i : 0), [faceUuid]))
  }
  return { edgeNames, edgeAncestry }
}

/**
 * What an edge's ends say about it by name: per distinct end vertex, the named
 * faces met there other than `namedBy` (the faces the edge is named after, which
 * every sibling shares), sorted; the ends sorted too, so the edge's orientation
 * does not matter. Topology and face uuids only, so it is copy-stable and no
 * geometry becomes identity. On the array-cut corpus a long elliptical edge and
 * a tiny spline between the same two faces near-tie on their midpoints, yet one
 * runs between two vertices only that pair meets at, the other ends on a third
 * face.
 */
function endsKey(table: FaceEdgeTable, faceNames: SubShapeMap<string>, edge: OccSubShape, namedBy: string[]): string {
  return table.facesAtEnds(edge)
    .map((faces) => {
      const uuids = new Set<string>()
      for (const face of faces) {
        const uuid = faceNames.get(face)
        if (uuid && !namedBy.includes(uuid)) uuids.add(uuid)
      }
      return [...uuids].sort().join(',')
    })
    .sort()
    .join(';')
}
