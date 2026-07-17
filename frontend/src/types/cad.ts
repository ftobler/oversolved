// ── Base Types ────

export type Point = [number, number]

// A numeric parameter that the user may also enter as a math expression string
// (e.g. "50+25", "width*2"). Plain numbers are kept for legacy docs and zero
// overhead; expression strings are resolved to numbers in the solve pipeline
// (kernel/evalExpr.ts) before the leaf solver runs.
export type NumberOrExpr = number | string

export type ActiveTool = 'select' | 'dimension' | 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'point' | 'ngon' | 'project' | 'drag' | 'mirror' | 'offset' | null

// Which geometric space the current selection lives in.
export type SelectionDomain = 'sketch_2d' | 'body_3d' | 'plane_3d' | 'mixed'

export type ExtrudeDirection = 'normal' | 'reverse' | 'symmetric'
export type ExtrudeOperation = 'add' | 'cut' | 'new'
export type ExtrudeTermination = 'blind' | 'up_to'

export interface ExtrudeFeatureDef {
  sketch: string | string[]
  distance: NumberOrExpr
  direction?: ExtrudeDirection
  // 'blind' (default) extrudes by `distance`; 'up_to' terminates at the element
  // referenced by `up_to` (a plane, point, or planar face).
  termination?: ExtrudeTermination
  up_to?: string
  operation?: ExtrudeOperation
  merge_target?: string
}

export interface FilletFeatureDef {
  edges: string[]
  radius: NumberOrExpr
}

export interface ChamferFeatureDef {
  edges: string[]
  distance: NumberOrExpr
  kind?: 'distance' | 'angle_distance'
  angle?: NumberOrExpr
}

export interface BooleanFeatureDef {
  operation: 'union' | 'subtract' | 'intersect'
  target: string
  tools: string[]
  keep_tools?: boolean
}

export interface ArrayFeatureDef {
  source_body?: string
  mode?: 'linear' | 'rectangular'
  operation?: 'add' | 'new'
  include_source?: boolean
  count_x?: NumberOrExpr
  pitch_x?: NumberOrExpr
  direction_x?: [number, number, number]
  direction_x_query?: string
  invert_x?: boolean
  count_y?: NumberOrExpr
  pitch_y?: NumberOrExpr
  direction_y?: [number, number, number]
  direction_y_query?: string
  invert_y?: boolean
}

export interface CircularArrayFeatureDef {
  source_body?: string
  operation?: 'add' | 'new'
  include_source?: boolean
  count?: NumberOrExpr
  step_angle?: NumberOrExpr | null
  axis?: string
  axis_origin?: [number, number, number]
  axis_direction?: [number, number, number]
}

export type RevolveDirection = 'normal' | 'reverse' | 'symmetric'

export interface RevolveFeatureDef {
  sketch: string | string[]
  angle: NumberOrExpr
  direction?: RevolveDirection
  axis?: string
  axis_origin?: [number, number, number]
  axis_direction?: [number, number, number]
  operation?: 'add' | 'cut' | 'new'
  merge_target?: string
}

export interface SweepFeatureDef {
  sketch: string | string[]  // profile reference(s)
  path: string | string[]  // spine reference(s): sketch edges that form the path
  operation?: 'add' | 'cut' | 'new'
  merge_target?: string
}

export interface DeleteBodyFeatureDef {
  body: string
}

export interface HoleFeatureDef {
  sketch: string
  diameter: NumberOrExpr
  depth_mode: 'blind' | 'through_all'
  depth: NumberOrExpr
  direction?: 'normal' | 'reverse'
  target?: string
}

export interface MirrorFeatureDef {
  body: string
  plane: string
  keep_original?: boolean
  merge?: boolean
}

export interface TransformFeatureDef {
  body: string
  operation?: 'new' | 'replace'
  translation?: [number, number, number]
  translation_from?: string
  translation_to?: string
  rotation_angle?: NumberOrExpr
  rotation_axis_origin?: [number, number, number]
  rotation_axis_direction?: [number, number, number]
  rotation_axis?: string
  scale?: NumberOrExpr
  scale_center?: [number, number, number]
  scale_center_from?: string
}

export interface VariableFeatureDef {
  expression: NumberOrExpr  // math formula, e.g. "width * 2 + 10" (or a plain number)
  value?: number            // cached evaluated result (written by the solver, read-only in UI)
  unit?: string             // optional display hint ("mm", "deg")
}

export interface FaceData {
  centroid: [number, number, number]
  normal: [number, number, number]
  area?: number
}

