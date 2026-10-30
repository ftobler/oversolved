// Capturing a mate's orientation from the instances' current seeds: the
// headless twin of the editor's pick-time capture (utils/mateCapture.ts).
//
// The editor measures the pose the user sees on screen; headlessly the authored
// seeds ARE that pose (add_part's position/rotation, set_part_position), so the
// same helper runs against a table posed at the seeds instead of the solved
// poses. What it freezes is document data, never solver state, for exactly the
// reason the editor's capture is: see mateCapture.ts's header. A script can
// then place parts roughly, say `capture: true`, and get the flip/angle a
// hand-authored script used to find by trial solving.

import type { AssemblyDoc, MateKind, MateRef, Transform3D } from '@/types/cad'
import type { Anchor, AnchorPose } from '@/kernel/partBundle'
import { partInstances, type MateParamPatch } from '@/utils/assemblyMutations'
import { buildAnchorTable, type AnchorTable } from '@/utils/anchorGizmos'
import { captureMateOrientationPatch } from '@/utils/mateCapture'
import { mateCapturesAngle } from '@/utils/mateKinds'
import { canonicalPerp } from '@/utils/mateOrientation'
import { rotateVector, transformQuat } from '@/utils/transform3d'
import type { MateCapture } from '@/drive/scriptRunner'

/** One bundle anchor carried into the instance's authored seed pose. The
 *  canonical roll frame is derived from the LOCAL axis then rotated, the same
 *  rule solveAssembly poses the solved anchors by, so a captured angle means
 *  the same thing at a seed and at a solve. */
function posedAnchor(anchor: Anchor, t: Transform3D): AnchorPose {
  const quat = transformQuat(t)
  const local = rotateVector(quat, anchor.point)
  const axis = rotateVector(quat, anchor.axis)
  const x_axis = rotateVector(quat, canonicalPerp(anchor.axis))
  return {
    kind: anchor.kind,
    point: [local[0] + t.tx, local[1] + t.ty, local[2] + t.tz],
    axis,
    x_axis,
  }
}

/**
 * The posed anchor table a seed capture measures against: every part instance's
 * bundle anchors at that instance's seed transform, plus the assembly's own
 * frame, which never moves. `anchorsFor` returns a part's local anchors or
 * nothing when its build is unavailable; a ref into that part simply fails to
 * look up, and the capture reports nothing rather than measuring a wrong frame.
 */
export function seedAnchorTable(
  doc: AssemblyDoc,
  anchorsFor: (handle: string) => Readonly<Record<string, Anchor>> | undefined,
): AnchorTable {
  const posed: Record<string, Record<string, AnchorPose>> = {}
  for (const instance of partInstances(doc)) {
    const local = anchorsFor(instance.handle)
    if (!local) continue
    const row: Record<string, AnchorPose> = {}
    for (const [id, anchor] of Object.entries(local)) {
      row[id] = posedAnchor(anchor, instance.transform)
    }
    posed[instance.handle] = row
  }
  return buildAnchorTable(posed)
}

export interface SeedMateCaptureInput {
  kind: MateKind
  ref_a: MateRef
  ref_b: MateRef
  // The posed table: seedAnchorTable's output, or a test's hand-built one.
  anchors: AnchorTable
  // The same step's own flip/angle. Explicit values win over the capture, and
  // the report names the keys they overrode.
  explicit?: MateParamPatch
}

export interface SeedMateCapture {
  // What to write into the mate: the captured values, with the explicit ones
  // already winning. An `undefined` value deletes its key, so a captured
  // default (flip false, angle 0) writes nothing and the YAML stays clean.
  patch: MateParamPatch
  captured: MateCapture
}

/**
 * The flip/angle the seed pose implies for one mate, or null when there is
 * nothing to capture: a kind with no authored orientation (spherical,
 * tangential, copy_rotation), a half-filled ref pair, or anchors the table
 * cannot resolve. The report always carries both keys the pose implies, even
 * when the patch drops them as defaults, so an author can read what was
 * measured without diffing the document.
 */
export function captureMateAtSeeds(input: SeedMateCaptureInput): SeedMateCapture | null {
  const patch = captureMateOrientationPatch(
    { kind: input.kind },
    input.ref_a,
    input.ref_b,
    input.anchors,
  )
  if (patch === null) return null
  const readsAngle = mateCapturesAngle(input.kind)
  // `patch.angle` is undefined exactly when the roll measured as the default 0
  // (or the kind reads no roll at all, where readsAngle is false). The patch's
  // angle is typed as the wire's NumberOrExpr, but capture only ever writes a
  // plain number, which is all the report can carry.
  const captured: MateCapture = {
    flip: patch.flip === true,
    ...(readsAngle && { angle: typeof patch.angle === 'number' ? patch.angle : 0 }),
  }

  const merged: MateParamPatch = { ...patch }
  const overridden: Array<'flip' | 'angle'> = []
  if (input.explicit?.flip !== undefined) {
    merged.flip = input.explicit.flip
    if (input.explicit.flip !== captured.flip) overridden.push('flip')
  }
  if (input.explicit?.angle !== undefined) {
    merged.angle = input.explicit.angle
    if (readsAngle && input.explicit.angle !== captured.angle) overridden.push('angle')
  }

  return {
    patch: merged,
    captured: { ...captured, ...(overridden.length > 0 && { overridden }) },
  }
}
