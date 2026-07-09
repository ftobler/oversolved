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
import {
  rotateTransformAboutPoint,
  translateTransform,
  transformTranslation,
  transformsEqual,
  type Vec3,
} from '@/utils/transform3d'

export interface ManipulationSession {
  handle: string
  /** The instance transform at pointer-down; every delta composes against it. */
  seed: Transform3D
  /** The live preview transform; written to the doc on commit. */
  current: Transform3D
}

/** A `fixed` (grounded) instance is the static reference frame: never manipulable. */
export function isManipulable(inst: PartInstance | undefined): boolean {
  return !!inst && !inst.fixed
}

/** Returns null when the handle is unknown or its instance is grounded. */
export function beginManipulation(doc: AssemblyDoc, handle: string): ManipulationSession | null {
  const inst = findInstance(doc, handle)
  if (!isManipulable(inst)) return null
  return { handle, seed: { ...inst!.transform }, current: { ...inst!.transform } }
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

export interface CommitResult {
  doc: AssemblyDoc
  /** False when the pointer never left the seed pose: no dirty flag, no re-solve. */
  changed: boolean
}

export function commitManipulation(doc: AssemblyDoc, session: ManipulationSession): CommitResult {
  if (transformsEqual(session.seed, session.current)) return { doc, changed: false }
  // A part grounded mid-drag must not land the pose it was dragged to; report
  // no change rather than a phantom re-solve.
  if (!isManipulable(findInstance(doc, session.handle))) return { doc, changed: false }
  return { doc: setInstanceTransform(doc, session.handle, session.current), changed: true }
}
