// ── Base Types ──────────────────────────────────────────────────────────────

export type Point = [number, number]

// ── Document AST Types ────────────────────────────────────────────────────────

// A query string referencing an entity or sub-element, e.g. "$line1" or "$arc1start".
// See docs/query.md for the full query syntax.
export type PartTarget = string

export interface PartConstraint {
  id: string
  kind: string
  value?: number
  // Generic refs (used by most constraints)
  target?: PartTarget
  a?: PartTarget
  b?: PartTarget
  // Semantic refs (used by tangent, normal, midpoint, etc.)
  line?: PartTarget
  arc?: PartTarget
  point?: PartTarget
  point_a?: PartTarget
  point_b?: PartTarget
  // Optional scalar overrides (used by fixed constraint)
  x?: number
  y?: number
  axis?: string
}

export interface PartEntityDef {
  id: string
  kind: string
  construction?: boolean
}

export interface PartFeature {
  id: string
  kind: string
  label?: string
  plane?: string  // query string, e.g. "@builtin_plane_front"
  entities?: PartEntityDef[]
  initial?: Record<string, number[]>
  constraints?: PartConstraint[]
}

export type Feature = PartFeature

export interface PartDoc {
  oversolved?: number
  version?: number
  kind?: string
  features?: PartFeature[]
}

// ── UI / Rendering Types ──────────────────────────────────────────────────────

export interface LineSegment {
  start: Point
  end: Point
  construction?: boolean
}

export interface Circle {
  center: Point
  radius: number
  construction?: boolean
}

export interface Arc {
  center: Point
  radius: number
  angle_start: number
  angle_end: number
  start: Point
  end: Point
  construction?: boolean
}

export interface PointEntity {
  x: number
  y: number
  construction?: boolean
}

export type Entity = LineSegment | Circle | Arc | PointEntity

export interface Sketch {
  [entityId: string]: Entity
}

export type ConstraintStatus = 'fully_constrained' | 'underconstrained' | 'overconstrained'

export interface SymbolRender {
  kind: string
  at: Point
  entity?: string
  entities?: string[]
}

export interface DimLinearRender {
  kind: 'dim_linear'
  p1: Point
  p2: Point
  normal: Point
  value: number
  entity?: string
}

export interface DimRadiusRender {
  kind: 'dim_radius'
  p1: Point
  p2: Point
  value: number
  entity?: string
}

export interface DimAngleRender {
  kind: 'dim_angle'
  p1: Point
  p2: Point
  p3?: Point
  value: number
  entity?: string
}

export type ConstraintRender = SymbolRender | DimLinearRender | DimRadiusRender | DimAngleRender

export interface Constraint {
  render: ConstraintRender
  residual: number
}

export interface Constraints {
  [constraintId: string]: Constraint
}

export interface TopologyLineEdge {
  kind: 'line'
  start: Point
  end: Point
  start_vertex: string
  end_vertex: string
}

export interface TopologyArcEdge {
  kind: 'arc'
  start: Point
  end: Point
  center: Point
  radius: number
  angle_start_deg: number
  angle_end_deg: number
  ccw: boolean
  start_vertex: string
  end_vertex: string
}

export type TopologyEdge = TopologyLineEdge | TopologyArcEdge

export interface TopologySurface {
  boundary: TopologyEdge[]
}

export interface Topology {
  intersection_points: Record<string, { x: number; y: number }>
  vertices: Record<string, { x: number; y: number }>
  surfaces: TopologySurface[]
}

export interface SketchData {
  solved: Sketch
  constraints?: Constraints
  topology?: Topology
}

export type EntityStatus = Record<string, ConstraintStatus>

// ── Mutation Types ───────────────────────────────────────────────────────────

export type Mutation =
  | { type: 'move_vertex'; featureId: string; entityId: string; vertexKey: string; to: Point }
  | { type: 'move_entity'; featureId: string; entityId: string; delta: Point }
  | { type: 'add_constraint'; featureId: string; kind: string; targets: string[]; value?: number }
  | { type: 'set_constraint_value'; featureId: string; constraintId: string; value: number }
  | { type: 'delete'; targets: string[] }
  | { type: 'add_entity'; featureId: string; kind: string; params: number[] }
  | { type: 'add_rect'; featureId: string; p0: Point; p1: Point }
  | { type: 'toggle_construction'; targets: string[] }
