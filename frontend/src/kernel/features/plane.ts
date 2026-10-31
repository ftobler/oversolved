// The datum-plane leaf. Eight modes build a 3D frame (offset, three_point, plane_point,
// line_angle, on_face, on_face_edge_angle, edge_point, origin_rotation), an optional
// in-plane rotation is applied, and the resulting frame is registered under the feature id
// so downstream sketches resolve their plane through it (mirrors the bare-id register Python
// did in `_solve_plane`).
// The result carries `plane`; the frontend derives the plane_transform from it
// (useSolver.applySolveResult).

import type { Repository } from '../query'
import { getPoint3d } from '../query'
import { BUILTIN_PLANES } from '../solverConstants'
import type { Body, Frame3D } from '../types3d'
import { normalToFrame } from '../types3d'
import type { PlaneLike } from './shared/planes'
import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'
import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import { resolveFaceSlashFrame } from './faceProfile'

type Dict = Record<string, unknown>

interface PlaneResult {
  [key: string]: unknown
  status: string
  plane: Frame3D
}

// ─── Vector helpers ───

function norm(v: number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

function normalize(v: number[]): Vec3 {
  const n = norm(v)
  if (n < 1e-12) throw new Error('Cannot normalize zero-length vector')
  return [v[0] / n, v[1] / n, v[2] / n]
}

/** Rotate (x, y) about `normal` by `degrees` (mirrors `_rotate_frame_around_normal`). */
function rotateFrameAroundNormal(
  xAxis: number[],
  yAxis: number[],
  degrees: number,
): [Vec3, Vec3] {
  const radians = (degrees * Math.PI) / 180
  const cosA = Math.cos(radians)
  const sinA = Math.sin(radians)
  const xNew = add(scale(xAxis, cosA), scale(yAxis, sinA))
  const yNew = add(scale(xAxis, -sinA), scale(yAxis, cosA))
  return [xNew, yNew]
}

function frame(origin: number[], xAxis: number[], yAxis: number[], normal: number[]): Frame3D {
  return {
    origin: [origin[0], origin[1], origin[2]],
    x_axis: [xAxis[0], xAxis[1], xAxis[2]],
    y_axis: [yAxis[0], yAxis[1], yAxis[2]],
    normal: [normal[0], normal[1], normal[2]],
  }
}

/** Query-result -> [start, end] (mirrors `_get_edge_3d`). */
function getEdge3d(ref: Dict, globalRepo: Repository): [Vec3, Vec3] {
  if ('external_params' in ref && ref.kind === 'line') {
    const p = ref.external_params as number[]
    const sketchId = ref.sketch_id as string | undefined
    if (sketchId) {
      const pt = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
      if (pt) {
        const lift = (a: number, b: number): Vec3 => [
          pt.origin[0] + a * pt.x_axis[0] + b * pt.y_axis[0],
          pt.origin[1] + a * pt.x_axis[1] + b * pt.y_axis[1],
          pt.origin[2] + a * pt.x_axis[2] + b * pt.y_axis[2],
        ]
        return [lift(p[0], p[1]), lift(p[2], p[3])]
      }
    }
    return [[p[0], p[1], 0.0], [p[2], p[3], 0.0]]
  }
  if ('start' in ref && 'end' in ref) {
    return [ref.start as Vec3, ref.end as Vec3]
  }
  throw new Error('edge reference has no line coordinates')
}

function planeAxes(plane: Dict): { normal: Vec3; origin: Vec3; xAxis: Vec3; yAxis: Vec3 } {
  return {
    normal: (plane.normal as Vec3) ?? [0, 0, 1],
    origin: (plane.origin as Vec3) ?? [0, 0, 0],
    xAxis: (plane.x_axis as Vec3) ?? [1, 0, 0],
    yAxis: (plane.y_axis as Vec3) ?? [0, 1, 0],
  }
}

// ─── Mode functions ───

function planeThreePoint(def: Dict, repo: Repository): Frame3D {
  const r1 = repo.query(def.p1 as string) as Dict | null
  const r2 = repo.query(def.p2 as string) as Dict | null
  const r3 = repo.query(def.p3 as string) as Dict | null
  if (r1 === null) throw new Error(`point not found: ${JSON.stringify(def.p1)}`)
  if (r2 === null) throw new Error(`point not found: ${JSON.stringify(def.p2)}`)
  if (r3 === null) throw new Error(`point not found: ${JSON.stringify(def.p3)}`)
  const p1 = getPoint3d(r1, repo)
  const p2 = getPoint3d(r2, repo)
  const p3 = getPoint3d(r3, repo)

  const origin = p1
  const xAxis = normalize(sub(p2, origin))
  const v = sub(p3, origin)
  const yAxisRaw = sub(v, scale(xAxis, dot(v, xAxis)))
  if (norm(yAxisRaw) < 1e-10) throw new Error('collinear points: cannot define a plane')
  const yAxis = normalize(yAxisRaw)
  const normal = cross(xAxis, yAxis)
  return frame(origin, xAxis, yAxis, normal)
}

// A topo-fallback face ref (`@<body>/face/<idx>`) the render layer mints when
// the kernel produced no named query for the face (selectionId.ts
// topoFallbackQuery). Faces register under ancestry keys, never under the
// slash key, so repo.query misses it and the frame must come from the shape.
const SLASH_FACE = /^@([^/]+)\/face\/(\d+)$/

interface ResolvedFace {
  centroid: Vec3
  normal: Vec3
  // The face's own OCC frame when resolved from a body shape (the slash form);
  // absent for repo face entries, which only carry centroid + normal.
  frame?: Frame3D
}

// Resolve a face ref to its centroid + normal. The `@<body>/face/<idx>` form
// goes through the body's OCC shape (the same path the extrude-on-face profile
// uses); every other form is a repo face entry carrying centroid + normal.
function resolveFaceFrame(
  ref: string,
  repo: Repository,
  bodyStore: Dict | null,
  oc: OccModule | null,
  scope: DisposeScope | null,
  table: HandleTable | null,
): ResolvedFace {
  if (SLASH_FACE.test(ref)) {
    if (!oc || !scope || !table) {
      throw new Error(`face not found: ${JSON.stringify(ref)}`)
    }
    const frame3d = resolveFaceSlashFrame(oc, scope, table, ref, repo, bodyStore as Record<string, Body>)
    return { centroid: frame3d.origin, normal: frame3d.normal, frame: frame3d }
  }
  const face = repo.query(ref, null, bodyStore) as Dict | null
  if (face === null) throw new Error(`face not found: ${JSON.stringify(ref)}`)
  return { centroid: face.centroid as Vec3, normal: face.normal as Vec3 }
}

function planeOnFace(
  def: Dict,
  repo: Repository,
  bodyStore: Dict | null,
  oc: OccModule | null,
  scope: DisposeScope | null,
  table: HandleTable | null,
): Frame3D {
  const resolved = resolveFaceFrame(def.face as string, repo, bodyStore, oc, scope, table)
  if (resolved.frame) return resolved.frame
  const { x_axis, y_axis } = normalToFrame(resolved.normal)
  return frame(resolved.centroid, x_axis, y_axis, resolved.normal)
}

function planeOnFaceEdgeAngle(
  def: Dict,
  repo: Repository,
  bodyStore: Dict | null,
  oc: OccModule | null,
  scope: DisposeScope | null,
  table: HandleTable | null,
): Frame3D {
  const edgeStr = def.edge as string
  const angle = Number(def.angle ?? 0.0)

  const { centroid: origin, normal } = resolveFaceFrame(def.face as string, repo, bodyStore, oc, scope, table)
  const edge = repo.query(edgeStr, null, bodyStore) as Dict | null
  if (edge === null) throw new Error(`edge not found: ${JSON.stringify(edgeStr)}`)

  const edgeDir = normalize(sub(edge.end as Vec3, edge.start as Vec3))
  const xAxisRaw = sub(edgeDir, scale(normal, dot(edgeDir, normal)))
  let xAxisBase: Vec3
  if (norm(xAxisRaw) < 1e-12) {
    // edge_dir is parallel to normal -- pick an arbitrary perpendicular direction
    const arbitrary: Vec3 = Math.abs(normal[2]) < 0.9 ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0]
    xAxisBase = normalize(cross(normal, arbitrary))
  } else {
    xAxisBase = normalize(xAxisRaw)
  }

  const [xAxis] = rotateFrameAroundNormal(xAxisBase, cross(normal, xAxisBase), angle)
  const yAxis = cross(normal, xAxis)
  return frame(origin, xAxis, yAxis, normal)
}

