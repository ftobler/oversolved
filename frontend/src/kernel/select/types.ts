// The structured selector language for kernel/select. A selector is a
// predicate over a solved body set that names faces or edges and returns the
// exact query strings a click would have stored, plus a short geometry summary
// so an authoring agent can see what it picked. The selector is an authoring
// aid and is never persisted: its output, the query strings, is what goes into
// the document, exactly as if each element had been clicked. See
// feature/knowledgebase.agent.md "Headless selection" for why.

/** A 3-vector in world coordinates. */
export type Vec3 = [number, number, number]

export type SelectKind = 'edge' | 'face'

/** A radius test: a bare number is `eq`; an object carries any of eq/min/max. */
export type RadiusTest =
  | number
  | { eq?: number; min?: number; max?: number }

/** The structured predicate grammar, modeled on CadQuery string selectors. */
export type Predicate =
  | { and: Predicate[] }
  | { or: Predicate[] }
  | { not: Predicate }
  // Edge tangent / face normal (CQ "|Z" / the ">Z" axis). An edge tests its own
  // tangent: a line's direction, an arc's tangent at mid-sweep, a spline's
  // tangent at its middle sample. A full circle has no single tangent and
  // matches neither test.
  | { parallel: Vec3 }
  | { perpendicular: Vec3 }
  // Edge kind ('line', 'circle', ...) or face surface_type ('flatface', ...).
  | { type: string }
  // The min/max-projection group of the current candidate set (CQ ">Z"), grouped
  // within the measure tolerance so a box top yields all four of its edges.
  | { extreme: { axis: Vec3; side: 'min' | 'max' } }
  // Edges bounding the faces the inner selector names (adjacency).
  | { on_face: Selector }
  // Ancestry contains this feature id (resolved through the query engine).
  | { created_by: string }
  // Circles, cylinder faces.
  | { radius: RadiusTest }

export interface Selector {
  // Restrict to one body id; omit for every body.
  from?: string
  kind: SelectKind
  where?: Predicate
}

/** A short, JSON-safe geometry description of a picked element. */
export interface EdgeGeometry {
  kind: string
  length?: number
  start?: Vec3
  end?: Vec3
  center?: Vec3
  radius?: number
  axis?: Vec3
  a?: number
  b?: number
  point_count?: number
}

export interface FaceGeometry {
  kind: 'face'
  surface_type: string
  centroid: Vec3
  normal: Vec3
  area?: number
  radius?: number
  axis?: Vec3
}

export interface SelectItem {
  query: string
  kind: SelectKind
  body: string
  index: number
  geometry: EdgeGeometry | FaceGeometry
}

/** What a selector returns: the queries to store, and the per-item detail. */
export interface SelectResult {
  queries: string[]
  items: SelectItem[]
}
