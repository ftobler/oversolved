// ── Base Types ────

export type Point = [number, number]

export type ActiveTool = 'select' | 'dimension' | 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'point' | 'project' | 'drag' | 'mirror' | null

// Which geometric space the current selection lives in.
export type SelectionDomain = 'sketch_2d' | 'body_3d' | 'plane_3d' | 'mixed'

export type ExtrudeDirection = 'normal' | 'reverse' | 'symmetric'
export type ExtrudeOperation = 'add' | 'cut' | 'new'

export interface ExtrudeFeatureDef {
  sketch: string | string[]
  distance: number
  direction?: ExtrudeDirection
  operation?: ExtrudeOperation
  merge_target?: string
}

export interface FilletFeatureDef {
  edges: string[]
  radius: number
}

export interface ChamferFeatureDef {
  edges: string[]
  distance: number
  kind?: 'distance' | 'angle_distance'
  angle?: number
}

export interface BooleanFeatureDef {
  operation: 'union' | 'subtract' | 'intersect'
  target: string
  tools: string[]
  keep_tools?: boolean
}

export interface ArrayFeatureDef {
  source_body?: string
  mode?: 'linear' | 'rectangular' | 'rotational'
  operation?: 'add' | 'new'
  include_source?: boolean
  count_x?: number
  pitch_x?: number
  direction_x?: [number, number, number]
  direction_x_query?: string
  count_y?: number
  pitch_y?: number
  direction_y?: [number, number, number]
  direction_y_query?: string
  count?: number
  step_angle?: number | null
  axis?: string
  axis_origin?: [number, number, number]
  axis_direction?: [number, number, number]
}

export type RevolveDirection = 'normal' | 'reverse' | 'symmetric'

export interface RevolveFeatureDef {
  sketch: string | string[]
  angle: number
  direction?: RevolveDirection
  axis?: string
  axis_origin?: [number, number, number]
  axis_direction?: [number, number, number]
  operation?: 'add' | 'cut' | 'new'
  merge_target?: string
}

export interface DeleteBodyFeatureDef {
  body: string
}

export interface HoleFeatureDef {
  sketch: string
  diameter: number
  depth_mode: 'blind' | 'through_all'
  depth: number
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
  rotation_angle?: number
  rotation_axis_origin?: [number, number, number]
  rotation_axis_direction?: [number, number, number]
  rotation_axis?: string
  scale?: number
  scale_center?: [number, number, number]
  scale_center_from?: string
}

export interface FaceData {
  centroid: [number, number, number]
  normal: [number, number, number]
  area?: number
}