export interface Mesh3D {
  vertices: Float32Array | [number, number, number][]
  faces:    Uint32Array | [number, number, number][]
  face_data?: FaceData[]
  triangle_to_face?: number[]
  face_queries?: string[]
  /** Per-face boundary edge ancestry queries, aligned with `face_queries`. */
  face_edge_queries?: string[][]
}

export interface EdgeDataLine {
  kind: 'line'
  start: [number, number, number]
  end: [number, number, number]
}

export interface EdgeDataCircleArc {
  kind: 'circle' | 'arc'
  center: [number, number, number]
  radius: number
  axis: [number, number, number]
  x_axis: [number, number, number]
  angle_start: number
  angle_end: number
}

export interface EdgeDataSpline {
  kind: 'spline'
  points: [number, number, number][]
}

export interface EdgeDataEllipse {
  kind: 'ellipse'
  center: [number, number, number]
  a: number  // semi-major radius
  b: number  // semi-minor radius
  axis: [number, number, number]    // normal of the ellipse plane
  x_axis: [number, number, number]  // direction of the major axis
  angle_start: number  // parametric eccentric-angle range; a partial elliptical
  angle_end: number    // edge (cylinder cut, etc.) is an arc, not a full ellipse
}

export type EdgeData = EdgeDataLine | EdgeDataCircleArc | EdgeDataSpline | EdgeDataEllipse

export interface BodyResult {
  id: string
  created_by: string
  modified_by: string[]
  mesh?: Mesh3D
  mesh_error?: string
  edges?: EdgeData[]
  edge_queries?: string[]
  vertices?: [number, number, number][]
  vertex_queries?: string[]
}

export interface RebuildValidation {
  level: 1 | 2 | 3
  passed: boolean
  fp_only?: boolean
  diffs: Record<string, unknown>
}

export interface BuildResponse {
  solve_ms: number
  result: Record<string, unknown>
  bodies: Record<string, BodyResult>
  pick_bodies?: Record<string, BodyResult>
  _build_state?: unknown
  validation?: RebuildValidation
}

export interface BodyFeatureResult {
  status: 'ok' | 'exception' | 'partial'
  body_id?: string
  body_ids?: string[]
  exception?: string
  mesh_warning?: string
  solver_warning?: string
  solve_ms?: number
}

export function isBodyFeatureResult(r: unknown): r is BodyFeatureResult {
  return typeof r === 'object' && r !== null && ('body_id' in r || 'body_ids' in r)
}

// ── Document AST Types ────

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
  // N-ary refs (used by sugar constructions such as `ngon`, which references an
  // arbitrary number of member entities). Lowered to primitive constraints
  // before the solver runs; the solver never sees a `refs` array directly.
  refs?: PartTarget[]
  // Semantic refs (used by tangent, normal, midpoint, etc.)
  line?: PartTarget
  arc?: PartTarget
  point?: PartTarget
  point_a?: PartTarget
  point_b?: PartTarget
  // Dock host: the id of another constraint in the same sketch whose implied
  // geometry (e.g. a tangent's contact foot) this constraint pins `point` to.
  // Used by the `dock` constraint kind (lazy inferred materialization). Stored as
  // a constraint id, NOT an entity ref, so the lowering looks it up among the
  // feature's constraints; a missing host lowers to nothing (the point floats).
  host?: string
  // Optional scalar overrides (used by fixed constraint)
  x?: number
  y?: number
  axis?: string
  // Orientation selector for directional dimensions (point_distance_x/y,
  // line_distance, angle): +1 or -1. Picks which side / handedness the signed
  // measure must match, keeping `value` non-negative. Absent = legacy
  // side-agnostic (absolute) behavior. Authored from the drawn geometry at
  // creation and swapped after the fact via the dimension dialog's Flip side button.
  sign?: number
  // Dimension label position — 2D offset in sketch space relative to the
  // constraint's anchor point (midpoint of measured points for linear dims,
  // center for radius/diameter, vertex for angle).  When absent the renderer
  // uses a default offset derived from sketch extent.
  pos?: [number, number]
}

export interface PartEntityDef {
  id: string
  kind: string
  construction?: boolean
  source?: string  // for projected entities: reference to source entity (e.g. "@sketch0/line1")
}

export interface PlaneDef {
  mode?: 'offset' | 'three_point' | 'plane_point' | 'line_angle' | 'edge_point' | 'on_face' | 'on_face_edge_angle'
  plane?: string
  offset?: NumberOrExpr
  p1?: string
  p2?: string
  p3?: string
  point?: string
  line?: string
  edge?: string
  face?: string
  angle?: NumberOrExpr
  rotation?: NumberOrExpr
}

