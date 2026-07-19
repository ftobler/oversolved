// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
//
// Geometry for the angle dial the triad grows while a rotation ring is being
// dragged. Everything is produced in the gizmo's own local frame, built from
// the grabbed axis's `u`/`v` companions, because the datum and swing angles the
// store publishes are measured from `u`. Deriving the dial from any other basis
// (the euler rotations TriadGizmo aims its torus meshes with, say) would put
// the drawn zero somewhere other than where the angles are counted from.
//
// Radii come from gizmoPickGeometry's ring constants, so the dial cannot drift
// away from the ring it annotates.

import { SNAP_STEP_DEG, snapTickAngles } from '@/utils/gizmoAngleSnap'
import { RING_RADIUS, RING_TUBE, type GizmoAxisDef } from '@/utils/gizmoPickGeometry'
import type { Vec3 } from '@/utils/transform3d'

const TURN = Math.PI * 2
const RAD_TO_DEG = 180 / Math.PI

/** Where the dial's rim sits: just inside the ring tube, so the two do not z-fight. */
export const DIAL_RADIUS = RING_RADIUS - RING_TUBE

/** Ticks are short radial marks hanging inward off the rim, not full spokes. */
export const DIAL_TICK_LENGTH = RING_RADIUS * 0.1
export const DIAL_MAJOR_TICK_LENGTH = RING_RADIUS * 0.2

/** The readout sits outside the ring so the fill never runs underneath it. */
export const DIAL_READOUT_RADIUS = RING_RADIUS * 1.22

/** One quarter turn's worth of ticks; every sixth tick is a major one. */
const TICKS_PER_QUARTER = 90 / SNAP_STEP_DEG

// Fine enough that a wedge edge reads as an arc rather than a chord at gizmo size.
const SWEEP_SEGMENT_RAD = TURN / 144

/** A point on the dial's plane, in gizmo-local coordinates. */
export function dialPoint(def: GizmoAxisDef, angle: number, radius: number): Vec3 {
  const c = Math.cos(angle) * radius
  const s = Math.sin(angle) * radius
  const { u, v } = def
  return [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s]
}

export interface DialTick {
  angle: number
  /** Quarter-turn ticks, drawn longer so the user can count quadrants at a glance. */
  major: boolean
  /** Inner end, toward the hub. */
  start: Vec3
  /** Outer end, on the rim. */
  end: Vec3
}

export function dialTicks(def: GizmoAxisDef): DialTick[] {
  return snapTickAngles().map((angle, i) => {
    const major = i % TICKS_PER_QUARTER === 0
    const length = major ? DIAL_MAJOR_TICK_LENGTH : DIAL_TICK_LENGTH
    return {
      angle,
      major,
      start: dialPoint(def, angle, DIAL_RADIUS - length),
      end: dialPoint(def, angle, DIAL_RADIUS),
    }
  })
}

/** The index into `dialTicks` of the tick nearest `angle`, wrapping the turn. */
export function nearestTickIndex(angle: number): number {
  const count = snapTickAngles().length
  const step = TURN / count
  return ((Math.round(angle / step) % count) + count) % count
}

/** Hub-to-rim line, used for both the datum and the live bearing. */
export function dialSpoke(def: GizmoAxisDef, angle: number): [Vec3, Vec3] {
  return [[0, 0, 0], dialPoint(def, angle, DIAL_RADIUS)]
}

/**
 * The sweep as it is DRAWN, clamped to one turn in either direction.
 *
 * The swing is unwrapped and unbounded, so a user who keeps spinning reaches
 * 400 or 900 degrees. Reducing modulo a turn for the fill would make a 370
 * degree swing draw as a thin 10 degree wedge, reading as "barely moved" at the
 * exact moment the user has done the most work; clamping instead saturates the
 * wedge into a full disc, which reads as "at least all the way round". The
 * numeric readout keeps showing the true unclamped total, so nothing is lost.
 */
export function drawnSweep(swing: number): number {
  if (swing > TURN) return TURN
  if (swing < -TURN) return -TURN
  return swing
}

/**
 * The filled wedge between datum and live as non-indexed triangles in the
 * gizmo's local frame, a fan from the hub. Wound off the signed sweep, so a
 * negative swing fans backward rather than the long way round.
 */
export function dialSweepVertices(def: GizmoAxisDef, datum: number, swing: number): Float32Array {
  const sweep = drawnSweep(swing)
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / SWEEP_SEGMENT_RAD))
  const out = new Float32Array(segments * 9)
  for (let i = 0; i < segments; i++) {
    const a = dialPoint(def, datum + (sweep * i) / segments, DIAL_RADIUS)
    const b = dialPoint(def, datum + (sweep * (i + 1)) / segments, DIAL_RADIUS)
    out.set([0, 0, 0, a[0], a[1], a[2], b[0], b[1], b[2]], i * 9)
  }
  return out
}

/** Where the readout hangs: outside the rim, halfway along the drawn sweep. */
export function dialReadoutPosition(def: GizmoAxisDef, datum: number, swing: number): Vec3 {
  return dialPoint(def, datum + drawnSweep(swing) / 2, DIAL_READOUT_RADIUS)
}

/** The true total swing in degrees, one decimal, never a signed zero. */
export function formatSwingDegrees(swing: number): string {
  const rounded = Math.round(swing * RAD_TO_DEG * 10) / 10
  return `${(rounded === 0 ? 0 : rounded).toFixed(1)}°`
}