function planeEdgePoint(def: Dict, repo: Repository, bodyStore: Dict | null): Frame3D {
  const edgeStr = def.edge as string
  const pointStr = def.point as string

  const edge = repo.query(edgeStr, null, bodyStore) as Dict | null
  if (edge === null) throw new Error(`edge not found: ${JSON.stringify(edgeStr)}`)
  const pointRef = repo.query(pointStr, null, bodyStore) as Dict | null
  if (pointRef === null) throw new Error(`point not found: ${JSON.stringify(pointStr)}`)

  const [edgeStart, edgeEnd] = getEdge3d(edge, repo)
  const xAxis = normalize(sub(edgeEnd, edgeStart))
  const origin = getPoint3d(pointRef, repo) as Vec3
  const point3d = origin

  const t = dot(sub(point3d, edgeStart), xAxis)
  const projectedPoint = add(edgeStart, scale(xAxis, t))

  const pointToProjection = sub(projectedPoint, point3d)
  let yAxis: Vec3
  if (norm(pointToProjection) > 1e-10) {
    yAxis = normalize(pointToProjection)
  } else {
    const arbitrary: Vec3 = Math.abs(xAxis[2]) < 0.9 ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0]
    yAxis = normalize(cross(xAxis, arbitrary))
  }

  const normal = cross(xAxis, yAxis)
  return frame(origin, xAxis, yAxis, normal)
}