export interface PartFeature {
  id: string
  kind: string
  label?: string
  visible?: boolean  // absent means visible; false means hidden
  suppressed?: boolean  // absent or false = active; true = backend skips this feature
  plane?: string  // query string, e.g. "@builtin_plane_front"
  entities?: PartEntityDef[]
  initial?: Record<string, number[]>
  constraints?: PartConstraint[]
  definition?: PlaneDef
  extrude?: ExtrudeFeatureDef  // present when kind === 'extrude'
  revolve?: RevolveFeatureDef  // present when kind === 'revolve'
  sweep?: SweepFeatureDef  // present when kind === 'sweep'
  fillet?: FilletFeatureDef  // present when kind === 'fillet'
  chamfer?: ChamferFeatureDef  // present when kind === 'chamfer'
  boolean?: BooleanFeatureDef  // present when kind === 'boolean'
  array?: ArrayFeatureDef  // present when kind === 'array'
  circular_array?: CircularArrayFeatureDef  // present when kind === 'circular_array'
  delete_body?: DeleteBodyFeatureDef  // present when kind === 'delete_body'
  hole?: HoleFeatureDef  // present when kind === 'hole'
  transform?: TransformFeatureDef  // present when kind === 'transform'
  mirror?: MirrorFeatureDef  // present when kind === 'mirror'
  variable?: VariableFeatureDef  // present when kind === 'variable'
  file_id?: string  // legacy upload handle (kind === 'import_step'); superseded by file_data
  file_data?: string  // inline base64 STEP bytes (kind === 'import_step'); read in-browser, parsed by the WASM kernel
  drag_anchor?: string  // transient solve-only hint: entity just dragged, anchored firmly by the solver
}

export type Feature = PartFeature

export interface PartStyleEntry {
  name?: string
  color?: string
  visible?: boolean
  transparency?: number  // 0-1 (0 = opaque, 1 = fully transparent)
  metalness?: number     // 0-1 (0 = non-metallic, 1 = fully metallic)
  roughness?: number     // 0-1 (0 = smooth, 1 = rough)
  transmission?: number  // 0-1 (0 = opaque, 1 = fully transmissive / glass-like)
  created_by?: string
}

export interface PartDoc {
  oversolved?: number
  version?: number
  kind?: string
  // Feature-tree rollback bar position, as an index into `features`. Absent
  // means "end of stack"; a rolled-back doc reopens where the user left it.
  rollback?: number
  features?: PartFeature[]
  part_style?: Record<string, PartStyleEntry>
}

// ── UI / Rendering Types ────

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
  projected?: boolean
}

export interface Ellipse {
  center: Point
  a: number       // semi-major radius
  b: number       // semi-minor radius
  theta: number   // major-axis rotation in degrees (matches the arc-angle convention)
  construction?: boolean
}

export interface Spline {
  p1: Point   // start point (on-curve)
  p2: Point   // control point 1 (off-curve)
  p3: Point   // control point 2 (off-curve)
  p4: Point   // end point (on-curve)
  construction?: boolean
}

// Projected entity variants — read-only reference geometry from another sketch
export interface ProjectedLineSegment extends LineSegment {
  projected: true
  source: string
}

export interface ProjectedCircle extends Circle {
  projected: true
  source: string
}

export interface ProjectedArc extends Arc {
  projected: true
  source: string
}

export interface ProjectedPointEntity extends PointEntity {
  projected: true
  source: string
}

export interface ProjectedEllipse extends Ellipse {
  projected: true
  source: string
}

export interface ProjectedSpline extends Spline {
  projected: true
  source: string
}

export type ProjectedEntity =
  | ProjectedLineSegment
  | ProjectedCircle
  | ProjectedArc
  | ProjectedPointEntity
  | ProjectedEllipse
  | ProjectedSpline

export type Entity = LineSegment | Circle | Arc | PointEntity | Ellipse | Spline | ProjectedEntity

export function isProjectedEntity(e: Entity): e is ProjectedEntity {
  return 'projected' in e && (e as ProjectedEntity).projected === true
}

export function isProjectedLine(e: Entity): e is ProjectedLineSegment {
  return isProjectedEntity(e) && 'start' in e && !('radius' in e)
}

export function isProjectedCircle(e: Entity): e is ProjectedCircle {
  return isProjectedEntity(e) && 'center' in e && 'radius' in e && !('angle_start' in e)
}

