// Viewport-free part manipulation for the assembly editor (Stage 6d).
//
// Both manipulation paths (a mouse drag on a part's body, and the select +
// triad gizmo) run through the same session: begin on pointer-down, feed a
// delta measured from the drag start on every move, commit the composed seed
// transform on pointer-up. Deltas are absolute (measured against the seed, not
// the previous frame) so a dropped or replayed pointermove cannot accumulate
// drift.
//
// The mate solve does NOT re-run per frame (see "Out of scope" in the plan);
// `commitManipulation` is what the editor follows with a single re-solve.

import type { AssemblyDoc, PartInstance, Transform3D } from '@/types/cad'
import { findInstance, setInstanceTransform } from '@/utils/assemblyMutations'
import { captureGrabPoint, type DragObjective } from '@/kernel/assemblyDrag'
import {
  composeTransforms,
  IDENTITY_TRANSFORM,
  relativeTransform,
  rotateTransformAboutPoint,
  translateTransform,
  transformTranslation,
  transformsEqual,
  type Vec3,
} from '@/utils/transform3d'

export interface ManipulationSession {
  handle: string
  // The instance transform at pointer-down; every delta composes against it.
  seed: Transform3D
  // The live preview transform; written to the doc on commit.
  current: Transform3D
  /**
   * Set for a body grab: the grab point (part-local) and the world point the
   * pointer is pulling it to. A grab drag is solver-driven -- the solver brings
   * the grab point to the target subject to the mates, and `current` is then set
   * from the SOLVED pose (setDragSolvedPose), never from the raw cursor. Absent
   * for a triad gizmo drag, which drives `current` geometrically instead.
   */
  dragObjective?: DragObjective
}

/** An instance carrying the `fixed` flag (the per-instance flag, not the fixed
 *  mate) is the assembly's static reference frame: never manipulable. */
export function isManipulable(inst: PartInstance | undefined): boolean {
  return !!inst && !inst.fixed
}

/** Returns null when the handle is unknown or its instance is fixed. */
export function beginManipulation(doc: AssemblyDoc, handle: string): ManipulationSession | null {
  const inst = findInstance(doc, handle)
  if (!isManipulable(inst)) return null
  return { handle, seed: { ...inst!.transform }, current: { ...inst!.transform } }
}

/**
 * Begin a body grab: a manipulation carrying a drag objective. `drawnWorld` is
 * the part's current on-screen pose (its solved pose plus any settling offset),
 * which is what the grab point must be captured against -- a mate can have pulled
 * the part off its doc seed, and the grab landed on where the part is DRAWN.
 */
export function beginBodyManipulation(
  doc: AssemblyDoc,
  handle: string,
  worldGrab: Vec3,
  drawnWorld: Transform3D,
): ManipulationSession | null {
  const session = beginManipulation(doc, handle)
  if (!session) return null
  return {
    ...session,
    dragObjective: { handle, localGrab: captureGrabPoint(worldGrab, drawnWorld), target: worldGrab },
  }
}

/** Move where the grab point is being pulled to; the next solve reads this. */
export function setDragTarget(session: ManipulationSession, target: Vec3): ManipulationSession {
  if (!session.dragObjective) return session
  return { ...session, dragObjective: { ...session.dragObjective, target } }
}

/**
 * Fold the grab's SOLVED pose into the session so the drawn part and the eventual
 * commit both track the solver, not the cursor. `solvedGrab` is the grabbed
 * part's pose from the drag solve, `drawnBaked` the pose its bodies are still
 * baked at (the drag drops it from the re-baked set). The render offset carries
 * the baked mesh onto the solved pose, so `current` is set to reproduce exactly
 * that through `manipulationDelta`.
 */
export function setDragSolvedPose(
  session: ManipulationSession,
  solvedGrab: Transform3D,
  drawnBaked: Transform3D,
): ManipulationSession {
  const delta = relativeTransform(solvedGrab, drawnBaked)
  return { ...session, current: composeTransforms(delta, session.seed) }
}

/** `delta` is the world-space translation since pointer-down. */
export function dragTranslate(session: ManipulationSession, delta: Vec3): ManipulationSession {
  return { ...session, current: translateTransform(session.seed, delta) }
}

/**
 * `angle` is the total rotation since pointer-down about the world-space `axis`.
 * Without a pivot the part spins about its own origin, which is what the triad
 * gizmo does when it sits on the part.
 */