function planeThroughPoint(def: Dict, repo: Repository): Frame3D {
  const planeQuery = (def.plane as string) ?? ''
  const pointQuery = (def.point as string) ?? ''
  const refPlane = repo.query(planeQuery) as Dict | null
  if (refPlane === null) throw new Error(`plane not found: ${JSON.stringify(planeQuery)}`)
  const pointRef = repo.query(pointQuery) as Dict | null
  if (pointRef === null) throw new Error(`point not found: ${JSON.stringify(pointQuery)}`)

  const { normal, xAxis, yAxis, origin: refOrigin } = planeAxes(refPlane)
  const point3d = getPoint3d(pointRef, repo)

  const t = dot(sub(point3d, refOrigin), normal)
  const origin = add(refOrigin, scale(normal, t))
  return frame(origin, xAxis, yAxis, normal)
}

function planeLineAngle(def: Dict, repo: Repository): Frame3D {
  const lineStr = (def.line as string) ?? ''
  const angle = Number(def.angle ?? 0.0)

  const lineRef = repo.query(lineStr) as Dict | null
  if (lineRef === null) throw new Error(`line not found: ${JSON.stringify(lineStr)}`)

  const [lineStart, lineEnd] = getEdge3d(lineRef, repo)
  const xAxis = normalize(sub(lineEnd, lineStart))
  const origin = lineStart

  const ref: Vec3 = Math.abs(xAxis[2]) < 0.9 ? [0.0, 0.0, 1.0] : [1.0, 0.0, 0.0]
  const yAxisDefault = normalize(sub(ref, scale(xAxis, dot(ref, xAxis))))

  const radians = (angle * Math.PI) / 180
  const zAxisDefault = cross(xAxis, yAxisDefault)
  const yAxis = add(scale(yAxisDefault, Math.cos(radians)), scale(zAxisDefault, Math.sin(radians)))
  const normal = cross(xAxis, yAxis)
  return frame(origin, xAxis, yAxis, normal)
}