export function isProjectedArc(e: Entity): e is ProjectedArc {
  return isProjectedEntity(e) && 'angle_start' in e
}

export function isProjectedEllipse(e: Entity): e is ProjectedEllipse {
  return isProjectedEntity(e) && 'center' in e && 'a' in e
}

export function isProjectedPoint(e: Entity): e is ProjectedPointEntity {
  return isProjectedEntity(e) && 'x' in e
}

export function isProjectedSpline(e: Entity): e is ProjectedSpline {
  return isProjectedEntity(e) && 'p1' in e
}

export type EntityKind = 'line' | 'arc' | 'circle' | 'ellipse' | 'spline' | 'point'

export function getEntityKind(entity: Entity): EntityKind {
  if ('start' in entity && 'end' in entity && 'radius' in entity) return 'arc'
  if ('start' in entity && 'end' in entity) return 'line'
  if ('center' in entity && 'radius' in entity) return 'circle'
  if ('center' in entity && 'a' in entity) return 'ellipse'
  if ('p1' in entity) return 'spline'
  return 'point'
}

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
  // Originating constraint kind, present only for the directional linear dims
  // (point_distance_x / point_distance_y / line_distance). The render `kind` is
  // always 'dim_linear', so the renderer reads this to know whether the dim has
  // an orientation side (and which sign convention) for the "Flip side" button.
  dimKind?: string
  entity?: string
  // Label offset in sketch space relative to midpoint(p1, p2).
  pos?: Point
  // Entity segment bounding the extension line on each side
  // (x1, y1, x2, y2). When present the renderer can skip the
  // extension line if the dimension-line endpoint projects inside.
  ext1_line?: [number, number, number, number]
  ext2_line?: [number, number, number, number]
}

export interface DimRadiusRender {
  kind: 'dim_radius'
  p1: Point  // center
  p2: Point  // edge point
  value: number
  entity?: string
  // Label offset in sketch space relative to center (p1).
  pos?: Point
}

export interface DimDiameterRender {
  kind: 'dim_diameter'
  p1: Point
  p2: Point
  value: number
  entity?: string
  // Label offset in sketch space relative to midpoint(p1, p2).
  pos?: Point
}

export interface DimAngleRender {
  kind: 'dim_angle'
  // Line A start. Direction da = p2 − p1.
  p1: Point
  // Line A end.
  p2: Point
  // Line B start. Direction db = p4 − p3.
  p3: Point
  // Line B end.
  p4: Point
  value: number
  entity?: string
  // Label offset in sketch space relative to the shared vertex.
  pos?: Point
}

export interface UnknownRender {
  kind: 'unknown'
}

export type ConstraintRender = SymbolRender | DimLinearRender | DimRadiusRender | DimDiameterRender | DimAngleRender | UnknownRender