export function gizmoRotate(
  session: ManipulationSession,
  axis: Vec3,
  angle: number,
  pivot?: Vec3,
): ManipulationSession {
  const p = pivot ?? transformTranslation(session.seed)
  return { ...session, current: rotateTransformAboutPoint(session.seed, axis, angle, p) }
}

/**
 * How far the pointer has carried the part since pointer-down: `current ∘ seed⁻¹`.
 * The viewport applies it as a group offset over vertices already baked at the
 * solved pose, which is why it is a delta rather than an absolute transform.
 */
export function manipulationDelta(session: ManipulationSession): Transform3D {
  return relativeTransform(session.current, session.seed)
}

/**
 * Where the grabbed part actually sits on screen: the drag delta carried onto
 * the pose the last solve left it at.
 *
 * The seed is the DOC transform, and a mate can have pulled the part off it, so
 * `session.current` (delta over the seed) is NOT the drawn pose. Committing
 * `current` used to teleport the part by exactly (solved - seed) on release.
 * The render offset, the live solve pin and the commit all read this, so they
 * cannot drift apart again. `solved` falls back to the seed for a part no solve
 * has posed yet.
 */
export function livePartPose(
  session: ManipulationSession,
  solved: Transform3D | undefined,
): Transform3D {
  return composeTransforms(manipulationDelta(session), solved ?? session.seed)
}

/**
 * Where the parts are drawn right now: the baked (last solved) transforms
 * carried by whatever settling offset a committed drag left behind.
 *
 * A drag commit lands in the doc long before the solve that re-meshes the part
 * at its new pose, and until then the bodies are still baked at the old one.
 * Everything that asks "where is this part" between the two -- the next grab's
 * pin, the commit that follows it -- must read this rather than `transforms`,
 * or it composes against a pose the screen abandoned.
 */
export function settledTransforms(
  transforms: Record<string, Transform3D>,
  settling: Record<string, Transform3D>,
): Record<string, Transform3D> {
  const out: Record<string, Transform3D> = { ...transforms }
  for (const [handle, offset] of Object.entries(settling)) {
    out[handle] = composeTransforms(offset, transforms[handle] ?? IDENTITY_TRANSFORM)
  }
  return out
}

/**
 * The rigid delta from the baked pose to the drawn pose for one handle. For the
 * part being manipulated that is the live drag delta composed over any offset
 * still owed; for every other part it is the settling offset. Identity at rest.
 *
 * The render group and the ID pick buffer both read this, so they cannot
 * describe the parts at different poses.
 */
export function poseOffsetFor(
  handle: string,
  manipulation: ManipulationSession | null,
  settling: Record<string, Transform3D>,
): Transform3D {
  const owed = settling[handle] ?? IDENTITY_TRANSFORM
  return manipulation?.handle === handle
    ? composeTransforms(manipulationDelta(manipulation), owed)
    : owed
}

/**
 * The drawn pose of one handle: the pose its bodies are baked at (`transforms`)
 * carried by the live drag delta if it is the one being dragged, or by any
 * settling offset a committed drag still owes. The render list and the ID buffer
 * both build from this, so they cannot describe different layouts.
 */
export function drawnPose(
  handle: string,
  manipulation: ManipulationSession | null,
  transforms: Record<string, Transform3D>,
  settling: Record<string, Transform3D>,
): Transform3D {
  const baked = transforms[handle] ?? IDENTITY_TRANSFORM
  return composeTransforms(poseOffsetFor(handle, manipulation, settling), baked)
}

export interface CommitResult {
  doc: AssemblyDoc
  // False when the pointer never left the seed pose: no dirty flag, no re-solve.
  changed: boolean
}

/** `solved` is the grabbed part's pose from the last solve; see [[livePartPose]]. */
export function commitManipulation(
  doc: AssemblyDoc,
  session: ManipulationSession,
  solved?: Transform3D,
): CommitResult {
  if (transformsEqual(session.seed, session.current)) return { doc, changed: false }
  // A part fixed mid-drag must not land the pose it was dragged to; report
  // no change rather than a phantom re-solve.
  if (!isManipulable(findInstance(doc, session.handle))) return { doc, changed: false }
  return {
    doc: setInstanceTransform(doc, session.handle, livePartPose(session, solved)),
    changed: true,
  }
}
