// Stage 8's static knowledge about mates: what kinds exist, what each one is
// called, which numeric parameters it reads, and how a reference reads to a
// human. Pure data + pure functions, so the mate editor renders no field the
// solver would ignore and the tree can label a reference with no store in hand.
//
// The parameter table is the single source of truth for "which inputs does this
// mate show". It is bounded by the wire, not by the schema: `encodeMateInput`
// (kernel/solveAssembly.ts) writes exactly `flip`, `offset` (a 3D vector in
// body A's local frame), `ratio`, `radius` and `angle` per mate. `angle`
// belongs to `fixed` and `sliding`: the absolute
// roll between the two anchors' canonical frames (mate_residuals.rs
// abs_roll_residual), a control no other mate kind reads.

import type { MateKind, MateOffset, MateRef, NumberOrExpr } from '@/types/cad'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import type { Vec3 } from '@/utils/transform3d'

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

/**
 * The wire code each kind takes (MateKind::from_u8, mate.rs). A `Record<MateKind,
 * number>`, not a loose map, so a tenth kind is a compile error here even before
 * the kernel reads it. `mateKindCode` is the runtime-tolerant reader for a
 * hand-edited document string that is not a kind at all.
 */
export const MATE_KIND_TO_U8: Record<MateKind, number> = {
  fixed: 0,
  spherical: 1,
  parallel: 2,
  sliding: 3,
  rotating: 4,
  sliding_rotating: 5,
  tangential: 6,
  copy_rotation: 7,
  parallel_plane_distance: 8,
}

function isMateKind(kind: string): kind is MateKind {
  return (MATE_KINDS as readonly string[]).includes(kind)
}

/**
 * The Rust kind code for a document `kind`, or undefined when the string is not
 * a member of `MATE_KINDS`. Callers fail the mate loud on undefined rather than
 * coercing to a neighbouring kind, so a reorder between this map and
 * `MateKind::from_u8` is the only way a wrong kind can still solve.
 */
export function mateKindCode(kind: string): number | undefined {
  return isMateKind(kind) ? MATE_KIND_TO_U8[kind] : undefined
}

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

/**
 * Whether a mate kind reads an anchor's axis in its residual. Fixed, sliding,
 * rotating, sliding_rotating, parallel, parallel_plane_distance and
 * copy_rotation all weld against `mate.a.axis` / `mate.b.axis` (or the seed
 * axes) unconditionally; spherical is point-only and tangential's axis arms
 * fire only for anchor kinds that carry an axis, with every point/sphere pair
 * falling to its point-only fallback. Refusing the axis readers on an anchor
 * with no meaningful axis is what keeps a vertex-to-vertex `rotating` mate from
 * silently welding a revolute joint about an invented local +Z.
 */
export function mateReadsAxis(kind: MateKind): boolean {
  return kind === 'fixed' || kind === 'sliding' || kind === 'rotating' ||
    kind === 'sliding_rotating' || kind === 'parallel' ||
    kind === 'parallel_plane_distance' || kind === 'copy_rotation'
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * An offset component present but not a finite number: an expression string, a
 * non-finite value, or a vector with any such present component. An absent
 * component is legal and reads as the solver's own 0.
 */
function offsetUnresolved(offset: MateOffset | undefined): boolean {
  if (offset === undefined) return false
  if (typeof offset === 'number') return !Number.isFinite(offset)
  if (typeof offset === 'string') return true
  for (const v of [offset.x, offset.y, offset.z]) {
    if (v !== undefined && !isFiniteNumber(v)) return true
  }
  return false
}

/**
 * The names of a mate's authored parameters that are present but not a finite
 * number. Expression binding is not wired for mates yet, so an unbound formula
 * has no value to solve against; the solve boundary rejects the mate loud
 * rather than letting it silently read as 0.
 *
 * Walks the same parameter table the editor renders from, so a parameter the
 * wire carries but this check forgets cannot slip through. An unknown kind
 * returns `[]`: the solve's own unsupported-kind guard owns that case.
 */
export function unresolvedMateParams(mate: {
  kind: string
  offset?: MateOffset
  angle?: NumberOrExpr
  radius?: NumberOrExpr
  ratio?: NumberOrExpr
}): string[] {
  const kind = mate.kind
  if (!isMateKind(kind)) return []
  const out: string[] = []
  for (const param of mateParams(kind)) {
    if (param === 'offset') {
      if (offsetUnresolved(mate.offset)) out.push('offset')
    } else if (param === 'angle' || param === 'radius' || param === 'ratio') {
      const v = mate[param]
      if (v !== undefined && !isFiniteNumber(v)) out.push(param)
    }
  }
  return out
}

/**
 * Whether a kind reduces its offset to a single signed distance along A's anchor
 * axis (`Mate::axial_offset`, mate.rs) rather than reading the whole vector.
 *
 * Tangential's clearance and ParallelPlaneDistance's plane separation are both
 * one distance measured along that axis; the perpendicular part of an offset
 * points along DOF those mates deliberately leave free, so it has nowhere to
 * act. Offering x/y/z for them would promise two components that provably do
 * nothing, which is why the editor keeps them on a single box.
 */
export function mateOffsetIsAxial(kind: MateKind): boolean {
  return kind === 'tangential' || kind === 'parallel_plane_distance'
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

/**
 * A mate's `offset` in the one form the wire takes: a 3D vector in body A's
 * LOCAL frame (mate.rs `Mate::offset`).
 *
 * This is the tolerant read for both authoring forms, and the only place that
 * knows about the older one. A bare number is the original scalar offset, a
 * signed distance along A's anchor axis, so it expands to `offset * axisA` --
 * which the solver rotates back to `offset * a_w`, exactly what the scalar
 * residual used to subtract. Assembly documents are user YAML stored verbatim
 * with no content migration anywhere in the stack, so that equivalence is the
 * back-compat guarantee, not a convenience.
 *
 * An expression string or non-finite component still yields 0 here for display
 * and back-compat, but the solve only reaches this after
 * `unresolvedMateParams` has refused such a mate, so the zero branch is now only
 * the legitimate absent-component case.
 */
export function mateOffsetVector(offset: MateOffset | undefined, axisA: Vec3): Vec3 {
  if (typeof offset === 'number') {
    const s = component(offset)
    return [s * axisA[0], s * axisA[1], s * axisA[2]]
  }
  if (offset && typeof offset === 'object') {
    return [component(offset.x), component(offset.y), component(offset.z)]
  }
  return [0, 0, 0]
}

/** One authored offset component: a finite number, or 0 for anything else. */
function component(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
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
