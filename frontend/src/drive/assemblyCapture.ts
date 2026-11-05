// Capturing a mate's pose from the instances' current seeds: the headless twin
// of the editor's pick-time capture (utils/mateCapture.ts).
//
// The editor measures the pose the user sees on screen; headlessly the authored
// seeds ARE that pose (add_part's position/rotation, set_part_position), so the
// same helper runs against a table posed at the seeds instead of the solved
// poses. What it freezes is document data, never solver state, for exactly the
// reason the editor's capture is: see mateCapture.ts's header. A script can
// then place parts roughly, say `capture: true`, and get the flip/angle (and a
// fixed mate's whole translation) a hand-authored script used to find by trial
// solving.

import type { AssemblyDoc, MateKind, MateRef, NumberOrExpr, Transform3D } from '@/types/cad'
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
export function posedAnchor(anchor: Anchor, t: Transform3D): AnchorPose {
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
 * The posed anchors a seed capture measures against, plus the seed pose each
 * part's row was posed with. The anchors are every part instance's bundle
 * anchors at that instance's seed transform, plus the assembly's own frame,
 * which never moves. `anchorsFor` returns a part's local anchors or nothing when
 * its build is unavailable; a ref into that part simply fails to look up, and
 * the capture reports nothing rather than measuring a wrong frame.
 *
 * The seed poses ride along because a fixed mate's captured translation has to
 * be carried into A's own frame: an anchor row alone does not know its part's
 * roll (`utils/mateCapture.ts` `fixedCapturedOffset`).
 */
export interface SeedAnchorTable {
  anchors: AnchorTable
  seeds: Record<string, Transform3D>
}

export function seedAnchorTable(
  doc: AssemblyDoc,
  anchorsFor: (handle: string) => Readonly<Record<string, Anchor>> | undefined,
): SeedAnchorTable {
  const posed: Record<string, Record<string, AnchorPose>> = {}
  const seeds: Record<string, Transform3D> = {}
  for (const instance of partInstances(doc)) {
    const local = anchorsFor(instance.handle)
    if (!local) continue
    const row: Record<string, AnchorPose> = {}
    for (const [id, anchor] of Object.entries(local)) {
      row[id] = posedAnchor(anchor, instance.transform)
    }
    posed[instance.handle] = row
    seeds[instance.handle] = instance.transform
  }
  return { anchors: buildAnchorTable(posed), seeds }
}

export interface SeedMateCaptureInput {
  kind: MateKind
  ref_a: MateRef
  ref_b: MateRef
  // The posed table: seedAnchorTable's output, or a test's hand-built one.
  anchors: AnchorTable
  // The seed pose per part handle, from seedAnchorTable. Omitted by a hand-built
  // test table, and then a fixed mate captures no translation rather than
  // guessing the frame it would have to be carried into.
  seeds?: Readonly<Record<string, Transform3D>>
  // The same step's own params. Explicit values win over the capture, and the
  // report names the keys they overrode.
  explicit?: MateParamPatch
}

export interface SeedMateCapture {
  // What to write into the mate: the captured values, with the explicit ones
  // already winning. An `undefined` value deletes its key, so a captured
  // default (flip false, angle 0, a zero offset) writes nothing and the YAML
  // stays clean.
  patch: MateParamPatch
  captured: MateCapture
}

/** The captured offset as the reply reports it, or undefined for the default. */
function capturedOffset(patch: MateParamPatch): [number, number, number] | undefined {
  const offset = patch.offset
  if (offset === undefined || typeof offset !== 'object') return undefined
  const num = (v: NumberOrExpr | undefined) => typeof v === 'number' && Number.isFinite(v) ? v : 0
  return [num(offset.x), num(offset.y), num(offset.z)]
}

/** Whether an authored offset is the absent/default zero. */
function isZeroOffset(offset: MateParamPatch['offset']): boolean {
  if (offset === undefined) return true
  if (typeof offset === 'number') return offset === 0
  if (typeof offset === 'string') return false
  const zero = (v: NumberOrExpr | undefined) => v === undefined || v === 0
  return zero(offset.x) && zero(offset.y) && zero(offset.z)
}

/** Whether an authored offset already names the captured one, so it beat
 *  nothing and the report must not claim it did. */
function sameOffset(a: MateParamPatch['offset'], b: MateParamPatch['offset']): boolean {
  if (isZeroOffset(a) && isZeroOffset(b)) return true
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const num = (v: NumberOrExpr | undefined) => typeof v === 'number' && Number.isFinite(v) ? v : 0
  const near = (p: number, q: number) => Math.abs(p - q) <= 1e-9
  return near(num(a.x), num(b.x)) && near(num(a.y), num(b.y)) && near(num(a.z), num(b.z))
}

/**
 * The flip/angle a seed pose implies for one mate, plus (for a fixed mate) the
 * seed translation as its offset in A's own frame, or null when there is
 * nothing to capture: a kind with no authored orientation (spherical,
 * tangential, copy_rotation), a half-filled ref pair, or anchors the table
 * cannot resolve. The report always carries the keys the pose implies, even
 * when the patch drops them as defaults, so an author can read what was
 * measured without diffing the document.
 */
export function captureMateAtSeeds(input: SeedMateCaptureInput): SeedMateCapture | null {
  const patch = captureMateOrientationPatch(
    { kind: input.kind },
    input.ref_a,
    input.ref_b,
    input.anchors,
    undefined,
    input.seeds,
  )
  if (patch === null) return null
  const readsAngle = mateCapturesAngle(input.kind)
  // `patch.angle` is undefined exactly when the roll measured as the default 0
  // (or the kind reads no roll at all, where readsAngle is false). The patch's
  // angle is typed as the wire's NumberOrExpr, but capture only ever writes a
  // plain number, which is all the report can carry.
  const offset = capturedOffset(patch)
  const captured: MateCapture = {
    flip: patch.flip === true,
    ...(readsAngle && { angle: typeof patch.angle === 'number' ? patch.angle : 0 }),
    ...(offset !== undefined && { offset }),
  }

  const merged: MateParamPatch = { ...patch }
  const overridden: Array<'flip' | 'angle' | 'offset'> = []
  if (input.explicit?.flip !== undefined) {
    merged.flip = input.explicit.flip
    if (input.explicit.flip !== captured.flip) overridden.push('flip')
  }
  if (input.explicit?.angle !== undefined) {
    merged.angle = input.explicit.angle
    if (readsAngle && input.explicit.angle !== captured.angle) overridden.push('angle')
  }
  // Only a fixed mate captures a translation, so an explicit offset on any
  // other kind never met a captured value to beat.
  if (input.explicit?.offset !== undefined && input.kind === 'fixed') {
    merged.offset = input.explicit.offset
    if (!sameOffset(input.explicit.offset, patch.offset)) overridden.push('offset')
  }

  return {
    patch: merged,
    captured: { ...captured, ...(overridden.length > 0 && { overridden }) },
  }
}
