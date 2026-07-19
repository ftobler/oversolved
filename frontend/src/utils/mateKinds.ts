// Stage 8's static knowledge about mates: what kinds exist, what each one is
// called, which numeric parameters it reads, and how a reference reads to a
// human. Pure data + pure functions, so the mate editor renders no field the
// solver would ignore and the tree can label a reference with no store in hand.
//
// The parameter table is the single source of truth for "which inputs does this
// mate show". It is bounded by the wire, not by the schema: `encodeMateInput`
// (kernel/solveAssembly.ts) writes exactly `flip`, `offset`, `ratio`, `radius`
// and `angle` per mate. `angle` belongs to `fixed` and `sliding`: the absolute
// roll between the two anchors' canonical frames (mate_residuals.rs
// abs_roll_residual), a control no other mate kind reads.

import type { MateKind, MateRef } from '@/types/cad'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'

/** Insert order in the UI: the workhorse first, the rare joints after. */
export const MATE_KINDS: readonly MateKind[] = [
  'fixed',
  'sliding',
  'rotating',
  'sliding_rotating',
  'spherical',
  'parallel',
  'parallel_plane_distance',
  'tangential',
  'copy_rotation',
]

export const MATE_KIND_LABELS: Record<MateKind, string> = {
  fixed: 'Fixed',
  sliding: 'Sliding',
  rotating: 'Rotating',
  sliding_rotating: 'Sliding + Rotating',
  spherical: 'Spherical',
  parallel: 'Parallel',
  parallel_plane_distance: 'Parallel at distance',
  tangential: 'Tangential',
  copy_rotation: 'Copy rotation',
}

/** The scalar/boolean parameters a mate kind actually consumes in the solve. */
export type MateParam = 'offset' | 'flip' | 'ratio' | 'radius' | 'angle'

// Which kind reads which parameter, per mate_residuals.rs's residual formulas:
// offset serves Fixed / ParallelPlaneDistance / Tangential; ratio is
// CopyRotation's alone; radius is Tangential's mate-side fallback; angle is
// Fixed's and Sliding's absolute roll target. Every axis mate reads `flip`
// (which side its signed axis-difference residual welds); the editor captures
// flip -- and angle, where read -- from the on-screen pose when both refs are
// picked (utils/mateCapture.ts), so a mate holds what it was authored at as
// document data, never as solver seed memory.
// `sliding` does NOT read offset: an offset along a prismatic joint's axis
// would pin its only translational DOF, which is a driven joint (a motor),
// not a mate -- mates constrain, they do not command.
const MATE_PARAMS: Record<MateKind, readonly MateParam[]> = {
  fixed: ['offset', 'flip', 'angle'],
  sliding: ['flip', 'angle'],
  rotating: ['flip'],
  sliding_rotating: ['flip'],
  spherical: [],
  parallel: ['flip'],
  parallel_plane_distance: ['offset', 'flip'],
  tangential: ['offset', 'radius'],
  copy_rotation: ['ratio'],
}

export function mateParams(kind: MateKind): readonly MateParam[] {
  return MATE_PARAMS[kind] ?? []
}

export const MATE_PARAM_LABELS: Record<MateParam, string> = {
  offset: 'Offset',
  flip: 'Flip',
  ratio: 'Ratio',
  radius: 'Radius',
  angle: 'Angle',
}

/**
 * `angle` in its authoring form: degrees in [0, 360). Wrapping is lossless, not
 * a silent corruption -- `abs_roll_residual` (mate_residuals.rs) ends in
 * `wrap_to_pi(atan2(sin_r, cos_r) - target)`, so a target and that target plus a
 * full turn produce the identical residual. 270 and -90 name the same physical
 * roll, and the solver cannot tell them apart. An earlier revision rejected
 * anything past +/-180 on the theory that a wrapped value would lock the wrong
 * roll; it locks the same roll, and the rejection only blocked legal poses (at
 * 180, `+90` could do nothing but raise an error). Do not reinstate a range
 * guard here.
 *
 * A non-finite input yields 0 so a half-typed box can never author NaN.
 */
export function normalizeMateAngleDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  // The modulo alone leaves -0 for a negative whole turn, and its sign would
  // survive into the YAML; the addition folds that back onto plain 0.
  return ((deg % 360) + 360) % 360
}

/** A slot no pick has filled yet. Both halves empty; never a partial. */
export const EMPTY_MATE_REF: MateRef = { part: '', anchor: '' }

export function isMateRefEmpty(ref: MateRef | undefined): boolean {
  return !ref || ref.part === '' || ref.anchor === ''
}

/**
 * How a reference reads in a chip or a tree row. `labelFor` names a part handle
 * (its document name, say); the reserved assembly handle names the assembly's
 * own frame, which belongs to no part and so can never be looked up there.
 */
export function mateRefLabel(
  ref: MateRef | undefined,
  labelFor?: (handle: string) => string | undefined,
): string {
  if (isMateRefEmpty(ref)) return 'Pick a reference'
  const { part, anchor } = ref!
  const owner = part === ASSEMBLY_HANDLE ? 'Assembly' : labelFor?.(part) || part
  return `${owner} / ${anchor}`
}

/** The one-line summary a tree row shows for a mate. */
export function mateSummary(
  kind: MateKind,
  ref_a: MateRef,
  ref_b: MateRef,
  labelFor?: (handle: string) => string | undefined,
): string {
  return `${MATE_KIND_LABELS[kind] ?? kind}: ${mateRefLabel(ref_a, labelFor)} to ${mateRefLabel(ref_b, labelFor)}`
}