export interface Constraint {
  render: ConstraintRender
  residual: number
  superfluous?: boolean
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

export interface TopologySplineEdge {
  kind: 'spline'
  start: Point
  end: Point
  c1: Point  // first cubic-Bezier control handle
  c2: Point  // second cubic-Bezier control handle
}

export interface TopologyEllipseEdge {
  kind: 'ellipse'
  center: Point
  a: number  // semi-major radius
  b: number  // semi-minor radius
  theta: number  // major-axis rotation, degrees (sketch CCW)
  start_vertex: string | null
  end_vertex: string | null
  id?: string
}

// A partial elliptical arc -- the result of slicing a full ellipse. Carries the
// same carrier as TopologyEllipseEdge plus an eccentric-angle range (the
// Geom_Ellipse parameter, degrees), so the OCC writer trims the conic exactly.
export interface TopologyEllipseArcEdge {
  kind: 'ellipse_arc'
  center: Point
  a: number
  b: number
  theta: number
  angle_start_deg: number  // eccentric angle, degrees
  angle_end_deg: number
  ccw: boolean
  start: Point
  end: Point
  start_vertex: string
  end_vertex: string
  id?: string
}

export type TopologyEdge =
  | TopologyLineEdge
  | TopologyArcEdge
  | TopologySplineEdge
  | TopologyEllipseEdge
  | TopologyEllipseArcEdge

export interface TopologySurface {
  boundary: TopologyEdge[]  // the outer loop
  holes?: TopologyEdge[][]  // inner loops, one per hole -- maps to OCC face holes (orientation fixed by the face builder)
  query: string
}

export interface TopologyEdgeQuery {
  query: string
  entity_id: string
  edge_index: number
  start: Point
  end: Point
  kind: string
  center?: Point
  radius?: number
  angle_start_deg?: number
  angle_end_deg?: number
  c1?: Point
  c2?: Point
  a?: number
  b?: number
  theta?: number
  ccw?: boolean
}

export interface Topology {
  intersection_points: Record<string, { x: number; y: number }>
  vertices: Record<string, { x: number; y: number }>
  edges: TopologyEdgeQuery[]
  surfaces: TopologySurface[]
}

export interface PlaneTransform {
  rotation: number[]  // row-major 3×3 rotation matrix (9 elements)
  origin: number[]  // world-space origin [x, y, z]
}

// Draggable editing-handle descriptor emitted by the kernel per brep feature
// (extrude distance, revolve angle, fillet radius, chamfer distance). Dragging
// the grab point by d world units along `direction` changes `field` by
// d / unit_scale; `anchor` is the grab point at the current `value`.
export interface FeatureHandleData {
  kind: 'linear' | 'angular'
  field: string
  anchor: [number, number, number]
  direction: [number, number, number]
  value: number
  unit_scale: number
  min: number
  max?: number
}

export interface SketchData {
  solved: Sketch
  constraints?: Constraints
  topology?: Topology
  status?: string
  features?: EntityStatus
  originLocal?: [number, number]
  plane_transform?: PlaneTransform
  plane?: { origin: [number, number, number]; x_axis: [number, number, number]; y_axis: [number, number, number]; normal: [number, number, number] }
  body_id?: string
  exception?: string
  handle?: FeatureHandleData  // editing handle for brep features (extrude/revolve/fillet/chamfer)
}

export type EntityStatus = Record<string, ConstraintStatus>

// ── Mutation Types ────

export type Mutation =
  | { type: 'move_vertex'; featureId: string; entityId: string; vertexKey: string; to: Point; solvedGeometry?: Record<string, number[]> }
  | { type: 'move_vertex_with_constraint'; featureId: string; entityId: string; vertexKey: string; to: Point; constraintKind: string; snapVertexId?: string; snapEntityRef?: string; solvedGeometry?: Record<string, number[]> }
  | { type: 'move_entity'; featureId: string; entityId: string; delta: Point; solvedGeometry?: Record<string, number[]> }
  | { type: 'add_constraint'; featureId: string; kind: string; targets: string[]; value?: number; pos?: Point; sign?: number }
  | { type: 'set_constraint_value'; featureId: string; constraintId: string; value: number }
  | { type: 'set_constraint_pos'; featureId: string; constraintId: string; pos: Point }
  | { type: 'set_constraint_sign'; featureId: string; constraintId: string; sign: number }
  | { type: 'delete'; targets: string[] }
  | { type: 'add_entity'; featureId: string; kind: string; params: number[]; entityId?: string }
  | { type: 'add_entity_with_constraint'; featureId: string; kind: string; params: number[]; vertexKey: string; snapVertexId?: string; snapEntityRef?: string; constraintKind: string; entityId?: string }
  | { type: 'add_projected_entity'; featureId: string; kind: string; source: string; entityId?: string }
  | { type: 'add_point_at_intersection'; featureId: string; at: Point; curveEntityIds: string[] }
  | { type: 'add_dock'; featureId: string; at: Point; hostConstraintId: string }
  | { type: 'add_rect'; featureId: string; p0: Point; p1: Point }
  | { type: 'add_center_rect'; featureId: string; center: Point; corner: Point }
  | { type: 'add_ngon'; featureId: string; center: Point; corner: Point; sides: number }
  | { type: 'apply_offset'; featureId: string; sourceIds: string[]; distance: number }
  | { type: 'toggle_construction'; targets: string[] }
  | { type: 'set_feature_plane'; featureId: string; plane: string }
  | { type: 'add_sketch'; featureId: string; label?: string; plane?: string }
  | { type: 'delete_feature'; featureId: string }
  | { type: 'set_feature_visibility'; featureId: string; visible: boolean }
  | { type: 'add_plane'; featureId: string; label?: string; definition?: PlaneDef }
  | { type: 'set_plane_definition_field'; featureId: string; field: string; value: string | number }
  | { type: 'rename_feature'; featureId: string; label: string }
  | { type: 'toggle_sketch_plane_visibility' }
  | { type: 'toggle_plane_visibility' }
  | { type: 'add_extrude'; featureId: string; label?: string; sketchQuery: string; distance: number }
  | { type: 'set_extrude_field'; featureId: string; field: keyof ExtrudeFeatureDef; value: unknown }
  | { type: 'add_extrude_profile'; featureId: string; sketchQuery: string }
  | { type: 'remove_extrude_profile'; featureId: string; index: number }
  | { type: 'add_revolve'; featureId: string; label?: string; sketchQuery: string; angle: number }
  | { type: 'set_revolve_field'; featureId: string; field: keyof RevolveFeatureDef; value: unknown }
  | { type: 'add_revolve_profile'; featureId: string; sketchQuery: string }
  | { type: 'remove_revolve_profile'; featureId: string; index: number }
  | { type: 'add_sweep'; featureId: string; label?: string; sketchQuery: string; pathQuery: string }
  | { type: 'set_sweep_field'; featureId: string; field: keyof SweepFeatureDef; value: unknown }
  | { type: 'add_sweep_profile'; featureId: string; sketchQuery: string }
  | { type: 'remove_sweep_profile'; featureId: string; index: number }
  | { type: 'add_sweep_path'; featureId: string; pathQuery: string }
  | { type: 'remove_sweep_path'; featureId: string; index: number }
  | { type: 'add_import_step'; featureId: string; fileId?: string; fileData?: string; label?: string }
  | { type: 'add_fillet'; featureId: string; label?: string }
  | { type: 'add_chamfer'; featureId: string; label?: string }
  | { type: 'set_fillet_field'; featureId: string; field: keyof FilletFeatureDef; value: unknown }
  | { type: 'set_chamfer_field'; featureId: string; field: keyof ChamferFeatureDef; value: unknown }
  | { type: 'add_fillet_edge'; featureId: string; edgeQuery: string }
  | { type: 'remove_fillet_edge'; featureId: string; index: number }
  | { type: 'add_chamfer_edge'; featureId: string; edgeQuery: string }
  | { type: 'remove_chamfer_edge'; featureId: string; index: number }
  | { type: 'add_boolean'; featureId: string; label?: string }
  | { type: 'set_boolean_field'; featureId: string; field: keyof BooleanFeatureDef; value: unknown }
  | { type: 'add_boolean_tool'; featureId: string; tool: string }
  | { type: 'remove_boolean_tool'; featureId: string; tool: string }
  | { type: 'add_array'; featureId: string; label?: string }
  | { type: 'set_array_field'; featureId: string; field: keyof ArrayFeatureDef; value: unknown }
  | { type: 'add_circular_array'; featureId: string; label?: string }
  | { type: 'set_circular_array_field'; featureId: string; field: keyof CircularArrayFeatureDef; value: unknown }
  | { type: 'add_delete_body'; featureId: string; body?: string; label?: string }
  | { type: 'set_delete_body_field'; featureId: string; field: keyof DeleteBodyFeatureDef; value: unknown }
  | { type: 'add_hole'; featureId: string; label?: string }
  | { type: 'set_hole_field'; featureId: string; field: keyof HoleFeatureDef; value: unknown }
  | { type: 'add_transform'; featureId: string; label?: string }
  | { type: 'set_transform_field'; featureId: string; field: keyof TransformFeatureDef; value: unknown }
  | { type: 'rename_part'; bodyId: string; name: string }
  | { type: 'set_part_color'; bodyId: string; color: string }
  | { type: 'set_part_transparency'; bodyId: string; transparency: number }
  | { type: 'set_part_metalness'; bodyId: string; metalness: number }
  | { type: 'set_part_roughness'; bodyId: string; roughness: number }
  | { type: 'set_part_transmission'; bodyId: string; transmission: number }
  | { type: 'mirror_entities'; featureId: string; entityIds: string[]; mirrorLineId: string }
  | { type: 'add_mirror'; featureId: string; label?: string }
  | { type: 'set_mirror_field'; featureId: string; field: keyof MirrorFeatureDef; value: unknown }
  | { type: 'add_variable'; featureId: string; label?: string }
  | { type: 'set_variable_field'; featureId: string; field: keyof VariableFeatureDef; value: unknown }
  | { type: 'reorder_features'; featureId: string; toIndex: number }
  | { type: 'set_body_visibility'; bodyId: string; visible: boolean }
  | { type: 'reorder_pick_field'; featureId: string; field: string; fromIndex: number; toIndex: number }
  | { type: 'set_feature_suppression'; featureId: string; suppressed: boolean }
  | { type: 'set_rollback'; position: number | null }
  | { type: 'edit_session'; featureId: string; description?: string }
