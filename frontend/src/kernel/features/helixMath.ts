// Pure helix math: no OCC, no repo. Both the OCC adapter (occ/helixEdge.ts)
// and the viewport sampler drive this module, so the edge the kernel builds and
// the line the user sees cannot drift. A helix lies on a cylinder: the reference
// supplies the axis a0, a zero direction x0 and a radius; the climb axis a is
// a0 (normal) or -a0 (reverse).
//
// Four controls are independent, and the unit tests sweep all their
// combinations:
//   - start_angle rotates the start point about a0 (read in the x0 frame);
//   - offset slides the start along the climb direction a;
//   - hand fixes the chirality of the curve about a0 (right stays right when
//     the climb direction flips);
//   - direction picks which end of the reference the helix starts at and which
//     way it climbs.
//
// The in-frame angle the OCC cylinder surface sees is mirrored under reverse
// (its Z is a = -a0), which startUV owns so the built edge lands on the same
// world points the sampler produces.

import { normalToFrame } from '../types3d'
import type { HelixDirection, HelixFeatureDef, HelixHand } from '@/types/cad'

export type Vec3 = [number, number, number]

const TWO_PI = 2 * Math.PI
const DEG = Math.PI / 180

/** The reference a helix is laid on, already resolved from the repo (and, for a
 *  cylinder face, from its OCC surface for the radius and axial extent). */
export interface HelixReference {
  kind: 'cylinderface' | 'circular_edge' | 'sketch_circle' | 'straight_edge' | 'sketch_line'
  // Reference axis a0, unit, as the reference reports it.
  axis: Vec3
  // A point on the axis at the low end along a0 (a face/straight edge), or the
  // circle/line plane (a circle) / the line start (a straight reference).
  origin: Vec3
  // Derived radius (absent for a straight reference).
  radius?: number
  // The zero direction the start angle is read from. A circle supplies its own
  // x_axis (what the user sees in the sketch); otherwise normalToFrame(a0).
  xAxis?: Vec3
  // Axial extent along a0 for a face or straight reference; absent for a circle.
  extent?: number
}

/** The two given quantities, per [[HelixMode]]. */
export type HelixMode = 'pitch_turns' | 'pitch_height' | 'turns_height' | 'angle_turns' | 'angle_height'

export interface HelixParams {
  radius: number
  pitch: number
  turns: number
  height: number
  helix_angle: number
  length: number
}

/** The fully resolved curve: what helixPoint/samples/tangent and the OCC
 *  builder consume. `origin` already folds in the offset, so the start point is
 *  origin + radius * radial(startAngle). */
export interface HelixDescriptor {
  origin: Vec3
  // Climb direction a (a0 for normal, -a0 for reverse).
  axis: Vec3
  // Reference axis a0, the axis the curve turns about and chirality is read on.
  refAxis: Vec3
  // Zero direction x0 (unit, perpendicular to a0).
  xAxis: Vec3
  radius: number
  pitch: number
  turns: number
  startAngleDeg: number
  hand: HelixHand
}

function norm(v: number[]): number {
  return Math.hypot(v[0], v[1], v[2])
}

function normalize(v: number[]): Vec3 {
  const n = norm(v)
  if (n < 1e-12) throw new Error('helix: cannot normalize a zero-length axis')
  return [v[0] / n, v[1] / n, v[2] / n]
}

function cross(a: number[], b: number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function dot(a: number[], b: number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function requirePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`helix: ${field} must be positive, got ${value}`)
  }
  return value
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Resolve the two given quantities plus the radius into a full parameter set
 * (mirrors the Helix mode table). Throws a named error for each malformed
 * value, because a hand-written document reaches the solver directly.
 */
