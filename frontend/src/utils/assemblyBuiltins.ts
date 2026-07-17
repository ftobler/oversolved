// Assembly-only builtins: the assembly's own coordinate frame (separate from
// each part's) and that frame as matable geometry. Lives outside builtins.ts
// so the part editor's builtins module keeps no import from kernel/partBundle
// -- assembly-owned code depends on the part editor's kernel, never the
// reverse (feature/multi-part-assembly-postfix.md Stage G).

import type { AssemblyFeature } from '@/types/cad'
import type { AnchorPose } from '@/kernel/partBundle'
import { canonicalPerp } from '@/utils/mateOrientation'

// The assembly's OWN coordinate frame: an Origin + 3 cardinal planes, separate
// from each part's built-ins. Assembly-scoped ids keep an empty AssemblyDoc from
// silently inheriting part built-ins (see useAssemblyDoc / useDocumentState
// empty-features scoping). These ids double as the assembly-builtin anchor ids a
// mate references (assemblyAnchors in kernel/solveAssembly.ts).
export const ASSEMBLY_ORIGIN_ID = 'AssemblyOrigin'
export const ASSEMBLY_TOP_ID = 'AssemblyTop'
export const ASSEMBLY_FRONT_ID = 'AssemblyFront'
export const ASSEMBLY_RIGHT_ID = 'AssemblyRight'

export const ASSEMBLY_BUILTIN_DEFAULTS: AssemblyFeature[] = [
  { id: ASSEMBLY_ORIGIN_ID, kind: 'origin' },
  { id: ASSEMBLY_TOP_ID,    kind: 'plane' },
  { id: ASSEMBLY_FRONT_ID,  kind: 'plane' },
  { id: ASSEMBLY_RIGHT_ID,  kind: 'plane' },
]

export const ASSEMBLY_BUILTIN_IDS = new Set(ASSEMBLY_BUILTIN_DEFAULTS.map(f => f.id))

/**
 * The assembly frame as matable geometry, pinned at the world origin. Normals
 * follow the part editor's convention (Viewport/index.tsx): Front faces +Z, Top
 * faces +Y, Right faces +X. One source of truth: the solver reads these to
 * resolve a `__assembly` mate ref, and the viewport reads them to draw the same
 * anchors' gizmos. If the two ever disagreed, a user would pick one plane and
 * mate to another.
 */
// x_axis (the roll-capture frame, see AnchorPose) is derived rather than
// hand-written: the frame is pinned at identity, so world == local and
// canonicalPerp of the axis IS the posed frame. One rule, shared with the
// per-part anchors solveAssembly poses.
export const ASSEMBLY_BUILTIN_ANCHORS: Record<string, AnchorPose> = {
  [ASSEMBLY_ORIGIN_ID]: { kind: 'point', point: [0, 0, 0], axis: [0, 0, 1], x_axis: canonicalPerp([0, 0, 1]) },
  [ASSEMBLY_TOP_ID]:    { kind: 'plane', point: [0, 0, 0], axis: [0, 1, 0], x_axis: canonicalPerp([0, 1, 0]) },
  [ASSEMBLY_FRONT_ID]:  { kind: 'plane', point: [0, 0, 0], axis: [0, 0, 1], x_axis: canonicalPerp([0, 0, 1]) },
  [ASSEMBLY_RIGHT_ID]:  { kind: 'plane', point: [0, 0, 0], axis: [1, 0, 0], x_axis: canonicalPerp([1, 0, 0]) },
}

// Reserved part handle addressing the assembly's own frame in a MateRef. A real
// PartInstance handle is randomId(8) (see assemblyMutations), which never yields
// this literal, so the reserved handle cannot collide with a generated instance.
export const ASSEMBLY_HANDLE = '__assembly'