function planeOffset(def: Dict, repo: Repository): Frame3D {
  const planeVal = def.plane
  const planeQuery = typeof planeVal === 'string' ? planeVal : ((def.reference as string) ?? '')
  const rawOffset = def.offset ?? def.distance
  const offset = Number(rawOffset ?? 0.0)
  const plane = repo.query(planeQuery) as Dict | null
  if (plane === null) throw new Error(`plane not found: ${JSON.stringify(planeQuery)}`)

  const { normal, xAxis, yAxis, origin: refOrigin } = planeAxes(plane)
  const origin = add(refOrigin, scale(normal, offset))
  return frame(origin, xAxis, yAxis, normal)
}

// The three world axes, addressable as one letter on the wire. The letter is the
// common code-CAD `rotate=(60,0,0)` case, and it is a scalar the field setter can
// carry; a stored vector covers an axis no letter names. The accepted letters are
// exactly the wire schema's enum: one spelling path, no silent case folding.
const WORLD_AXIS_BY_LETTER: Record<string, Vec3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

function rotationAxisOf(def: Dict): Vec3 {
  const raw = def.rotation_axis
  if (typeof raw === 'string') {
    const axis = WORLD_AXIS_BY_LETTER[raw]
    if (axis !== undefined) return axis
    throw new Error('rotation_axis must be "x", "y" or "z" or three finite numbers')
  }
  if (Array.isArray(raw) && raw.length === 3 && raw.every(n => typeof n === 'number' && Number.isFinite(n))) {
    try {
      // A zero-length vector is not a direction: `normalize` refuses it, and the
      // refusal has to name the field the caller must fix.
      return normalize(raw)
    } catch {
      throw new Error('rotation_axis must be a non-zero direction')
    }
  }
  throw new Error('rotation_axis must be "x", "y" or "z" or three finite numbers')
}

/** Rodrigues rotation of `v` about a unit axis by `degrees` (right-hand rule):
 *  about world +X, +Y swings toward +Z, so a 60 degree tilt of the XY frame tips
 *  its normal to [0, -sin60, cos60], the same reading cadquery's rotate=(60,0,0)
 *  gives a workplane. */
function rotateAbout(v: Vec3, axis: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180
  const cosA = Math.cos(radians)
  const sinA = Math.sin(radians)
  const perp = cross(axis, v)
  const along = dot(axis, v)
  return [
    v[0] * cosA + perp[0] * sinA + axis[0] * along * (1 - cosA),
    v[1] * cosA + perp[1] * sinA + axis[1] * along * (1 - cosA),
    v[2] * cosA + perp[2] * sinA + axis[2] * along * (1 - cosA),
  ]
}

/** The mode's origin: a stored world point, or a ref the query engine resolves
 *  (a `select` kind "vertex" query is the corner-pick spelling). */
function originPointOf(def: Dict, repo: Repository): Vec3 {
  const raw = def.origin
  if (raw === undefined) {
    throw new Error('origin_rotation needs an origin: a point ref or three coordinates')
  }
  if (typeof raw === 'string') {
    const resolved = repo.query(raw) as Dict | null
    if (resolved === null) throw new Error(`origin not found: ${JSON.stringify(raw)}`)
    return getPoint3d(resolved, repo) as Vec3
  }
  if (Array.isArray(raw) && raw.length === 3 && raw.every(n => typeof n === 'number' && Number.isFinite(n))) {
    return [raw[0], raw[1], raw[2]] as Vec3
  }
  throw new Error('origin must be three finite numbers or a point ref')
}

/** The origin-plus-rotation mode: the parent frame's axes (the world XY frame
 *  when no parent is named) swung about one axis, then moved to the origin. The
 *  origin is the authored point itself, not a projection onto the parent plane
 *  the way `plane_point` places it. */