export function resolveHelixParams(def: HelixFeatureDef, ref: HelixReference): HelixParams {
  const mode: HelixMode = def.mode ?? 'pitch_turns'
  const radiusMode = def.radius_mode ?? 'derived'

  let radius: number
  if (radiusMode === 'entered') {
    radius = requirePositive(num(def.radius, NaN), 'radius')
  } else {
    if (ref.radius === undefined) {
      throw new Error('helix: a straight-edge reference has no radius; enter one')
    }
    radius = requirePositive(ref.radius, 'reference radius')
  }
  const C = TWO_PI * radius

  const usesHeight = mode === 'pitch_height' || mode === 'turns_height' || mode === 'angle_height'
  let heightFromRef = false
  if (def.height_from_reference) {
    if (ref.extent === undefined) {
      throw new Error('helix: height_from_reference needs a cylinder face reference')
    }
    if (usesHeight) heightFromRef = true
  }

  let pitch = num(def.pitch, NaN)
  let turns = num(def.turns, NaN)
  let height = num(def.height, NaN)
  let helixAngle = num(def.helix_angle, NaN)

  if (mode === 'pitch_turns') {
    pitch = requirePositive(pitch, 'pitch')
    turns = requirePositive(turns, 'turns')
    height = pitch * turns
    helixAngle = (Math.atan2(pitch, C) / DEG)
  } else if (mode === 'pitch_height') {
    pitch = requirePositive(pitch, 'pitch')
    height = heightFromRef ? (ref.extent as number) : height
    requirePositive(height, 'height')
    turns = height / pitch
    helixAngle = (Math.atan2(pitch, C) / DEG)
  } else if (mode === 'turns_height') {
    turns = requirePositive(turns, 'turns')
    height = heightFromRef ? (ref.extent as number) : height
    requirePositive(height, 'height')
    pitch = height / turns
    helixAngle = (Math.atan2(pitch, C) / DEG)
  } else if (mode === 'angle_turns') {
    helixAngle = requirePositive(helixAngle, 'helix angle')
    if (helixAngle >= 90) throw new Error('helix: helix angle must be below 90 degrees')
    turns = requirePositive(turns, 'turns')
    pitch = C * Math.tan(helixAngle * DEG)
    height = pitch * turns
  } else if (mode === 'angle_height') {
    helixAngle = requirePositive(helixAngle, 'helix angle')
    if (helixAngle >= 90) throw new Error('helix: helix angle must be below 90 degrees')
    pitch = C * Math.tan(helixAngle * DEG)
    height = heightFromRef ? (ref.extent as number) : height
    requirePositive(height, 'height')
    turns = height / pitch
  } else {
    throw new Error(`helix: unknown mode ${JSON.stringify(mode)}`)
  }

  const length = turns * Math.sqrt(C * C + pitch * pitch)
  return { radius, pitch, turns, height, helix_angle: helixAngle, length }
}

function rawStartAngle(def: HelixFeatureDef): number {
  return num(def.start_angle, 0)
}

/**
 * Build the resolved descriptor: pick a0/x0, fold direction into the climb axis
 * and the start end, and fold the offset into the origin. x0 comes from a0 (or
 * the reference's own x_axis), never from the climb axis, so flipping direction
 * cannot rotate the start angle.
 */
export function helixFrame(ref: HelixReference, params: HelixParams, def: HelixFeatureDef): HelixDescriptor {
  const refAxis = normalize(ref.axis)
  const climb: HelixDirection = def.direction ?? 'normal'
  const hand: HelixHand = def.hand ?? 'right'
  const sigma = climb === 'reverse' ? -1 : 1
  const axis: Vec3 = [refAxis[0] * sigma, refAxis[1] * sigma, refAxis[2] * sigma]

  let xAxis: Vec3
  if (ref.xAxis) {
    xAxis = normalize(ref.xAxis)
    // Keep x0 perpendicular to a0: a sketch x_axis is already in the circle
    // plane, but a caller could hand one that is not.
    const proj: Vec3 = [
      xAxis[0] - dot(xAxis, refAxis) * refAxis[0],
      xAxis[1] - dot(xAxis, refAxis) * refAxis[1],
      xAxis[2] - dot(xAxis, refAxis) * refAxis[2],
    ]
    if (norm(proj) > 1e-9) xAxis = normalize(proj)
  } else {
    xAxis = normalToFrame(refAxis).x_axis as Vec3
  }

  // The start end: normal climbs from the low end of the reference along a0,
  // reverse from the high end (when the reference reports an extent).
  const base: Vec3 = [...ref.origin]
  if (sigma === -1 && ref.extent !== undefined) {
    base[0] += ref.extent * refAxis[0]
    base[1] += ref.extent * refAxis[1]
    base[2] += ref.extent * refAxis[2]
  }
  const offset = num(def.offset, 0)
  const origin: Vec3 = [
    base[0] + offset * axis[0],
    base[1] + offset * axis[1],
    base[2] + offset * axis[2],
  ]

  return {
    origin,
    axis,
    refAxis,
    xAxis,
    radius: params.radius,
    pitch: params.pitch,
    turns: params.turns,
    startAngleDeg: rawStartAngle(def),
    hand,
  }
}

