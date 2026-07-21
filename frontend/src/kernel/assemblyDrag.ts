// The drag objective for interactive part manipulation, viewport-free.
//
// Dragging a part in real CAD is rigid, not a ragdoll: the grabbed part follows
// the constraints, never stretching toward a cursor its mates cannot reach. So a
// drag is not "pin the part where the pointer is" -- it is "ask the solver to
// bring the grabbed POINT under the cursor, subject to every mate", and then draw
// whatever pose the solver returns.
//
// This module builds that objective and runs the solve. It owns three pieces the
// viewport only feeds pointer data into:
//   - capture:   the model-space point under the cursor at drag start
//                (captureGrabPoint), so the objective is stable as the part moves
//   - objective: a synthetic soft mate that pulls the grab point to the cursor
//                (dragTargetMate) -- a Spherical (point coincidence) mate, whose
//                rotation damping makes a FREE body translate to reach the target
//                and only a rotation-constrained one turn (the crank/piston split)
//   - solve:     solveDragPose, which appends the objective and runs solveAssembly
//
// Nothing three.js or React reaches here; everything is plain vectors and specs.

import type { Transform3D } from '../types/cad'
import type { Anchor } from './partBundle'
import type { MateSpec } from './solveAssembly'
import { solveAssembly, type AssemblyBuildResponse } from './solveAssembly'
import type { RelayService } from './worker/anchorSolverWorker'
import { ASSEMBLY_HANDLE } from '../utils/assemblyBuiltins'
import { invertTransform, rotateVector, type Vec3 } from '../utils/transform3d'

/** The synthetic drag mate's feature id, reserved so nothing authored collides. */
export const DRAG_MATE_ID = '__drag_target__'

/** The grab point and where the pointer is dragging it, both in world space at
 *  capture, but `localGrab` is the SAME point expressed in the part's own frame
 *  so it rides the part through the solve. */
export interface DragObjective {
  handle: string
  /** The grabbed point in the part's local frame (captureGrabPoint output). */
  localGrab: Vec3
  /** The world point the grab point is being pulled to (the live cursor). */
  target: Vec3
}

/** Apply a rigid transform to a point: rotate, then translate. */
function applyToPoint(t: Transform3D, p: Vec3): Vec3 {
  const r = rotateVector([t.qx, t.qy, t.qz, t.qw], p)
  return [r[0] + t.tx, r[1] + t.ty, r[2] + t.tz]
}

/**
 * The model-space point a world grab lands on, given the part's world pose at
 * drag start. Captured once so the objective stays fixed to the part: a grab on
 * the rim keeps pulling the rim however the part later turns, which is what makes
 * dragging a wheel's edge a crank turn rather than a shove at the hub.
 */
export function captureGrabPoint(worldGrab: Vec3, partWorld: Transform3D): Vec3 {
  return applyToPoint(invertTransform(partWorld), worldGrab)
}

function pointAnchor(point: Vec3): Anchor {
  // axis is unused by a Spherical mate (point coincidence only); a unit +Z keeps
  // the anchor well-formed for the wire encoder, which reads an axis regardless.
  return { kind: 'point', point, axis: [0, 0, 1], geom_hash: '', created_by: DRAG_MATE_ID }
}

/**
 * The soft objective that drives a drag: a Spherical (point coincidence) mate
 * between the grabbed part's grab point and a world point at the cursor. The
 * cursor point rides the assembly's own frame (pinned at identity), so it is a
 * fixed world target the grab point is pulled onto.
 *
 * Spherical is deliberate over a positional pin on the whole part. It constrains
 * a single point, so translation-priority falls out of the solver's rotation
 * damping: a free body reaches the target by sliding (little rotation), while a
 * body whose translation is spent (revolute/pinned) can only turn to close the
 * gap, which reads as the drag applying a moment.
 */
export function dragTargetMate(drag: DragObjective): MateSpec {
  return {
    id: DRAG_MATE_ID,
    kind: 'spherical',
    ref_a: { part: drag.handle, anchor: DRAG_MATE_ID, inlineAnchor: pointAnchor(drag.localGrab) },
    ref_b: { part: ASSEMBLY_HANDLE, anchor: DRAG_MATE_ID, inlineAnchor: pointAnchor(drag.target) },
  }
}

/**
 * Solve the assembly with the drag objective appended. The grabbed part is NOT
 * pinned: it solves like any other body, so the returned transform for it is the
 * constraint-respecting pose, never the raw cursor. When the cursor is out of
 * reach the real mates outvote the soft drag mate and the part settles at the
 * nearest reachable pose rather than detaching toward the pointer.
 */
export function solveDragPose(
  parts: Parameters<typeof solveAssembly>[0],
  revs: Record<string, number>,
  mates: MateSpec[],
  drag: DragObjective,
  relay: RelayService,
  solveMateFn: ((input: Uint8Array) => Uint8Array) | null,
): Promise<AssemblyBuildResponse> {
  return solveAssembly(parts, revs, [...mates, dragTargetMate(drag)], relay, solveMateFn)
}
