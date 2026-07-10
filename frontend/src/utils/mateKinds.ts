// Stage 8's static knowledge about mates: what kinds exist, what each one is
// called, which numeric parameters it reads, and how a reference reads to a
// human. Pure data + pure functions, so the mate editor renders no field the
// solver would ignore and the tree can label a reference with no store in hand.
//
// The parameter table is the single source of truth for "which inputs does this
// mate show". It is bounded by the wire, not by the schema: `encodeMateInput`
// (kernel/solveAssembly.ts) writes exactly `flip`, `offset`, `ratio`, `radius`
// and `angle` per mate. `angle` is `fixed`-only: it rotates body B's seed-
// relative roll about the shared axis, a control no other mate kind reads.

import type { MateKind, MateRef } from '@/types/cad'
import { ASSEMBLY_HANDLE } from '@/utils/builtins'

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
// Fixed's seed-relative roll, alone (see mate_residuals.rs's Fixed residual).
// `sliding` does NOT read offset: an offset along a prismatic joint's axis
// would pin its only translational DOF, which is a driven joint (a motor),
// not a mate -- mates constrain, they do not command. `sliding`'s own roll is
// pinned unconditionally (seed-relative, no wire field), the same answer
// `angle` reaches for `fixed` roll: a mate holds what it was seeded with.
const MATE_PARAMS: Record<MateKind, readonly MateParam[]> = {
  fixed: ['offset', 'angle'],
  sliding: [],
  rotating: [],
  sliding_rotating: [],
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

/** `angle`'s wrap limit: `twist()` (mate_residuals.rs) extracts an angle from a
 *  quaternion, which wraps at +/-180 degrees. Widening past that must be
 *  rejected at entry, not silently wrapped -- a mate is a lock, and a wrapped
 *  value would lock the wrong roll without telling anyone. */
export const MATE_ANGLE_LIMIT_DEG = 180

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