/** The radial angle about a0 at parameter t. Under reverse the climb axis is
 *  -a0, so the about-a0 rate carries the direction sign and the curve mirrors
 *  (chirality about a0 is unchanged). */
function radialAngle(desc: HelixDescriptor, t: number): number {
  const s = desc.hand === 'right' ? 1 : -1
  const sigma = dot(desc.axis, desc.refAxis) >= 0 ? 1 : -1
  return desc.startAngleDeg * DEG + s * sigma * t
}

function basis(desc: HelixDescriptor): { x0: Vec3; y0: Vec3 } {
  return { x0: desc.xAxis, y0: cross(desc.refAxis, desc.xAxis) }
}

/** The point on the helix at parameter t (radians of angle about a0). */
export function helixPoint(desc: HelixDescriptor, t: number): Vec3 {
  const { x0, y0 } = basis(desc)
  const theta = radialAngle(desc, t)
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const hz = desc.pitch / TWO_PI
  return [
    desc.origin[0] + hz * t * desc.axis[0] + desc.radius * (c * x0[0] + s * y0[0]),
    desc.origin[1] + hz * t * desc.axis[1] + desc.radius * (c * x0[1] + s * y0[1]),
    desc.origin[2] + hz * t * desc.axis[2] + desc.radius * (c * x0[2] + s * y0[2]),
  ]
}

/** The tangent dP/dt at parameter t (not unit). */
export function helixTangent(desc: HelixDescriptor, t: number): Vec3 {
  const { x0, y0 } = basis(desc)
  const theta = radialAngle(desc, t)
  const s = desc.hand === 'right' ? 1 : -1
  const sigma = dot(desc.axis, desc.refAxis) >= 0 ? 1 : -1
  const dtheta = s * sigma
  const c = Math.cos(theta)
  const sn = Math.sin(theta)
  const hz = desc.pitch / TWO_PI
  return [
    hz * desc.axis[0] + desc.radius * dtheta * (-sn * x0[0] + c * y0[0]),
    hz * desc.axis[1] + desc.radius * dtheta * (-sn * x0[1] + c * y0[1]),
    hz * desc.axis[2] + desc.radius * dtheta * (-sn * x0[2] + c * y0[2]),
  ]
}

/** Chirality about the reference axis: positive for a right-hand curve,
 *  negative for left, invariant of the climb direction. */
export function chirality(desc: HelixDescriptor): number {
  const p = helixPoint(desc, 0)
  const tg = helixTangent(desc, 0)
  const radial = [p[0] - desc.origin[0], p[1] - desc.origin[1], p[2] - desc.origin[2]]
  const c = cross(radial, tg)
  const d = dot(c, desc.axis)
  return d >= 0 ? 1 : -1
}

/** The end parameter (radians of angle) for a full turn count. */
export function endParam(desc: HelixDescriptor): number {
  return TWO_PI * desc.turns
}

/** Sample the helix into a polyline of `perTurn` points per turn. */
export function helixSamples(desc: HelixDescriptor, perTurn: number): Vec3[] {
  const end = endParam(desc)
  const segments = Math.max(1, Math.ceil(desc.turns * Math.max(1, perTurn)))
  const out: Vec3[] = []
  for (let i = 0; i <= segments; i++) {
    out.push(helixPoint(desc, (end * i) / segments))
  }
  return out
}

/**
 * The start point in the OCC cylinder surface's parameter space. The surface is
 * gp_Ax3(origin, a, x0): U is the angle about the climb axis a, V is axial. When
 * a = -a0 the frame's Y flips, so the in-frame start angle is the negative of
 * the about-a0 start angle.
 */
export function startUV(desc: HelixDescriptor): { u: number; v: number } {
  const sigma = dot(desc.axis, desc.refAxis) >= 0 ? 1 : -1
  return { u: sigma * desc.startAngleDeg * DEG, v: 0 }
}

/** The 2D line direction (dU, dV) in cylinder parameter space: one turn of
 *  angle per `pitch` of axial rise, handedness s. Reverse keeps the same du
 *  sign because startUV already mirrored the start. */
export function uvDirection(desc: HelixDescriptor): { du: number; dv: number } {
  const s = desc.hand === 'right' ? 1 : -1
  return { du: s * TWO_PI, dv: desc.pitch }
}
