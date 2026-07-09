// Stage 8's static knowledge about mates: what kinds exist, what each one is
// called, which numeric parameters it reads, and how a reference reads to a
// human. Pure data + pure functions, so the mate editor renders no field the
// solver would ignore and the tree can label a reference with no store in hand.
//
// The parameter table is the single source of truth for "which inputs does this
// mate show". It is bounded by the wire, not by the schema: `encodeMateInput`
// (kernel/solveAssembly.ts) writes exactly `flip`, `offset`, `ratio` and
// `radius` per mate. `MateFeatureDef.angle` is in the document schema but the
// Rust `Mate` struct has no field for it, so offering an angle box would let a
// user author a number that never reaches the solver. Left out until the wire
// format carries it.

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
export type MateParam = 'offset' | 'flip' | 'ratio' | 'radius'

// Which kind reads which parameter, per mate.rs's wire-format doc comment:
// offset serves Fixed / Sliding / ParallelPlaneDistance / Tangential; ratio is
// CopyRotation's alone; radius is Tangential's mate-side fallback.
const MATE_PARAMS: Record<MateKind, readonly MateParam[]> = {
  fixed: ['offset'],
  sliding: ['offset'],
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