export interface Mesh3D {
  vertices: Float32Array | [number, number, number][]
  faces:    Uint32Array | [number, number, number][]
  normals:  [number, number, number][]
  face_data?: FaceData[]
  triangle_to_face?: number[]
  face_queries?: string[]
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

export type EdgeData = EdgeDataLine | EdgeDataCircleArc | EdgeDataSpline

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

export interface BuildResponse {
  solve_ms: number
  result: Record<string, unknown>
  bodies: Record<string, BodyResult>
  pick_bodies?: Record<string, BodyResult>
  _build_state?: unknown
}

export interface BodyFeatureResult {
  status: 'ok' | 'exception'
  body_id?: string
  body_ids?: string[]
  exception?: string
  mesh_warning?: string
  solve_ms?: number
}

export function isBodyFeatureResult(r: unknown): r is BodyFeatureResult {
  return typeof r === 'object' && r !== null && ('body_id' in r || 'body_ids' in r)
}

// Lightweight marker that a sidebar pick chip is waiting for a viewport selection.
// Viewport clicks go through normalSelection first, then commitFieldPick() reads from it.
export interface PendingPickField {
  featureId: string
  field: string
  hostKind?: string
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
  offset?: number
  p1?: string
  p2?: string
  p3?: string
  point?: string
  line?: string
  edge?: string
  face?: string
  angle?: number
  rotation?: number
}

export interface PartFeature {
  id: string
  kind: string
  label?: string
  visible?: boolean  // absent means visible; false means hidden
  plane?: string  // query string, e.g. "@builtin_plane_front"
  entities?: PartEntityDef[]
  initial?: Record<string, number[]>
  constraints?: PartConstraint[]
  definition?: PlaneDef
  extrude?: ExtrudeFeatureDef  // present when kind === 'extrude'
  revolve?: RevolveFeatureDef  // present when kind === 'revolve'
  fillet?: FilletFeatureDef  // present when kind === 'fillet'
  chamfer?: ChamferFeatureDef  // present when kind === 'chamfer'
  boolean?: BooleanFeatureDef  // present when kind === 'boolean'
  array?: ArrayFeatureDef  // present when kind === 'array'
  delete_body?: DeleteBodyFeatureDef  // present when kind === 'delete_body'
  hole?: HoleFeatureDef  // present when kind === 'hole'
  transform?: TransformFeatureDef  // present when kind === 'transform'
  mirror?: MirrorFeatureDef  // present when kind === 'mirror'
  file_id?: string  // present when kind === 'import_step'
}

export type Feature = PartFeature

export interface PartStyleEntry {
  name?: string
  color?: string
  transparency?: number  // 0-1 (0 = opaque, 1 = fully transparent)
  metalness?: number     // 0-1 (0 = non-metallic, 1 = fully metallic)
  created_by?: string
}

export interface PartDoc {
  oversolved?: number
  version?: number
  kind?: string
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

export type ProjectedEntity =
  | ProjectedLineSegment
  | ProjectedCircle
  | ProjectedArc
  | ProjectedPointEntity

export type Entity = LineSegment | Circle | Arc | PointEntity | ProjectedEntity

export function isProjectedEntity(e: Entity): e is ProjectedEntity {
  return 'projected' in e && (e as ProjectedEntity).projected === true
}

export function isProjectedLine(e: Entity): e is ProjectedLineSegment {
  return isProjectedEntity(e) && 'start' in e && !('radius' in e)
}

export function isProjectedCircle(e: Entity): e is ProjectedCircle {
  return isProjectedEntity(e) && 'center' in e && !('angle_start' in e)
}

export function isProjectedArc(e: Entity): e is ProjectedArc {
  return isProjectedEntity(e) && 'angle_start' in e
}

export function isProjectedPoint(e: Entity): e is ProjectedPointEntity {
  return isProjectedEntity(e) && 'x' in e
}

export type EntityKind = 'line' | 'arc' | 'circle' | 'point'

export function getEntityKind(entity: Entity): EntityKind {
  if ('start' in entity && 'end' in entity && 'radius' in entity) return 'arc'
  if ('start' in entity && 'end' in entity) return 'line'
  if ('center' in entity && 'radius' in entity) return 'circle'
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
  entity?: string
  // Label offset in sketch space relative to midpoint(p1, p2).
  pos?: Point
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

export type TopologyEdge = TopologyLineEdge | TopologyArcEdge

export interface TopologySurface {
  boundary: TopologyEdge[]
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

export interface SketchData {
  solved: Sketch
  constraints?: Constraints
  topology?: Topology
  status?: string
  features?: EntityStatus
  plane_transform?: PlaneTransform
  plane?: { origin: [number, number, number]; x_axis: [number, number, number]; y_axis: [number, number, number]; normal: [number, number, number] }
  body_id?: string
  exception?: string
}

export type EntityStatus = Record<string, ConstraintStatus>

// ── Mutation Types ────

export type Mutation =
  | { type: 'move_vertex'; featureId: string; entityId: string; vertexKey: string; to: Point }
  | { type: 'move_vertex_with_constraint'; featureId: string; entityId: string; vertexKey: string; to: Point; constraintKind: string; snapVertexId?: string; snapEntityRef?: string }
  | { type: 'move_entity'; featureId: string; entityId: string; delta: Point }
  | { type: 'add_constraint'; featureId: string; kind: string; targets: string[]; value?: number }
  | { type: 'set_constraint_value'; featureId: string; constraintId: string; value: number }
  | { type: 'set_constraint_pos'; featureId: string; constraintId: string; pos: Point }
  | { type: 'delete'; targets: string[] }
  | { type: 'add_entity'; featureId: string; kind: string; params: number[]; entityId?: string }
  | { type: 'add_entity_with_constraint'; featureId: string; kind: string; params: number[]; vertexKey: string; snapVertexId?: string; snapEntityRef?: string; constraintKind: string; entityId?: string }
  | { type: 'add_projected_entity'; featureId: string; kind: string; source: string }
  | { type: 'add_rect'; featureId: string; p0: Point; p1: Point }
  | { type: 'add_center_rect'; featureId: string; center: Point; corner: Point }
  | { type: 'toggle_construction'; targets: string[] }
  | { type: 'set_feature_plane'; featureId: string; plane: string }
  | { type: 'add_sketch'; featureId: string; label?: string }
  | { type: 'delete_feature'; featureId: string }
  | { type: 'set_feature_visibility'; featureId: string; visible: boolean }
  | { type: 'add_plane'; featureId: string; label?: string; definition?: PlaneDef }
  | { type: 'set_plane_definition_field'; featureId: string; field: string; value: string | number }
  | { type: 'rename_feature'; featureId: string; label: string }
  | { type: 'toggle_sketch_plane_visibility' }
  | { type: 'toggle_plane_visibility' }
  | { type: 'add_extrude'; featureId: string; label?: string; sketchQuery: string; distance: number }
  | { type: 'set_extrude_distance'; featureId: string; distance: number }
  | { type: 'set_extrude_direction'; featureId: string; direction: ExtrudeDirection }
  | { type: 'set_extrude_operation'; featureId: string; operation: ExtrudeOperation }
  | { type: 'set_extrude_merge_target'; featureId: string; mergeTarget?: string }
  | { type: 'add_extrude_profile'; featureId: string; sketchQuery: string }
  | { type: 'remove_extrude_profile'; featureId: string; index: number }
  | { type: 'add_revolve'; featureId: string; label?: string; sketchQuery: string; angle: number }
  | { type: 'set_revolve_angle'; featureId: string; angle: number }
  | { type: 'set_revolve_direction'; featureId: string; direction: RevolveDirection }
  | { type: 'set_revolve_axis'; featureId: string; axis: string }
  | { type: 'set_revolve_operation'; featureId: string; operation: 'add' | 'cut' | 'new' }
  | { type: 'set_revolve_merge_target'; featureId: string; mergeTarget?: string }
  | { type: 'add_revolve_profile'; featureId: string; sketchQuery: string }
  | { type: 'remove_revolve_profile'; featureId: string; index: number }
  | { type: 'add_import_step'; featureId: string; fileId: string; label?: string }
  | { type: 'add_fillet'; featureId: string; label?: string }
  | { type: 'add_chamfer'; featureId: string; label?: string }
  | { type: 'set_fillet_radius'; featureId: string; radius: number }
  | { type: 'set_chamfer_distance'; featureId: string; distance: number }
  | { type: 'set_chamfer_angle'; featureId: string; angle: number }
  | { type: 'set_chamfer_kind'; featureId: string; kind: 'distance' | 'angle_distance' }
  | { type: 'add_fillet_edge'; featureId: string; edgeQuery: string }
  | { type: 'remove_fillet_edge'; featureId: string; index: number }
  | { type: 'add_chamfer_edge'; featureId: string; edgeQuery: string }
  | { type: 'remove_chamfer_edge'; featureId: string; index: number }
  | { type: 'add_boolean'; featureId: string; label?: string }
  | { type: 'set_boolean_operation'; featureId: string; operation: BooleanFeatureDef['operation'] }
  | { type: 'set_boolean_target'; featureId: string; target: string }
  | { type: 'add_boolean_tool'; featureId: string; tool: string }
  | { type: 'remove_boolean_tool'; featureId: string; tool: string }
  | { type: 'set_boolean_keep_tools'; featureId: string; keepTools: boolean }
  | { type: 'add_array'; featureId: string; label?: string }
  | { type: 'set_array_mode'; featureId: string; mode: 'linear' | 'rectangular' | 'rotational' }
  | { type: 'set_array_source_body'; featureId: string; sourceBody: string }
  | { type: 'set_array_operation'; featureId: string; operation: 'add' | 'new' }
  | { type: 'set_array_include_source'; featureId: string; includeSource: boolean }
  | { type: 'set_array_count_x'; featureId: string; count: number }
  | { type: 'set_array_pitch_x'; featureId: string; pitch: number }
  | { type: 'set_array_direction_x_query'; featureId: string; query: string }
  | { type: 'set_array_count_y'; featureId: string; count: number }
  | { type: 'set_array_pitch_y'; featureId: string; pitch: number }
  | { type: 'set_array_direction_y_query'; featureId: string; query: string }
  | { type: 'set_array_count'; featureId: string; count: number }
  | { type: 'set_array_step_angle'; featureId: string; stepAngle: number | null }
  | { type: 'set_array_axis'; featureId: string; axis: string }
  | { type: 'set_array_direction_x'; featureId: string; direction_x: [number, number, number] }
  | { type: 'set_array_direction_y'; featureId: string; direction_y: [number, number, number] }
  | { type: 'add_delete_body'; featureId: string; body?: string; label?: string }
  | { type: 'set_delete_body_target'; featureId: string; body: string }
  | { type: 'add_hole'; featureId: string; label?: string }
  | { type: 'set_hole_sketch'; featureId: string; sketch: string }
  | { type: 'set_hole_diameter'; featureId: string; diameter: number }
  | { type: 'set_hole_depth'; featureId: string; depth: number }
  | { type: 'set_hole_depth_mode'; featureId: string; depthMode: HoleFeatureDef['depth_mode'] }
  | { type: 'set_hole_direction'; featureId: string; direction: HoleFeatureDef['direction'] }
  | { type: 'set_hole_target'; featureId: string; target: string }
  | { type: 'add_transform'; featureId: string; label?: string }
  | { type: 'set_transform_field'; featureId: string; field: keyof TransformFeatureDef; value: unknown }
  | { type: 'rename_part'; bodyId: string; name: string }
  | { type: 'set_part_color'; bodyId: string; color: string }
  | { type: 'set_part_transparency'; bodyId: string; transparency: number }
  | { type: 'set_part_metalness'; bodyId: string; metalness: number }
  | { type: 'mirror_entities'; featureId: string; entityIds: string[]; mirrorLineId: string }
  | { type: 'add_mirror'; featureId: string; label?: string }
  | { type: 'set_mirror_field'; featureId: string; field: keyof MirrorFeatureDef; value: unknown }
  | { type: 'reorder_features'; featureId: string; toIndex: number }
  | { type: 'reorder_pick_field'; featureId: string; field: string; fromIndex: number; toIndex: number }
