// Stage 7.5: what the assembly draws when the cursor rests on an entity.
//
// Anchor counts are high: a cube carries 54 across its 6 faces once its edges
// and corners are counted, so anchors are never all-rendered. Nothing is drawn
// by default; hovering an entity reveals exactly the anchors that entity offers
// as mate references, which is the same set the Stage 7 pick would cycle.
// Ctrl+hover narrows that to the one entity under the cursor, which is how a
// shared corner is disambiguated without cycling through all seven of its
// entities.
//
// Pure: no three.js, no store, no ID buffer. It maps resolver-ordered entity
// hits to positioned triads through the anchor table the solve shipped.

import type { AnchorPose } from '@/kernel/partBundle'
import type { MateRef } from '@/types/cad'
import { resolveCandidates, type EntityMateRefs } from '@/utils/anchorCandidates'
import { ASSEMBLY_BUILTIN_ANCHORS, ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import { cross, dot, normalize } from '@/utils/gizmoMath'
import type { Vec3 } from '@/utils/transform3d'

/** Part handle -> anchor id -> pose, including the assembly's own frame. */
export type AnchorTable = Record<string, Record<string, AnchorPose>>

export interface AnchorGizmo {
  /** Stable per-reference key; `${part}|${anchor}`. */
  key: string
  ref: MateRef
  point: Vec3
  /** Primary axis first, then the two derived display axes. */
  axes: [Vec3, Vec3, Vec3]
  /** The reference a mate chip would commit right now. */
  aimed: boolean
}

/**
 * The solved anchors plus the assembly's static built-in frame, under the
 * reserved handle. Folding them into one table is what lets the pick and render
 * paths stay ignorant of which side of `ASSEMBLY_HANDLE` a reference came from.
 */
export function buildAnchorTable(partAnchors: Record<string, Record<string, AnchorPose>>): AnchorTable {
  return { ...partAnchors, [ASSEMBLY_HANDLE]: ASSEMBLY_BUILTIN_ANCHORS }
}

export function lookupAnchor(table: Readonly<AnchorTable>, ref: MateRef): AnchorPose | undefined {
  return table[ref.part]?.[ref.anchor]
}

const WORLD_AXES: readonly Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

/** Copied, not shared: a caller owns the arms it is handed and may write to them. */
function worldFrame(): [Vec3, Vec3, Vec3] {
  return [[...WORLD_AXES[0]], [...WORLD_AXES[1]], [...WORLD_AXES[2]]] as [Vec3, Vec3, Vec3]
}

/**
 * A display frame around the anchor's primary axis. The two secondary axes are
 * derived from the least-aligned world axis, so the same anchor always draws
 * the same triad; they carry no meaning and never enter the solve (v1 takes
 * roll from the mate's seed frame, not from an anchor-side tangent).
 *
 * A degenerate axis (a vertex anchor's placeholder, a zeroed direction) falls
 * back to the world frame rather than emitting NaNs into the render tree.
 */
export function deriveAnchorFrame(axis: Vec3): [Vec3, Vec3, Vec3] {
  const primary = normalize(axis)
  if (!primary) return worldFrame()

  let least = WORLD_AXES[0]
  let leastDot = Infinity
  for (const w of WORLD_AXES) {
    const d = Math.abs(dot(primary, w))
    if (d < leastDot) { leastDot = d; least = w }
  }
  const second = normalize(cross(primary, least))
  if (!second) return worldFrame()
  return [primary, second, cross(primary, second)]
}

/** Ctrl+hover pins the scope to the winning entity; a plain hover clears it. */
export function hoverScopeEntity(
  hits: readonly { entityKey: string }[],
  ctrlKey: boolean,
): string | null {
  return ctrlKey ? hits[0]?.entityKey ?? null : null
}

/**
 * The triads to draw for the entities under the cursor. An empty hit list draws
 * nothing, which is the default state: anchors appear only on hover.
 *
 * A candidate whose anchor is missing from the table is dropped rather than
 * drawn at the origin. It can only come from a table and an index that
 * disagree, and a gizmo floating at (0,0,0) would invite a pick the solver
 * cannot resolve.
 */
export function resolveAnchorGizmos(
  hits: readonly { entityKey: string }[],
  entityMateRefs: Readonly<EntityMateRefs>,
  table: Readonly<AnchorTable>,
  scopeEntityKey?: string | null,
  aimedRef?: MateRef | null,
): AnchorGizmo[] {
  const out: AnchorGizmo[] = []
  for (const ref of resolveCandidates(hits, entityMateRefs, scopeEntityKey)) {
    const anchor = lookupAnchor(table, ref)
    if (!anchor) continue
    out.push({
      key: `${ref.part}|${ref.anchor}`,
      ref,
      point: [...anchor.point] as Vec3,
      axes: deriveAnchorFrame([...anchor.axis] as Vec3),
      aimed: !!aimedRef && aimedRef.part === ref.part && aimedRef.anchor === ref.anchor,
    })
  }
  return out
}