function planeOriginRotation(def: Dict, repo: Repository): Frame3D {
  const origin = originPointOf(def, repo)
  const parentQuery = def.plane
  let parent: Dict | null
  if (parentQuery === undefined) {
    parent = BUILTIN_PLANES.builtin_plane_front
  } else {
    // An empty parent is refused the way the other modes refuse it: the caller
    // must either name a plane or leave the field out to get world XY.
    if (typeof parentQuery !== 'string') throw new Error('plane must be a ref string')
    parent = repo.query(parentQuery) as Dict | null
    if (parent === null) throw new Error(`plane not found: ${JSON.stringify(parentQuery)}`)
  }
  const { normal, xAxis, yAxis } = planeAxes(parent)

  const hasAxis = def.rotation_axis !== undefined
  const hasAngle = def.rotation_angle !== undefined
  // Half a rotation is not a rotation: an axis with no angle (or the reverse)
  // is the mistake to name, not a silent zero turn.
  if (hasAngle && !hasAxis) throw new Error('rotation_angle needs rotation_axis: "x", "y" or "z" or three finite numbers')
  if (hasAxis && !hasAngle) throw new Error('rotation_axis needs rotation_angle in degrees')
  if (!hasAngle) return frame(origin, xAxis, yAxis, normal)

  const angle = Number(def.rotation_angle)
  if (!Number.isFinite(angle)) throw new Error(`rotation_angle must be a finite number of degrees, got ${JSON.stringify(def.rotation_angle)}`)
  const axis = rotationAxisOf(def)
  const x = rotateAbout(xAxis, axis, angle)
  const y = rotateAbout(yAxis, axis, angle)
  // The turn is rebuilt from x and y rather than trusted from the rotated parent
  // normal, so a f64 drift cannot tilt the frame out of its own plane.
  return frame(origin, x, y, cross(x, y))
}

// ─── Dispatch ───

/** Solve a plane feature (mirrors `_solve_plane`). The OCC context is only
 *  needed by the on_face modes when the face ref is a topo-fallback
 *  `@<body>/face/<idx>`; the pure modes ignore it, so tests pass null. */
export function solvePlane(
  oc: OccModule | null,
  scope: DisposeScope | null,
  table: HandleTable | null,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
): PlaneResult {
  const definition = (feature.definition as Dict) ?? {}
  const mode = definition.mode as string

  let f: Frame3D
  switch (mode) {
    case 'three_point': f = planeThreePoint(definition, globalRepo); break
    case 'plane_point': f = planeThroughPoint(definition, globalRepo); break
    case 'line_angle': f = planeLineAngle(definition, globalRepo); break
    case 'on_face': f = planeOnFace(definition, globalRepo, bodyStore, oc, scope, table); break
    case 'on_face_edge_angle': f = planeOnFaceEdgeAngle(definition, globalRepo, bodyStore, oc, scope, table); break
    case 'edge_point': f = planeEdgePoint(definition, globalRepo, bodyStore); break
    case 'offset': f = planeOffset(definition, globalRepo); break
    case 'origin_rotation': f = planeOriginRotation(definition, globalRepo); break
    default: throw new Error(`unknown plane mode: ${JSON.stringify(mode)}`)
  }

  const rotation = Number(definition.rotation ?? 0.0)
  if (rotation !== 0.0) {
    const [xNew, yNew] = rotateFrameAroundNormal(f.x_axis, f.y_axis, rotation)
    f = frame(f.origin, xNew, yNew, f.normal)
  }

  const planeId = feature.id as string
  // Register the frame under the bare plane id so downstream sketches resolve it
  // (resolveSketchPlane checks `_pt_<id>` then `<id>`), mirroring Python's
  // `global_repo.register(plane_id, frame_dict)`.
  globalRepo.register(planeId, { ...f, type: 'plane' })

  return { status: 'ok', plane: f }
}
